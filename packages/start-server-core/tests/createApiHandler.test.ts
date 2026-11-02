// @vitest-environment node

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from '@tanstack/history'
import {
  createMiddleware,
  getGlobalStartContext,
  getRouterInstance,
} from '@tanstack/start-client-core'
import {
  BaseRootRoute,
  BaseRoute,
  RouterCore,
  createNonReactiveMutableStore,
  createNonReactiveReadonlyStore,
  redirect,
} from '@tanstack/router-core'
import { createApiHandler } from '../src/createApiHandler'
import {
  getStartEvent,
  withStartRequest,
} from '../src/internal-request-response'
import type { AnyRoute } from '@tanstack/router-core'

const mocks = vi.hoisted(() => {
  const previousServerFnBase = process.env.TSS_SERVER_FN_BASE
  process.env.TSS_SERVER_FN_BASE = '/_serverFn/'
  return {
    previousServerFnBase,
    serverFnHandler: undefined as undefined | ((opts: any) => unknown),
    routerFactory: undefined as undefined | (() => unknown),
  }
})

vi.mock('#tanstack-router-entry', () => ({
  getRouter: () => mocks.routerFactory?.(),
}))

vi.mock('../src/server-functions-handler', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  handleServerAction: (opts: any) => mocks.serverFnHandler?.(opts),
}))

afterAll(() => {
  process.env.TSS_SERVER_FN_BASE = mocks.previousServerFnBase
})

beforeEach(() => {
  mocks.serverFnHandler = undefined
  mocks.routerFactory = undefined
})

const calls: Array<string> = []

function makeTree(opts: {
  parentServer?: any
  routeServer?: any
  params?: any
}) {
  const rootRoute = new BaseRootRoute({})
  const apiRoute = new BaseRoute({
    getParentRoute: () => rootRoute,
    path: '/api',
    server: opts.parentServer,
  })
  const userRoute = new BaseRoute({
    getParentRoute: () => apiRoute,
    path: '/users/$id',
    params: opts.params,
    server: opts.routeServer,
  })
  return rootRoute.addChildren([
    apiRoute.addChildren([userRoute]),
  ]) as unknown as AnyRoute
}

function makeHandler(
  tree: AnyRoute,
  extra: Partial<Parameters<typeof createApiHandler>[0]> = {},
) {
  const fallback = vi.fn(async () => new Response('fallback', { status: 599 }))
  const handler = createApiHandler({ routeTree: tree, fallback, ...extra })
  return { handler, fallback }
}

const fetch = (
  handler: ReturnType<typeof createApiHandler>,
  path: string,
  init?: RequestInit,
) => handler(new Request(`http://localhost${path}`, init), undefined as any)

