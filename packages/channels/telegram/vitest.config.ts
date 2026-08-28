import { defineConfig } from 'vitest/config';

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
});
