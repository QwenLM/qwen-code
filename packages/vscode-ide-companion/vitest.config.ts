import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@qwen-code/qwen-code/export': path.resolve(
        __dirname,
        '../cli/src/export/index.ts',
      ),
    },
  },
  test: {
    // See packages/core/vitest.config.ts: the embedded-webview bundle guard
    // drives esbuild across the whole webview app, which outruns vitest's 5s
    // default under shared-runner contention (and on slow hosts even without
    // it). Only the timeout ceiling grows; assertions still fail instantly.
    testTimeout: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? 60_000
      : 15_000,
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.js'],
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
    coverage: {
      // Same switch as cli/core: only the post-merge main run collects it.
      enabled: process.env['QWEN_CI_COVERAGE'] === '1',
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'clover'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
});
