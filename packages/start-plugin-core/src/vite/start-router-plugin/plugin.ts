import { readFile } from 'node:fs/promises'
import * as t from '@babel/types'
import { parseAst } from '@tanstack/router-utils'
import { createRouterPluginContext } from '@tanstack/router-plugin/context'
import {
  tanStackRouterCodeSplitter,
  tanstackRouterGenerator,
} from '@tanstack/router-plugin/vite'
import path from 'pathe'
import { normalizePath } from 'vite'
import { VITE_ENVIRONMENT_NAMES } from '../../constants'
import { routesManifestPlugin } from '../../start-router-plugin/generator-plugins/routes-manifest-plugin'
import { prerenderRoutesPlugin } from '../../start-router-plugin/generator-plugins/prerender-routes-plugin'
import { buildRouteTreeFileFooterFromConfig } from '../../start-router-plugin/route-tree-footer'
import { pruneServerOnlySubtrees } from '../../start-router-plugin/pruneServerOnlySubtrees'
import { SERVER_PROP } from '../../start-router-plugin/constants'
import type { GetConfigFn } from '../../types'
import type { TanStackStartVitePluginCoreOptions } from '../types'
import type {
  Generator,
  GeneratorPlugin,
  RouteNode,
} from '@tanstack/router-generator'
import type { DevEnvironment, Plugin, PluginOption } from 'vite'
import type { TanStackStartInputConfig } from '../../schema'

/**
 * URL-space path of a node: route groups and pathless layout segments
 * removed. Escaped literal underscores are treated as pathless too, which only
 * makes the shadow check stricter.
 */
function urlPath(node: RouteNode) {
  return (node.routePath ?? '')
    .split('/')
    .filter((s) => !s.startsWith('_') && !/^\(.*\)$/.test(s))
    .join('/')
}

/** Static path prefix before the first `$` segment, or undefined if none. */
function dynamicPrefix(routePath: string) {
  const segments = routePath.split('/')
  const i = segments.findIndex((s) => s.includes('$'))
  return i === -1 ? undefined : segments.slice(0, i).join('/') + '/'
}

/**
 * True unless the root file provably calls createRootRoute /
 * createRootRouteWithContext with an object literal that has no `server` key.
 */
