import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
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
