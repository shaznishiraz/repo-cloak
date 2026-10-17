import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests spawn Git processes; bound their combined resource use.
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: {
        lines: 85,
        statements: 83,
        branches: 75,
        functions: 85,
        'src/core/**': { lines: 95, statements: 93, branches: 85, functions: 98 },
      },
    },
  },
});