async function rootRouteMayHaveServerOptions(rootFilePath: string) {
  const code = await readFile(rootFilePath, 'utf-8')
  const ast = parseAst({ code, sourceFilename: rootFilePath })
  let verdict: boolean | undefined
  const visit = (value: unknown): void => {
    if (verdict !== undefined || !value || typeof value !== 'object') {
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const node = value as t.Node
    if (t.isCallExpression(node)) {
      const callee = node.callee
      const isRootCall =
        (t.isIdentifier(callee) && callee.name === 'createRootRoute') ||
        (t.isCallExpression(callee) &&
          t.isIdentifier(callee.callee) &&
          callee.callee.name === 'createRootRouteWithContext')
      if (isRootCall) {
        const arg = node.arguments[0]
        verdict =
          !t.isObjectExpression(arg) ||
          arg.properties.some(
            (p) =>
              !t.isObjectProperty(p) ||
              p.computed ||
              (t.isIdentifier(p.key) && p.key.name === SERVER_PROP) ||
              (t.isStringLiteral(p.key) && p.key.value === SERVER_PROP),
          )
        return
      }
    }
    for (const value of Object.values(node)) {
      visit(value)
    }
  }
  visit(ast.program)
  return verdict ?? true
}

function isServerOnlyNode(node: RouteNode | undefined) {
  if (!node?.createFileRouteProps) {
    return false
  }
  return (
    node.createFileRouteProps.has(SERVER_PROP) &&
    node.createFileRouteProps.size === 1
  )
}

export function tanStackStartRouter(
  startPluginOpts: TanStackStartInputConfig,
  getConfig: GetConfigFn,
  corePluginOpts: TanStackStartVitePluginCoreOptions,
): Array<PluginOption> {
  const routerPluginContext = createRouterPluginContext()

  const getGeneratedRouteTreePath = () => {
    const { startConfig } = getConfig()
    return path.resolve(startConfig.router.generatedRouteTree)
  }

  let clientEnvironment: DevEnvironment | null = null
  function invalidate() {
    if (!clientEnvironment) {
      return
    }

    const mod = clientEnvironment.moduleGraph.getModuleById(
      getGeneratedRouteTreePath(),
    )
    if (mod) {
      clientEnvironment.moduleGraph.invalidateModule(mod)
    }
    clientEnvironment.hot.send({ type: 'full-reload', path: '*' })
  }

  let generatorInstance: Generator | null = null

  const clientTreeGeneratorPlugin: GeneratorPlugin = {
    name: 'start-client-tree-plugin',
    init({ generator }) {
      generatorInstance = generator
    },
    afterTransform({ node, prevNode }) {
      if (isServerOnlyNode(node) !== isServerOnlyNode(prevNode)) {
        invalidate()
      }
    },
  }

  let routeTreeFileFooter: Array<string> | null = null

  function getRouteTreeFileFooter() {
    if (routeTreeFileFooter) {
      return routeTreeFileFooter
    }
    routeTreeFileFooter = [
      ...buildRouteTreeFileFooterFromConfig({
        generatedRouteTreePath: getGeneratedRouteTreePath(),
        getConfig,
        corePluginOpts,
      }),
    ]
    return routeTreeFileFooter
  }

  let resolvedGeneratedRouteTreePath: string | null = null
  const clientTreePlugin: Plugin = {
    name: 'tanstack-start:route-tree-client-plugin',
    enforce: 'pre',
    applyToEnvironment: (env) => env.name === VITE_ENVIRONMENT_NAMES.client,
    configureServer(server) {
      clientEnvironment = server.environments[VITE_ENVIRONMENT_NAMES.client]
    },
    config() {
      type LoadObjectHook = Extract<
        typeof clientTreePlugin.load,
        { filter?: unknown }
      >
      resolvedGeneratedRouteTreePath = normalizePath(
        getGeneratedRouteTreePath(),
      )
      ;(clientTreePlugin.load as LoadObjectHook).filter = {
        id: { include: new RegExp(resolvedGeneratedRouteTreePath) },
      }
    },

    load: {
      filter: {
        // this will be set in the config hook above since it relies on `config` hook being called first
      },
      async handler() {
        if (!generatorInstance) {
          throw new Error('Generator instance not initialized')
        }
        const crawlingResult = await generatorInstance.getCrawlingResult()
        if (!crawlingResult) {
          throw new Error('Crawling result not available')
        }
        const prunedAcc = pruneServerOnlySubtrees(crawlingResult)
        const acc = {
          ...crawlingResult.acc,
          ...prunedAcc,
        }
        const buildResult = generatorInstance.buildRouteTree({
          ...crawlingResult,
          acc,
          config: {
            // importRoutesUsingAbsolutePaths: true,
            // addExtensions: true,
            disableTypes: true,
            enableRouteTreeFormatting: false,
            routeTreeFileHeader: [],
            routeTreeFileFooter: [],
          },
        })
        return { code: buildResult.routeTreeContent, map: null }
      },
    },
  }
  // Experimental: server-only routes as their own tree, for createApiHandler.
  const API_TREE_ID = 'virtual:tanstack-start-api-route-tree'
  const RESOLVED_API_TREE_ID = '\0' + API_TREE_ID
  const apiTreePlugin: Plugin = {
    name: 'tanstack-start:route-tree-api-plugin',
    enforce: 'pre',
    applyToEnvironment: (env) => env.name === VITE_ENVIRONMENT_NAMES.server,
    resolveId(id) {
      return id === API_TREE_ID ? RESOLVED_API_TREE_ID : undefined
    },
    async load(id) {
      if (id !== RESOLVED_API_TREE_ID) {
        return undefined
      }
      if (!generatorInstance) {
        throw new Error('Generator instance not initialized')
      }
      const crawlingResult = await generatorInstance.getCrawlingResult()
      if (!crawlingResult) {
        throw new Error('Crawling result not available')
      }
      // The API tree replaces __root with a bare root, so root server
      // middleware (often auth) would be silently skipped. Fail closed,
      // including when the root options cannot be read statically.
      if (
        await rootRouteMayHaveServerOptions(
          crawlingResult.rootRouteNode.fullPath,
        )
      ) {
        throw new Error(
          `${API_TREE_ID}: the root route defines \`server\` options (or its options could not be read statically), which createApiHandler cannot run. Move root server middleware to the API routes or to global requestMiddleware.`,
        )
      }
      // Keep only subtrees where every node is server-only, so the tree never
      // imports a route file with a component.
      const routeNodes: Array<RouteNode> = []
      const pruned: Array<RouteNode> = []
      const prune = (node: RouteNode) => {
        pruned.push(node)
        node.children?.forEach(prune)
      }
      const keep = (node: RouteNode): RouteNode | null => {
        if (!isServerOnlyNode(node)) {
          prune(node)
          return null
        }
        const children = (node.children || [])
          .map(keep)
          .filter((n): n is RouteNode => n !== null)
        routeNodes.push(node)
        return { ...node, children }
      }
      const routeTree = crawlingResult.acc.routeTree
        .map(keep)
        .filter((n): n is RouteNode => n !== null)
      // A kept param or splat route must not win a path that a pruned route
      // would win in the full tree (`/api/$` vs a pruned `/api/docs` page).
      for (const kept of routeNodes) {
        const prefix = dynamicPrefix(urlPath(kept))
        if (prefix === undefined) {
          continue
        }
        const shadowed = pruned.find((p) => urlPath(p).startsWith(prefix))
        if (shadowed) {
          throw new Error(
            `${API_TREE_ID}: server-only route "${kept.routePath}" would shadow "${shadowed.routePath}" in the API tree. Give the API route a static prefix no page route shares, or add a component to it.`,
          )
        }
      }
      const buildResult = generatorInstance.buildRouteTree({
        ...crawlingResult,
        acc: { ...crawlingResult.acc, routeTree, routeNodes },
        config: {
          importRoutesUsingAbsolutePaths: true,
          disableTypes: true,
          enableRouteTreeFormatting: false,
          routeTreeFileHeader: [],
          routeTreeFileFooter: [],
        },
      })
      // ponytail: the generator hardwires the __root import; swap it for a
      // bare root so React never loads. Root server middleware is skipped.
      const code = buildResult.routeTreeContent
        .replace(
          /import \{ Route as rootRouteImport \} from '[^']*'/,
          `import { createRootRoute } from '@tanstack/${corePluginOpts.framework}-router'\nconst rootRouteImport = createRootRoute()`,
        )
        .replace('export const routeTree =', 'export const apiRouteTree =')
      return { code, map: null }
    },
  }

  return [
    clientTreePlugin,
    apiTreePlugin,
    tanstackRouterGenerator(() => {
      const routerConfig = getConfig().startConfig.router
      const plugins = [clientTreeGeneratorPlugin, routesManifestPlugin()]
      if (startPluginOpts.prerender?.enabled === true) {
        plugins.push(prerenderRoutesPlugin())
      }
      return {
        ...routerConfig,
        target: corePluginOpts.framework,
        routeTreeFileFooter: getRouteTreeFileFooter,
        plugins,
      }
    }, routerPluginContext),
    tanStackRouterCodeSplitter(() => {
      const routerConfig = getConfig().startConfig.router
      return {
        ...routerConfig,
        codeSplittingOptions: {
          ...routerConfig.codeSplittingOptions,
          deleteNodes: ['ssr', 'server', 'headers'],
          addHmr: true,
        },
        plugin: {
          vite: { environmentName: VITE_ENVIRONMENT_NAMES.client },
        },
      }
    }, routerPluginContext),
    tanStackRouterCodeSplitter(() => {
      const routerConfig = getConfig().startConfig.router
      return {
        ...routerConfig,
        codeSplittingOptions: {
          ...routerConfig.codeSplittingOptions,
          addHmr: false,
        },
        plugin: {
          vite: { environmentName: VITE_ENVIRONMENT_NAMES.server },
        },
      }
    }, routerPluginContext),
  ]
}
