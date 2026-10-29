/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeProjectRoot } from './approval-project-root.js';
import {
  HOOK_APPROVALS_FILENAME,
  loadHookApprovals,
} from './hook-approvals.js';

const platform = vi.hoisted(() => ({ value: 'linux' as NodeJS.Platform }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: () => platform.value };
});

describe('normalizeProjectRoot', () => {
  afterEach(() => {
    platform.value = 'linux';
  });

  it.each([
    ['win32', true],
    ['linux', false],
    ['darwin', false],
  ] as const)('on %s folds case: %s', (os, folds) => {
    platform.value = os;
    const root = path.resolve('/Work/Repo');
    expect(normalizeProjectRoot(root)).toBe(folds ? root.toLowerCase() : root);
  });
});

describe('hook approvals across project-root casing', () => {
  let dir: string;
  const hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: './setup.sh' }] }],
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-root-'));
    vi.stubEnv(
      'QWEN_CODE_HOOK_APPROVALS_PATH',
      path.join(dir, HOOK_APPROVALS_FILENAME),
    );
  });

  afterEach(() => {
    platform.value = 'linux';
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['win32', 'approved'],
    ['linux', 'pending'],
  ] as const)(
    'on %s, a decision keyed D:\\project reads back for d:\\project as %s',
    async (os, state) => {
      platform.value = os;
      await loadHookApprovals().setState('D:\\project', hooks, 'approved');
      expect(loadHookApprovals().getState('d:\\project', hooks)).toBe(state);
    },
  );
});
