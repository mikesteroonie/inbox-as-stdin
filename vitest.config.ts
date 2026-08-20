import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // §1: policy.ts and envelope.ts are held at 100% branch coverage.
      thresholds: {
        'src/policy.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
        'src/envelope.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
      },
    },
  },
})
