import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/lib/**',
      'benchmark/tasks/**',
      'benchmark/bench-home-template/**',
      'benchmark/ws-*/**',
      'benchmark/run-home-*/**',
    ],
  },
})
