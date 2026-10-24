import { test } from 'vitest'
import { Hono } from 'hono'
import {
  assertServerRouteResponse,
  runServerRouteLoop,
  serverRouteBenchOptions,
} from '../../server-routes/shared'

const app = new Hono().get('/api/users/:id', (c) => {
  const id = c.req.param('id')
  return c.json({ id, name: `user-${id}`, roles: ['a', 'b', 'c'] })
})

await assertServerRouteResponse(app)

test('ssr', async ({ bench }) => {
  await bench('ssr server-route hono reference', async () =>
    runServerRouteLoop(app),
  ).run(serverRouteBenchOptions)
})
