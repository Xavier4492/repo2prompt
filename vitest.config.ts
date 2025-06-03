import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'istanbul', // or 'v8'
      reporter: ['text', 'html'],
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/cli.ts'],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 80,
        lines: 80,
      },
    },
  },
})
