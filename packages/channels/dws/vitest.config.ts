import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
    // The worker->main `onTaskUpdate` RPC runs on a 60s budget; under the
    // resource pressure of the Windows/macOS runners a stall longer than
    // that surfaces as an unhandled error and exits an all-green run red
    // (the same failure class the core, cli, and scripts suites hit on
    // these lanes). Test failures still fail the run; only unhandled
    // errors stop being fatal, and only off Linux — the ubuntu lane and
    // Linux local runs keep the unhandled-error signal.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
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
