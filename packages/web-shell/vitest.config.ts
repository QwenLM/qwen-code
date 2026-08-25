import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'client',
  resolve: {
    alias: {
      '@': resolve(__dirname, './client'),
    },
  },
  test: {
    setupFiles: ['./test/setup.ts'],
    exclude: [...configDefaults.exclude, 'e2e/**'],
    reporters: ['default', ['junit', { suiteName: '@qwen-code/web-shell' }]],
    outputFile: {
      junit: '../junit.xml',
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: '../coverage',
      reporter: ['text-summary', 'json-summary', 'html'],
      include: ['**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/test/**',
        '**/e2e/**',
        '**/*.d.ts',
        'vite-env.d.ts',
      ],
    },
  },
});
