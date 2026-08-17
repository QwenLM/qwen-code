/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');

// The SDK's stop-shape typetest pins (test/unit/daemon-public-surface.test.ts)
// and its type-only-import re-export guards are ENFORCED only by the
// package's `test:ci` tsc fence: compiled under tsconfig.typetest.json,
// which plain `vitest run` never touches. The required ci.yml Test job
// fans `npm run test:ci` out to the workspaces `--if-present` and has no
// separate typecheck step — so reverting the SDK's script to plain
// `vitest run` (a script-alignment sweep, CI debugging) keeps the root
// fan-out green while every shape regression ships: the typetest file
// passes at runtime (expectTypeOf erases) and the CLI duck-types the
// import (R14-19). Pin the fence verbatim, per the repo's
// script-pin precedent (no-ak-integration-ci.test.js).
describe('sdk-typescript typetest CI fence', () => {
  const packageJson = JSON.parse(
    readFileSync(
      path.join(ROOT, 'packages/sdk-typescript/package.json'),
      'utf8',
    ),
  );

  it('keeps the tsc typetest fence in test:ci before vitest', () => {
    expect(packageJson.scripts['test:ci']).toBe(
      'tsc --noEmit -p tsconfig.typetest.json && vitest run',
    );
  });

  it('keeps the tsc typetest fence in typecheck too', () => {
    // The typecheck script is the other consumer a sweep might "align":
    // dropping the typetest project there loses the same guards for
    // anyone running typecheck locally instead of test:ci. Since the
    // upstream/main merge (#9261) typecheck also runs the sibling
    // tsconfig.test-fence.json project over the same typetest file —
    // pin the full dual-fence script so neither project can be dropped
    // silently.
    expect(packageJson.scripts['typecheck']).toBe(
      'tsc --noEmit && tsc --noEmit -p tsconfig.typetest.json && tsc --noEmit -p tsconfig.test-fence.json',
    );
  });

  it('ships the typetest tsconfig the fences reference', () => {
    // A fence pointing at a deleted tsconfig fails the build loudly —
    // but a fence pointing at a config that EXCLUDES the typetest file
    // compiles green and ships. Pin the file's inclusion.
    const typetestConfig = JSON.parse(
      readFileSync(
        path.join(ROOT, 'packages/sdk-typescript/tsconfig.typetest.json'),
        'utf8',
      ),
    );
    const include = typetestConfig.include ?? [];
    const files = typetestConfig.files ?? [];
    const exclude = typetestConfig.exclude ?? [];
    // Pin the EXACT typetest file, not just 'some test/unit entry'
    // (R15-10): pointing include at another test/unit file — or adding
    // daemon-public-surface.test.ts to exclude — would satisfy a loose
    // substring check while the typetest leaves the tsc program, so every
    // shape regression the fence exists to catch (e.g. statePersisted
    // silently dropped from DaemonChannelStopResult) ships green
    // (expectTypeOf erases to no-ops under plain vitest).
    expect([...include, ...files]).toContain(
      'test/unit/daemon-public-surface.test.ts',
    );
    expect(
      exclude.some((entry) =>
        String(entry).includes('daemon-public-surface.test.ts'),
      ),
    ).toBe(false);
  });
});
