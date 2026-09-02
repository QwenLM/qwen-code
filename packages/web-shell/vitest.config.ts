import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'client',
  resolve: {
    alias: {
      '@qwen-code/web-shell/daemon-react-sdk': resolve(
        __dirname,
        './client/daemon-react-sdk.ts',
      ),
      '@': resolve(__dirname, './client'),
    },
  },
  test: {
    setupFiles: ['./test/setup.ts'],
    // Same shared-ECS ceilings as packages/cli: the jsdom component tests
    // here were the bulk of the release failures at vitest's 5s default.
    testTimeout: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? 60_000
      : undefined,
    hookTimeout: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? 60_000
      : undefined,
    exclude: [...configDefaults.exclude, 'e2e/**'],
    reporters: ['default', ['junit', { suiteName: '@qwen-code/web-shell' }]],
    outputFile: {
      junit: '../junit.xml',
    },
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
    coverage: {
      provider: 'v8',
      reportsDirectory: '../coverage',
      reporter: ['text-summary', 'json-summary', 'html'],
      include: ['**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/test/**',
        '**/e2e/**',
        '**/*.d.ts',
        'vite-env.d.ts',
      ],
    },
  },
});
