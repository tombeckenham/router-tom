import { test } from 'vitest'
import { randomSegment, runRequestLoop } from '../../bench-utils'
import { MANY_ROUTE_COUNT, honoApp } from './hono'
import type { StartRequestHandler } from '../../bench-utils'

export type { StartRequestHandler }

const benchmarkSeed = 0xdecafbad
const concurrency = 16

const jsonRequestInit = {
  method: 'GET',
  headers: { accept: 'application/json' },
} satisfies RequestInit

const htmlRequestInit = {
  method: 'GET',
  headers: { accept: 'text/html' },
} satisfies RequestInit

interface Shape {
  totalRequests: number
  /** Hono has no page fallback, so some shapes measure Start only. */
  hono: boolean
  options: { warmupIterations: number; time: number; throws: true }
  buildRequest: (random: () => number) => Request
  assert: (handler: StartRequestHandler) => Promise<void>
}

const jsonOptions = {
  warmupIterations: 100,
  time: 10_000,
  throws: true,
} as const

async function expectJson(
  handler: StartRequestHandler,
  path: string,
  expected: Record<string, unknown>,
) {
  const response = await handler.fetch(
    new Request(`http://localhost${path}`, jsonRequestInit),
  )
  if (response.status !== 200) {
    throw new Error(`${path}: expected 200, received ${response.status}`)
  }
  const body = (await response.json()) as Record<string, unknown>
  for (const [key, value] of Object.entries(expected)) {
    if (body[key] !== value) {
      throw new Error(
        `${path}: expected ${key}=${value}, received ${body[key]}`,
      )
    }
  }
}

export const shapes = {
  // Exact static match, hits the matcher cache every time.
  static: {
    totalRequests: 208,
    hono: true,
    options: jsonOptions,
    buildRequest: () =>
      new Request('http://localhost/api/health', jsonRequestInit),
    assert: (handler) => expectJson(handler, '/api/health', { ok: true }),
  },
  // Same route as the upstream `server-routes` scenario: a fresh param each
  // request, so the matcher cache misses every time.
  param: {
    totalRequests: 208,
    hono: true,
    options: jsonOptions,
    buildRequest: (random) =>
      new Request(
        `http://localhost/api/users/${randomSegment(random)}`,
        jsonRequestInit,
      ),
    assert: (handler) =>
      expectJson(handler, '/api/users/sanity', { name: 'user-sanity' }),
  },
  // Three request middlewares up the branch: layout, route, handler.
  'nested-middleware': {
    totalRequests: 208,
    hono: true,
    options: jsonOptions,
    buildRequest: (random) =>
      new Request(
        `http://localhost/api/admin/${randomSegment(random)}`,
        jsonRequestInit,
      ),
    assert: (handler) =>
      expectJson(handler, '/api/admin/sanity', { id: 'sanity', total: 6 }),
  },
  // 200 static siblings, requests spread across all of them.
  'many-routes': {
    totalRequests: 208,
    hono: true,
    options: jsonOptions,
    buildRequest: (random) =>
      new Request(
        `http://localhost/api/many/r${Math.floor(random() * MANY_ROUTE_COUNT)}`,
        jsonRequestInit,
      ),
    assert: (handler) =>
      expectJson(handler, `/api/many/r${MANY_ROUTE_COUNT - 1}`, {
        n: MANY_ROUTE_COUNT - 1,
      }),
  },
  // A page request: the fast path must hand it to Start at no extra cost.
  'page-fallback': {
    totalRequests: 48,
    hono: false,
    options: { warmupIterations: 10, time: 10_000, throws: true },
    buildRequest: () => new Request('http://localhost/', htmlRequestInit),
    assert: async (handler) => {
      const response = await handler.fetch(
        new Request('http://localhost/', htmlRequestInit),
      )
      const html = await response.text()
      if (response.status !== 200 || !html.includes('server routes matrix')) {
        throw new Error(
          `/: expected the rendered page, received ${response.status}`,
        )
      }
    },
  },
} satisfies Record<string, Shape>

export type ShapeName = keyof typeof shapes

export function runShapeLoop(handler: StartRequestHandler, shape: Shape) {
  return runRequestLoop(handler, {
    seed: benchmarkSeed,
    concurrency,
    totalRequests: shape.totalRequests,
    buildRequest: shape.buildRequest,
  })
}

/**
 * Registers one benchmark per handler for a shape. The built app exports the
 * fast path as `default` and the plain Start handler as `start`, so all three
 * handlers serve the same route table.
 */
export async function defineShapeBenches(
  shapeName: ShapeName,
  appModuleUrl: string,
) {
  const shape: Shape = shapes[shapeName]
  const app = (await import(/* @vite-ignore */ appModuleUrl)) as {
    default: StartRequestHandler
    start: StartRequestHandler
  }
  const handlers: Array<[label: string, handler: StartRequestHandler]> = [
    ['start (react)', app.start],
    ['api-handler (react)', app.default],
  ]
  if (shape.hono) {
    handlers.push(['hono', honoApp])
  }
  for (const [label, handler] of handlers) {
    await shape.assert(handler)
    test(label, async ({ bench }) => {
      await bench(`ssr server-route ${shapeName} ${label}`, async () =>
        runShapeLoop(handler, shape),
      ).run(shape.options)
    })
  }
}
