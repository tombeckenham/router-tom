import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import codspeedPlugin from '@codspeed/vitest-plugin'
import { cpuSimulationExecArgv } from '../../../../cpu-simulation'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

// Reference point for server-routes: the same JSON route on Hono, no build.
export default defineConfig({
  root: rootDir,
  plugins: [
    !!(process.env.VITEST && process.env.WITH_INSTRUMENTATION) &&
      codspeedPlugin(),
  ],
  test: {
    execArgv: cpuSimulationExecArgv(),
    isolate: true,
    name: '@benchmarks/ssr server-routes-hono (react)',
    watch: false,
    environment: 'node',
  },
})
