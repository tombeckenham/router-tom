import { createApiHandler } from '@tanstack/react-start/server'
import start from './ssr'

// Both handlers from one build so every benchmark sees the same route table.
// A real app would import './ssr' lazily; static here keeps the baseline
// free of an extra promise hop.
export { start }

export default {
  fetch: createApiHandler({ fallback: start.fetch }),
}

// The fallback shape apps actually write (see e2e/react-start/basic): a
// dynamic import per fallback request. Measures that hop deterministically.
export const apiLazy = {
  fetch: createApiHandler({
    fallback: async (request, opts) =>
      (await import('./ssr')).default.fetch(request, opts),
  }),
}
