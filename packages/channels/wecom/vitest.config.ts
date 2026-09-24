import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
    // Shared-pool ceiling; see scripts/tests/unit-vitest-configs.test.ts.
    // Raised only on the ECS pool, where the same suite runs ~5x slower
    // depending on which host it lands on (#10490); off the pool this stays
    // `undefined` so vitest's 5s default keeps catching a genuine hang fast.
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
