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
      // Resolve the in-repo channel-base to its live SOURCE so a package-local
      // test run (e.g. `cd packages/channels/dws && vitest`) doesn't depend
      // on a prior `tsc --build` of base — its dist may be absent or stale during
      // development. Mirrors the other channel packages' configs.
      '@qwen-code/channel-base': path.resolve(
        __dirname,
        '../base/src/index.ts',
      ),
    },
  },
});
