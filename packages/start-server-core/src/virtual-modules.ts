export const VIRTUAL_MODULES = {
  startManifest: 'tanstack-start-manifest:v',
  serverFnResolver: '#tanstack-start-server-fn-resolver',
  pluginAdapters: '#tanstack-start-plugin-adapters',
  /** Server-only route tree for createApiHandler. Experimental. */
  apiRouteTree: 'virtual:tanstack-start-api-route-tree',
} as const
