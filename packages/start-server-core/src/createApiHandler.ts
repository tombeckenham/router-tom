import { createServerHistory } from '@tanstack/history'
import {
  findRouteMatch,
  isRedirect,
  processRouteTree,
} from '@tanstack/router-core'
import {
  createCsrfMiddleware,
  createNullProtoObject,
  flattenMiddlewares,
} from '@tanstack/start-client-core'
import {
  bindSsrResponseToRequest,
  normalizeSsrResponse,
  stripSsrResponseBody,
} from '@tanstack/router-core/ssr/server'
import { runWithStartContext } from '@tanstack/start-storage-context'
import {
  executeMiddleware,
  handleRedirectResponse,
  throwIfMayNotDefer,
  withParsedParams,
} from './createStartHandler'
import {
  reconcileResponse,
  transferResponseMetadata,
  withStartRequest,
} from './internal-request-response'
import {
  createServerFnErrorResponse,
  handleServerAction,
} from './server-functions-handler'
import type { StartEvent } from './internal-request-response'
import type { AnyRoute, AnyRouter } from '@tanstack/router-core'
import type {
  AnyRequestMiddleware,
  AnyStartInstanceOptions,
  RouteMethod,
} from '@tanstack/start-client-core'
import type { RequestHandler } from './request-handler'

const SERVER_FN_BASE = process.env.TSS_SERVER_FN_BASE

const defaultCsrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === 'serverFn',
})

const ROUTER_BASEPATH =
  (process.env.TSS_ROUTER_BASEPATH || '/').replace(/\/+$/, '') || '/'

/**
 * Builds a Router only when something asks for one (`redirect({ to })`,
 * `getRouter()`), so the hot path never pays for it.
 */
function createLazyRouterGetter(request: Request): () => Promise<AnyRouter> {
  let routerPromise: Promise<AnyRouter> | undefined
  return () =>
    (routerPromise ??= (async () => {
      // @ts-ignore the declaration build does not see start-client-core's start-entry.d.ts
      const { getRouter } = await import('#tanstack-router-entry')
      const router = await getRouter()
      const url = new URL(request.url)
      router.update({
        history: createServerHistory(url.pathname + url.search + url.hash),
        origin: router.options.origin ?? url.origin,
        basepath: ROUTER_BASEPATH,
      })
      return router
    })())
}

// Mirrors executeMiddleware's own parameter types, so this tightens when they do.
type Chain = {
  middlewares: Parameters<typeof executeMiddleware>[0]
  handler: Parameters<typeof executeMiddleware>[1]
}

type Fallback = (request: Request, opts: any) => Promise<Response> | Response

/**
 * Experimental: dispatch server-only routes without creating a Router.
 * Everything else (pages, server functions) goes to `fallback`, which should
 * lazily import the full Start handler so API requests never load it.
 */
export function createApiHandler<TRegister = unknown>(opts: {
  fallback: RequestHandler<TRegister>
  /** Defaults to the build's `virtual:tanstack-start-api-route-tree`. */
  routeTree?: AnyRoute
  /** Defaults to the app's `createStart` options; `requestMiddleware` runs before route middleware. */
  startOptions?: AnyStartInstanceOptions
}): RequestHandler<TRegister> {
  type Dispatch = ReturnType<typeof createDispatcher>
  let dispatch: Dispatch | undefined
  let pending: Promise<Dispatch> | undefined
  // Entries load on the first request, like createStartHandler.
  const ready = () =>
    (pending ??= (async () => {
      const routeTree =
        opts.routeTree ??
        (await import('virtual:tanstack-start-api-route-tree')).apiRouteTree
      let startOptions = opts.startOptions
      if (!startOptions) {
        // @ts-ignore the declaration build does not see start-client-core's start-entry.d.ts
        const { startInstance } = await import('#tanstack-start-entry')
        startOptions = await startInstance?.getOptions()
      }
      return (dispatch = createDispatcher(
        routeTree,
        startOptions,
        opts.fallback as Fallback,
      ))
    })())

  return withStartRequest((request, requestOpts, event) =>
    dispatch
      ? dispatch(request, requestOpts, event)
      : ready().then((d) => d(request, requestOpts, event)),
  ) as RequestHandler<TRegister>
}

