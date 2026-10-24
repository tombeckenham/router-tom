// DO NOT DELETE THIS FILE!!!
// This file is a good smoke test to make sure the custom server entry is working
import { createApiHandler } from '@tanstack/react-start/server'

console.log("[server-entry]: using custom server entry in 'src/server.ts'")

export default {
  fetch: createApiHandler({
    fallback: async (request, opts) =>
      (await import('@tanstack/react-start/server-entry')).default.fetch(
        request,
        opts,
      ),
  }),
}
