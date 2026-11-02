declare module 'tanstack-start-manifest:v' {
  import type { ServerManifest } from '@tanstack/router-core'

  export const tsrStartManifest: () => ServerManifest
}

declare module 'tanstack-start-route-tree:v' {
  import type { AnyRoute } from '@tanstack/router-core'

  export const routeTree: AnyRoute | undefined
}

declare module 'virtual:tanstack-start-api-route-tree' {
  import type { AnyRoute } from '@tanstack/router-core'

  /** Server-only routes (no UI), with a bare root. Experimental. */
  export const apiRouteTree: AnyRoute
}

declare module '#tanstack-start-server-fn-resolver' {
  export type ServerFnLookupAccess = { origin: 'client' } | { origin: 'server' }

  export type ServerFn = ((...args: Array<any>) => Promise<any>) & {
    method?: 'GET' | 'POST'
  }
  export function getServerFnById(
    id: string,
    access: ServerFnLookupAccess,
  ): Promise<ServerFn>
}
