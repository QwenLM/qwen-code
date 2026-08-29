import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { unhandledErrorExemption } from '../../../scripts/vitest-unhandled-error-exemption.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
    dangerouslyIgnoreUnhandledErrors: unhandledErrorExemption,
  },
  resolve: {
    alias: {
      '@qwen-code/channel-base': path.resolve(
        __dirname,
        '../base/src/index.ts',
      ),
    },
  },
});
