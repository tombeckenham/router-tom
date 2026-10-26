import { createApiHandler } from '@tanstack/react-start/server'
import start from './ssr'

// Both handlers from one build so every benchmark sees the same route table.
// A real app would import './ssr' lazily; static here keeps the baseline
// free of an extra promise hop.
export { start }

export default {
  fetch: createApiHandler({ fallback: start.fetch }),
}