function createDispatcher(
  routeTree: AnyRoute,
  resolvedStartOptions: AnyStartInstanceOptions | undefined,
  fallback: Fallback,
) {
  const { processedTree } = processRouteTree(routeTree)
  const startOptions = resolvedStartOptions ?? ({} as AnyStartInstanceOptions)
  // Without a Start instance the CSRF middleware is on by default, as in createStartHandler.
  const requestMiddlewares: Array<AnyRequestMiddleware> = resolvedStartOptions
    ? (startOptions.requestMiddleware ?? [])
    : [defaultCsrfMiddleware]
  const flattenedRequestMiddlewares = flattenMiddlewares(requestMiddlewares)
  const executedRequestMiddlewares = new Set(flattenedRequestMiddlewares)
  const globalMiddlewares = flattenedRequestMiddlewares.map(
    (m) => m.options.server as any,
  )
  // Per route and method, composed once at startup.
  const chains = new WeakMap<AnyRoute, Partial<Record<RouteMethod, Chain>>>()

  function getChain(
    route: AnyRoute,
    branch: ReadonlyArray<AnyRoute>,
    method: RouteMethod,
  ): Chain | undefined {
    let byMethod = chains.get(route)
    if (!byMethod) {
      byMethod = {}
      chains.set(route, byMethod)
    }
    if (method in byMethod) {
      return byMethod[method]
    }
    byMethod[method] = buildChain(route, branch, method)
    return byMethod[method]
  }

  function buildChain(
    route: AnyRoute,
    branch: ReadonlyArray<AnyRoute>,
    method: RouteMethod,
  ): Chain | undefined {
    const server = route.options.server
    const handlers =
      typeof server?.handlers === 'function'
        ? server.handlers({ createHandlers: (d: any) => d })
        : server?.handlers
    if (!handlers) {
      return undefined
    }
    // HEAD falls back to GET then ANY, like createStartHandler.
    const handler =
      method === 'HEAD'
        ? (handlers.HEAD ?? handlers.GET ?? handlers.ANY)
        : (handlers[method] ?? handlers.ANY)
    if (!handler) {
      return undefined
    }
    // Route and handler middleware only; global middleware runs first and
    // outside the Start request context, as in createStartHandler.
    const middlewares: Chain['middlewares'] = []
    for (const r of branch) {
      if (r.options.server?.middleware) {
        const routeMiddleware = r.options.server
          .middleware as Array<AnyRequestMiddleware>
        for (const m of flattenMiddlewares(routeMiddleware)) {
          // Already ran in the global phase; Start runs each middleware once.
          if (!executedRequestMiddlewares.has(m)) {
            middlewares.push(m.options.server as any)
          }
        }
      }
    }
    if (typeof handler !== 'function' && handler.middleware?.length) {
      for (const m of flattenMiddlewares(handler.middleware)) {
        middlewares.push(m.options.server as any)
      }
    }
    const fn = typeof handler === 'function' ? handler : handler.handler
    return { middlewares, handler: withParsedParams(fn, branch) }
  }

  async function runServerFn(
    request: Request,
    requestOpts: any,
    pathname: string,
    serverFnId: string,
    event: StartEvent,
  ): Promise<Response> {
    const signal = request.signal
    const getRouter = createLazyRouterGetter(request)
    const startContext = {
      getRouter,
      startOptions,
      request,
      executedRequestMiddlewares,
      handlerType: 'serverFn' as const,
    }
    const ctx = {
      request,
      pathname,
      handlerType: 'serverFn' as const,
      context: createNullProtoObject(requestOpts?.context),
    }
    let result: any
    try {
      result = await executeMiddleware(
        globalMiddlewares,
        ({ context }: any) =>
          runWithStartContext(
            { ...startContext, contextAfterGlobalMiddlewares: context },
            () => handleServerAction({ request, serverFnId }),
          ),
        ctx,
        signal,
        event,
      )
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      // Request middleware can throw before the server function runs.
      result = reconcileResponse(
        error instanceof Response
          ? error
          : await runWithStartContext(
              { ...startContext, contextAfterGlobalMiddlewares: ctx.context },
              () => createServerFnErrorResponse(error),
            ),
        event,
      )
    }
    let ssrResponse = normalizeSsrResponse(result)
    if (isRedirect(ssrResponse.response)) {
      ssrResponse = await handleRedirectResponse(
        ssrResponse,
        getRouter,
        signal,
        request.headers.get('x-tsr-serverFn') === 'true',
        event,
      )
    }
    bindSsrResponseToRequest(undefined, ssrResponse, signal)
    return ssrResponse.response
  }

  async function runRoute(
    request: Request,
    requestOpts: any,
    pathname: string,
    chain: Chain,
    rawParams: Record<string, string>,
    event: StartEvent,
  ): Promise<Response> {
    const signal = request.signal
    const getRouter = createLazyRouterGetter(request)
    const startContext = {
      getRouter,
      startOptions,
      request,
      executedRequestMiddlewares,
      handlerType: 'router' as const,
    }
    const result = await executeMiddleware(
      globalMiddlewares,
      // Route middleware and the handler see getRouterInstance(),
      // getGlobalStartContext() and friends, as in createStartHandler.
      (ctx: any) =>
        runWithStartContext(
          { ...startContext, contextAfterGlobalMiddlewares: ctx.context },
          () =>
            executeMiddleware(
              chain.middlewares,
              chain.handler,
              ctx,
              signal,
              event,
              // API routes have no component, so a handler may not defer.
              throwIfMayNotDefer,
            ),
        ),
      {
        request,
        context: createNullProtoObject(requestOpts?.context),
        params: rawParams,
        pathname,
        handlerType: 'router',
      },
      signal,
      event,
    )
    let ssrResponse = normalizeSsrResponse(result)
    if (isRedirect(ssrResponse.response)) {
      ssrResponse = await handleRedirectResponse(
        ssrResponse,
        getRouter,
        signal,
        false,
        event,
      )
    }
    if (request.method === 'HEAD' && ssrResponse.response.body !== null) {
      // RFC 9110 §9.3.2: same headers as GET, no body.
      const source = ssrResponse.response
      ssrResponse = stripSsrResponseBody(ssrResponse, 'HEAD body stripped')
      transferResponseMetadata(source, ssrResponse.response)
    }
    bindSsrResponseToRequest(undefined, ssrResponse, signal)
    return ssrResponse.response
  }

  return (
    request: Request,
    requestOpts: unknown,
    event: StartEvent,
  ): Promise<Response> | Response => {
    // Parsed once per request by withStartRequest. Paths that need
    // normalization (encoded chars, protocol-relative) take the full handler.
    const { pathname } = event.requestUrl
    if (pathname.includes('%') || pathname.startsWith('//')) {
      return fallback(request, requestOpts)
    }

    if (SERVER_FN_BASE && pathname.startsWith(SERVER_FN_BASE)) {
      const idEnd = pathname.indexOf('/', SERVER_FN_BASE.length)
      const serverFnId = pathname.slice(
        SERVER_FN_BASE.length,
        idEnd === -1 ? undefined : idEnd,
      )
      if (!serverFnId) {
        return fallback(request, requestOpts)
      }
      return runServerFn(request, requestOpts, pathname, serverFnId, event)
    }

    // Routes live under the router basepath; anything outside it is not ours.
    let routePath = pathname
    if (ROUTER_BASEPATH !== '/') {
      if (pathname === ROUTER_BASEPATH) {
        routePath = '/'
      } else if (pathname.startsWith(ROUTER_BASEPATH + '/')) {
        routePath = pathname.slice(ROUTER_BASEPATH.length)
      } else {
        return fallback(request, requestOpts)
      }
    }
    // ponytail: router-level `caseSensitive: true` is not visible here (it
    // lives in the router entry); per-route caseSensitive is honoured.
    const match = findRouteMatch(routePath, processedTree, false)
    const chain =
      match &&
      getChain(match.route, match.branch, request.method as RouteMethod)
    if (!chain) {
      return fallback(request, requestOpts)
    }
    return runRoute(
      request,
      requestOpts,
      pathname,
      chain,
      match.rawParams,
      event,
    )
  }
}
