import { createApiHandler } from '@tanstack/react-start/server'

export default {
  fetch: createApiHandler({
    fallback: async (request, opts) =>
      (await import('./ssr')).default.fetch(request, opts),
  }),
}
