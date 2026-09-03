/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'node:path';

const CORE_SRC = path.resolve(__dirname, '../core/src');

// Vite accepts `alias` as an object or as an ordered array of {find,
// replacement}. Only the array form takes a RegExp, and core needs one, so
// the whole map is expressed that way. Order is precedence: the first entry
// whose `find` matches wins.
const toAliases = (map: Record<string, string>) =>
  Object.entries(map).map(([find, replacement]) => ({ find, replacement }));

export default defineConfig({
  resolve: {
    alias: [
      // These four subpaths do not map onto their file names (goalWire lives
      // at goals/goal-wire.ts), so the wildcard below cannot derive them and
      // they have to be matched first.
      ...toAliases({
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
      }),
      // Mirrors the `"@qwen-code/qwen-code-core/*": ["../core/src/*"]` rule in
      // packages/cli/tsconfig.json. esbuild reads that paths block when it
      // bundles, but Vitest does not read tsconfig paths at all, so this file
      // is the only place the mapping exists for a test run and the two have
      // to be kept in sync by hand. Importing a specific core module instead
      // of the package root depends on this entry — without it those
      // specifiers do not resolve under Vitest.
      {
        find: /^@qwen-code\/qwen-code-core\/(.*)$/,
        replacement: `${CORE_SRC}/$1`,
      },
      // The package root is matched exactly. A string `find` also matches
      // `<find>/...`, so spelled as a string this entry would swallow every
      // subpath above and rewrite them to `.../core/index.ts/<subpath>`.
      {
        find: /^@qwen-code\/qwen-code-core$/,
        replacement: path.resolve(__dirname, '../core/index.ts'),
      },
      ...toAliases({
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
      }),
    ],
  },
  test: {
    // See packages/core/vitest.config.ts: raise the per-test ceiling above
    // vitest's 5s default so I/O-bound tests (e.g. the workspace registration
    // store's tempdir round-trip) don't blow it purely under CI contention.
    testTimeout: 15000,
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
