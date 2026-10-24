import { test } from 'vitest'
import {
  assertServerFnScenario,
  runServerFnPostRequestLoop,
  serverFnBenchOptions,
  setupServerFnBench,
} from '../../server-fns/bench'
import type { StartRequestHandler } from '../../server-fns/bench'

const { default: handler } = (await import(
  /* @vite-ignore */ new URL('./dist/server/server.js', import.meta.url).href
)) as {
  default: StartRequestHandler
}
const context = await setupServerFnBench(handler)

await assertServerFnScenario(handler, context)

test('ssr', async ({ bench }) => {
  await bench('ssr server-fn POST api-handler (react)', async () =>
    runServerFnPostRequestLoop(handler, context),
  ).run(serverFnBenchOptions)
})
