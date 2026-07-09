import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'client',
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
