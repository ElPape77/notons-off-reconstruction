import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 85,
        branches: 78,
        functions: 90,
        lines: 85,
      },
    },
  },
});
