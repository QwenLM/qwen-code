import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
    reporters: ['default', 'junit'],
    outputFile: {
      junit: 'junit.xml',
    },
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
    // Shared-pool ceiling; see scripts/tests/unit-vitest-configs.test.ts.
    testTimeout: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? 60_000
      : undefined,
  },
});
