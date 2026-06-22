/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@qwen-code/qwen-code-core': path.resolve(__dirname, '../core/index.ts'),
      // cli's daemon-status-provider.test.ts imports `FakeAgent` /
      // `makeChannel` from acp-bridge's package-private
      // `internal/testUtils` module. This alias overrides the runtime
      // resolution so vitest reads the .ts source directly instead of
      // the build-then-stale `dist/` copy.
      '@qwen-code/acp-bridge/internal/testUtils': path.resolve(
        __dirname,
        '../acp-bridge/src/internal/testUtils.ts',
      ),
      // Same rationale as above: bridgeErrors and status subpaths
      // resolve to dist/ via package.json exports, but tests in the
      // monorepo worktree need the live source (dist may be stale or
      // absent during development).
      '@qwen-code/acp-bridge/bridgeErrors': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeErrors.ts',
      ),
      '@qwen-code/acp-bridge/status': path.resolve(
        __dirname,
        '../acp-bridge/src/status.ts',
      ),
      '@qwen-code/acp-bridge/bridge': path.resolve(
        __dirname,
        '../acp-bridge/src/bridge.ts',
      ),
      '@qwen-code/acp-bridge/spawnChannel': path.resolve(
        __dirname,
        '../acp-bridge/src/spawnChannel.ts',
      ),
      '@qwen-code/acp-bridge/bridgeClient': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeClient.ts',
      ),
      '@qwen-code/acp-bridge/bridgeOptions': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeOptions.ts',
      ),
      '@qwen-code/acp-bridge/bridgeTypes': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeTypes.ts',
      ),
      '@qwen-code/acp-bridge/bridgeFileSystem': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeFileSystem.ts',
      ),
      '@qwen-code/acp-bridge/workspacePaths': path.resolve(
        __dirname,
        '../acp-bridge/src/workspacePaths.ts',
      ),
      '@qwen-code/audio-capture': path.resolve(
        __dirname,
        '../audio-capture/src/index.ts',
      ),
    },
  },
  test: {
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)', 'config.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/cypress/**'],
    environment: 'jsdom',
    globals: true,
    reporters: ['default', 'junit'],
    silent: true,
    outputFile: {
      junit: 'junit.xml',
    },
    setupFiles: ['./test-setup.ts'],
    coverage: {
      enabled: true,
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*'],
      reporter: [
        ['text', { file: 'full-text-summary.txt' }],
        'html',
        'json',
        'lcov',
        'cobertura',
        ['json-summary', { outputFile: 'coverage-summary.json' }],
      ],
    },
    poolOptions: {
      threads: {
        minThreads: 8,
        maxThreads: 16,
      },
    },
    server: {
      deps: {
        inline: [/@qwen-code\/qwen-code-core/],
      },
    },
  },
});
