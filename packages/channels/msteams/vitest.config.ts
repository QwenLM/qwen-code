import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
    // Shared-pool ceiling; see scripts/tests/unit-vitest-configs.test.ts.
    testTimeout: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? 60_000
      : undefined,
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
