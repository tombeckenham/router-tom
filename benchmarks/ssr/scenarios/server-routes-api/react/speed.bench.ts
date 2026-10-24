import { test } from 'vitest'
import {
  assertServerRouteResponse,
  runServerRouteLoop,
  serverRouteBenchOptions,
} from '../../server-routes/shared'
import type { StartRequestHandler } from '../../server-routes/shared'

const appModuleUrl = new URL('./dist/server/server.js', import.meta.url).href

const { default: handler } = (await import(
  /* @vite-ignore */ appModuleUrl
)) as {
  default: StartRequestHandler
}

await assertServerRouteResponse(handler)

test('ssr', async ({ bench }) => {
  await bench('ssr server-route api-handler (react)', async () =>
    runServerRouteLoop(handler),
  ).run(serverRouteBenchOptions)
})
