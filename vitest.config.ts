import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests spawn Git processes; bound their combined resource use.
    maxWorkers: 4,
  },
});
