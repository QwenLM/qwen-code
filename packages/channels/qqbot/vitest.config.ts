import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
  },
  server: {
    deps: {
      inline: ['@qwen-code/channel-base'],
    },
  },
  resolve: {
    alias: {
      // Resolve the in-repo channel-base to its live SOURCE so a package-local
      // test run (e.g. `cd packages/channels/qqbot && vitest`) doesn't depend on
      // a prior `tsc --build` of base — its dist may be absent or stale during
      // development. Mirrors packages/cli/vitest.config.ts.
      '@qwen-code/channel-base': path.resolve(
        __dirname,
        '../base/src/index.ts',
      ),
    },
  },
});
