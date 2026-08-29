import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    dangerouslyIgnoreUnhandledErrors:
      process.platform !== 'linux' ||
      process.env['RUNNER_ENVIRONMENT'] === 'self-hosted',
  },
});
