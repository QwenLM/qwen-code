/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createGlobalCheckerDeps,
  createGlobalCheckerMap,
} from './global-checkers.js';
import { rulesForToolName } from './decision/index.js';

function context(mode: 'default' | 'yolo' = 'default', ask: string[] = []) {
  const rules = { allow: {}, deny: {}, ask: { userSettings: ask } };
  return {
    mode,
    rules,
    rulesForTool: rulesForToolName(rules, 'Read'),
    cwd: '/repo',
    additionalDirectories: [],
    toolUseId: 'probe-test',
  };
}

describe('scene-aware global checker maps', () => {
  const deps = createGlobalCheckerDeps({
    resolve: () => ({ plansDir: '/injected/plans' }),
  });

  it('shares injected paths across main and probe', async () => {
    for (const scene of ['main', 'probe'] as const) {
      const read = createGlobalCheckerMap(scene, deps).get('Read')!;
      expect(
        (await read.check({ file_path: '/injected/plans/draft.md' }, context()))
          .kind,
      ).toBe('allow');
    }
  });

  it('preserves ordinary and explicit ask handling in probe', async () => {
    const read = createGlobalCheckerMap('probe', deps).get('Read')!;
    const input = { file_path: '/outside/file.txt' };
    // A plain outside-workspace ask stays an ask: pre-read callers must be able
    // to let the real write/dialog handle it instead of denying up front.
    expect((await read.check(input, context())).kind).toBe('ask');
    expect((await read.check(input, context('yolo'))).kind).toBe('allow');
    // An explicit ask rule keeps asking; the caller decides how to settle it.
    expect((await read.check(input, context('yolo', ['Read']))).kind).toBe(
      'ask',
    );
  });

  it('retains the existing main-only plugin Read override', async () => {
    const plugins = new Map([
      ['Read', { check: () => ({ kind: 'deny' as const }) }],
    ]);
    const input = { file_path: '/injected/plans/draft.md' };
    expect(
      (
        await createGlobalCheckerMap('main', deps, plugins)
          .get('Read')!
          .check(input, context())
      ).kind,
    ).toBe('deny');
    expect(
      (
        await createGlobalCheckerMap('probe', deps, plugins)
          .get('Read')!
          .check(input, context())
      ).kind,
    ).toBe('allow');
  });
});