describe('createApiHandler: server routes', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('dispatches an exact match with params, without touching fallback', async () => {
    const tree = makeTree({
      routeServer: {
        handlers: {
          GET: ({ params }: any) => Response.json({ id: params.id }),
        },
      },
    })
    const { handler, fallback } = makeHandler(tree)

    const res = await fetch(handler, '/api/users/42?x=1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: '42' })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back for unmatched, fuzzy, and method-less requests', async () => {
    const tree = makeTree({
      routeServer: { handlers: { GET: () => new Response('ok') } },
    })
    const { handler, fallback } = makeHandler(tree)

    for (const [path, init] of [
      ['/nope', undefined],
      ['/api/users/42/extra', undefined],
      ['/api/users/42', { method: 'POST' }],
      ['/api', undefined],
    ] as const) {
      const res = await fetch(handler, path, init)
      expect(res.status).toBe(599)
    }
    expect(fallback).toHaveBeenCalledTimes(4)
  })

  it('runs a withStartRequest fallback inside its own request event, not a second one', async () => {
    const events: Array<unknown> = []
    const fallback = withStartRequest((request, _opts, event) => {
      events.push(event, getStartEvent())
      return new Response('fallback', { status: 599 })
    })
    const outer = vi.fn()
    const handler = createApiHandler({
      routeTree: makeTree({}),
      fallback: (request, opts) => {
        outer(getStartEvent())
        return fallback(request, opts)
      },
    })

    const res = await fetch(handler, '/nope')

    expect(res.status).toBe(599)
    // One event for the whole request: the fallback's wrapper reused it.
    expect(events[0]).toBe(events[1])
    expect(outer).toHaveBeenCalledWith(events[0])
  })

  it('serves HEAD from GET with the same headers and no body', async () => {
    const tree = makeTree({
      routeServer: {
        handlers: {
          GET: () => new Response('body', { headers: { 'x-a': '1' } }),
        },
      },
    })
    const { handler } = makeHandler(tree)

    const res = await fetch(handler, '/api/users/1', { method: 'HEAD' })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-a')).toBe('1')
    expect(res.body).toBeNull()
  })

  it('uses ANY when no method handler exists', async () => {
    const tree = makeTree({
      routeServer: { handlers: { ANY: () => new Response('any') } },
    })
    const { handler } = makeHandler(tree)

    const res = await fetch(handler, '/api/users/1', { method: 'DELETE' })

    expect(await res.text()).toBe('any')
  })

  it('runs global, parent, route, and handler middleware in order and merges context', async () => {
    const mw = (name: string) =>
      createMiddleware({ type: 'request' }).server(({ next }) => {
        calls.push(name)
        return next({ context: { [name]: true } })
      })
    const tree = makeTree({
      parentServer: { middleware: [mw('parent')] },
      routeServer: {
        middleware: [mw('route')],
        handlers: {
          GET: {
            middleware: [mw('handler')],
            handler: ({ context }: any) => {
              calls.push('fn')
              return Response.json(context)
            },
          },
        },
      },
    })
    const { handler } = makeHandler(tree, {
      startOptions: { requestMiddleware: [mw('global')] } as any,
    })

    const res = await fetch(handler, '/api/users/1')

    expect(calls).toEqual(['global', 'parent', 'route', 'handler', 'fn'])
    expect(await res.json()).toEqual({
      global: true,
      parent: true,
      route: true,
      handler: true,
    })
  })

  it('does not rerun route middleware that already ran as global middleware', async () => {
    const shared = createMiddleware({ type: 'request' }).server(({ next }) => {
      calls.push('shared')
      return next()
    })
    const tree = makeTree({
      parentServer: { middleware: [shared] },
      routeServer: {
        middleware: [shared],
        handlers: { GET: () => new Response() },
      },
    })
    const { handler } = makeHandler(tree, {
      startOptions: { requestMiddleware: [shared] } as any,
    })

    await fetch(handler, '/api/users/1')

    expect(calls).toEqual(['shared'])
  })

  it('runs middleware once per request even when chains are reused', async () => {
    const mw = createMiddleware({ type: 'request' }).server(({ next }) => {
      calls.push('mw')
      return next()
    })
    const tree = makeTree({
      routeServer: {
        middleware: [mw],
        handlers: { GET: () => new Response() },
      },
    })
    const { handler } = makeHandler(tree)

    await fetch(handler, '/api/users/1')
    await fetch(handler, '/api/users/2')

    expect(calls).toEqual(['mw', 'mw'])
  })

  it('runs route middleware and handlers inside the Start request context', async () => {
    mocks.routerFactory = () => ({ id: 'lazy', options: {}, update() {} })
    const mw = createMiddleware({ type: 'request' }).server(({ next }) =>
      next({ context: { fromGlobal: 1 } }),
    )
    const tree = makeTree({
      routeServer: {
        middleware: [
          createMiddleware({ type: 'request' }).server(({ next }) =>
            next({ context: { seenGlobal: getGlobalStartContext() } }),
          ),
        ],
        handlers: {
          GET: async ({ context }: any) =>
            Response.json({
              ...context,
              router: ((await getRouterInstance()) as any).id,
            }),
        },
      },
    })
    const { handler } = makeHandler(tree, {
      startOptions: { requestMiddleware: [mw] } as any,
    })

    const res = await fetch(handler, '/api/users/1')

    expect(await res.json()).toEqual({
      fromGlobal: 1,
      seenGlobal: { fromGlobal: 1 },
      router: 'lazy',
    })
  })

  it('applies params.parse before the handler', async () => {
    const tree = makeTree({
      params: { parse: (p: any) => ({ id: Number(p.id) }) },
      routeServer: {
        handlers: { GET: ({ params }: any) => Response.json(params) },
      },
    })
    const { handler } = makeHandler(tree)

    const res = await fetch(handler, '/api/users/7')

    expect(await res.json()).toEqual({ id: 7 })
  })
})

describe('createApiHandler: server functions', () => {
  it('dispatches by id and runs global middleware first', async () => {
    const mw = createMiddleware({ type: 'request' }).server(({ next }) =>
      next({ context: { fromGlobal: 1 } }),
    )
    mocks.serverFnHandler = ({ serverFnId }) => Response.json({ serverFnId })
    const { handler, fallback } = makeHandler(makeTree({}), {
      startOptions: { requestMiddleware: [mw] } as any,
    })

    const res = await fetch(handler, '/_serverFn/abc123/extra?x=1', {
      method: 'POST',
    })

    expect(await res.json()).toEqual({ serverFnId: 'abc123' })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('applies the default CSRF middleware when there is no Start instance', async () => {
    mocks.serverFnHandler = () => new Response('ran')
    const { handler } = makeHandler(makeTree({}))

    const crossSite = await fetch(handler, '/_serverFn/abc', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    const sameOrigin = await fetch(handler, '/_serverFn/abc', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    })

    expect(crossSite.status).toBe(403)
    expect(await sameOrigin.text()).toBe('ran')
  })

  it('resolves redirect({ to }) through a lazily built router', async () => {
    mocks.routerFactory = () => {
      const rootRoute = new BaseRootRoute({})
      const usersRoute = new BaseRoute({
        getParentRoute: () => rootRoute,
        path: '/users/$id',
      })
      const router = new RouterCore(
        {
          history: createMemoryHistory({ initialEntries: ['/'] }),
          routeTree: rootRoute.addChildren([usersRoute]),
        },
        () => ({
          createMutableStore: createNonReactiveMutableStore,
          createReadonlyStore: createNonReactiveReadonlyStore,
          batch: (fn: () => void) => fn(),
        }),
      )
      router.isServer = true
      return router
    }
    mocks.serverFnHandler = () =>
      redirect({ to: '/users/$id', params: { id: '9' } })
    const { handler } = makeHandler(makeTree({}))

    const res = await fetch(handler, '/_serverFn/abc', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'x-tsr-serverFn': 'true' },
    })

    // Serialized redirects carry the resolved href in the envelope, not Location.
    expect(res.headers.get('location')).toBeNull()
    expect(await res.json()).toMatchObject({
      isSerializedRedirect: true,
      href: '/users/9',
    })
  })
})
