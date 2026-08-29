import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { unhandledErrorExemption } from '../../scripts/vitest-unhandled-error-exemption.js';

export default defineConfig({
  resolve: {
    alias: {
      '@qwen-code/qwen-code/export': path.resolve(
        __dirname,
        '../cli/src/export/index.ts',
      ),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.js'],
    dangerouslyIgnoreUnhandledErrors: unhandledErrorExemption,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'clover'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
});
