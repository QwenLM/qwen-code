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
      '@qwen-code/qwen-code-core/noFollowOpen': path.resolve(
        __dirname,
        '../core/src/utils/no-follow-open.ts',
      ),
      '@qwen-code/qwen-code-core/subSessionConstants': path.resolve(
        __dirname,
        '../core/src/tools/sub-session-constants.ts',
      ),
      '@qwen-code/qwen-code-core/goalWire': path.resolve(
        __dirname,
        '../core/src/goals/goal-wire.ts',
      ),
      '@qwen-code/qwen-code-core/transcriptRecords': path.resolve(
        __dirname,
        '../core/src/utils/transcript-records.ts',
      ),
      '@qwen-code/qwen-code-core/userPromptSubmitContext': path.resolve(
        __dirname,
        '../core/src/hooks/user-prompt-submit-context.ts',
      ),
      '@qwen-code/qwen-code-core/memoryScopes': path.resolve(
        __dirname,
        '../core/src/memory/scopes.ts',
      ),
      '@qwen-code/qwen-code-core/toolWriteOrigin': path.resolve(
        __dirname,
        '../core/src/services/tool-write-origin.ts',
      ),
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
      '@qwen-code/acp-bridge/processRegistry': path.resolve(
        __dirname,
        '../acp-bridge/src/process-registry.ts',
      ),
      '@qwen-code/acp-bridge/daemonMemoryBudget': path.resolve(
        __dirname,
        '../acp-bridge/src/daemon-memory-budget.ts',
      ),
      '@qwen-code/acp-bridge/ndJsonStream': path.resolve(
        __dirname,
        '../acp-bridge/src/ndJsonStream.ts',
      ),
      '@qwen-code/acp-bridge/logRedaction': path.resolve(
        __dirname,
        '../acp-bridge/src/logRedaction.ts',
      ),
      '@qwen-code/acp-bridge/bridgeClient': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeClient.ts',
      ),
      '@qwen-code/acp-bridge/bridgeOptions': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeOptions.ts',
      ),
      '@qwen-code/acp-bridge/promptLedger': path.resolve(
        __dirname,
        '../acp-bridge/src/prompt-ledger.ts',
      ),
      '@qwen-code/acp-bridge/bridgeTypes': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeTypes.ts',
      ),
      '@qwen-code/acp-bridge/bridgeFileSystem': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeFileSystem.ts',
      ),
      '@qwen-code/acp-bridge/sessionArtifacts': path.resolve(
        __dirname,
        '../acp-bridge/src/sessionArtifacts.ts',
      ),
      '@qwen-code/acp-bridge/eventBus': path.resolve(
        __dirname,
        '../acp-bridge/src/eventBus.ts',
      ),
      '@qwen-code/acp-bridge/replayWindowLimits': path.resolve(
        __dirname,
        '../acp-bridge/src/replayWindowLimits.ts',
      ),
      '@qwen-code/acp-bridge/transcriptReplay': path.resolve(
        __dirname,
        '../acp-bridge/src/transcript-replay.ts',
      ),
      '@qwen-code/acp-bridge/workspacePaths': path.resolve(
        __dirname,
        '../acp-bridge/src/workspacePaths.ts',
      ),
      '@qwen-code/acp-bridge/externalToolGuard': path.resolve(
        __dirname,
        '../acp-bridge/src/externalToolGuard.ts',
      ),
      '@qwen-code/audio-capture': path.resolve(
        __dirname,
        '../audio-capture/src/index.ts',
      ),
      '@qwen-code/sdk/daemon/transcript': path.resolve(
        __dirname,
        '../sdk-typescript/src/daemon/transcript.ts',
      ),
      '@qwen-code/sdk/daemon/ui/transcript': path.resolve(
        __dirname,
        '../sdk-typescript/src/daemon/ui/transcript.ts',
      ),
      '@qwen-code/sdk/daemon/types': path.resolve(
        __dirname,
        '../sdk-typescript/src/daemon/types.ts',
      ),
      '@qwen-code/sdk/daemon': path.resolve(
        __dirname,
        '../sdk-typescript/src/daemon/index.ts',
      ),
    },
  },
  test: {
    // See packages/core/vitest.config.ts: raise the per-test ceiling above
    // vitest's 5s default so I/O-bound tests (e.g. the workspace registration
    // store's tempdir round-trip) don't blow it purely under CI contention.
    testTimeout: 15000,
    // ECS hosts run several jobs at once; leave capacity for neighboring jobs.
    maxWorkers: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? '25%'
      : undefined,
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
    // Fail fast with an actionable message when workspace dist/ output or
    // generated files are missing (fresh clone, new worktree, deep clean).
    // See scripts/vitest-global-setup.js and issue #9149.
    // Resolved against this config file (not vitest's root/cwd) so the guard
    // also loads when vitest is launched from elsewhere with --config.
    globalSetup: path.resolve(
      __dirname,
      '../../scripts/vitest-global-setup.js',
    ),
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
    server: {
      deps: {
        inline: [/@qwen-code\/qwen-code-core/],
      },
    },
  },
});
