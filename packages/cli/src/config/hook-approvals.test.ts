/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HOOK_APPROVALS_FILENAME,
  hashProjectHooks,
  isProjectHooksPendingApproval,
  getProjectHooksApprovalState,
  loadHookApprovals,
  resetHookApprovalsForTesting,
} from './hook-approvals.js';

describe('hook-approvals (hash-bound approval store)', () => {
  let dir: string;
  const projectRoot = '/work/my-repo';
  const hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: './setup.sh' }] }],
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-approvals-'));
    process.env['QWEN_CODE_HOOK_APPROVALS_PATH'] = path.join(
      dir,
      HOOK_APPROVALS_FILENAME,
    );
    resetHookApprovalsForTesting();
  });

  afterEach(() => {
    delete process.env['QWEN_CODE_HOOK_APPROVALS_PATH'];
    resetHookApprovalsForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is pending with no stored decision', () => {
    expect(loadHookApprovals().getState(projectRoot, hooks)).toBe('pending');
  });

  it.each(['approved', 'rejected'] as const)(
    'returns %s after that decision, across a reload',
    async (status) => {
      await loadHookApprovals().setState(projectRoot, hooks, status);
      expect(loadHookApprovals().getState(projectRoot, hooks)).toBe(status);
      resetHookApprovalsForTesting();
      expect(loadHookApprovals().getState(projectRoot, hooks)).toBe(status);
    },
  );

  it('returns to pending once the hooks change', async () => {
    await loadHookApprovals().setState(projectRoot, hooks, 'approved');
    const edited = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'curl evil' }] }],
    };
    expect(loadHookApprovals().getState(projectRoot, edited)).toBe('pending');
  });

  it('hashes independently of key order', () => {
    const a = { PreToolUse: [{ matcher: 'Bash', hooks: [] }], Stop: [] };
    const b = { Stop: [], PreToolUse: [{ hooks: [], matcher: 'Bash' }] };
    expect(hashProjectHooks(a)).toBe(hashProjectHooks(b));
  });

  it('writes one hash-bound record per project with owner-only permissions', async () => {
    await loadHookApprovals().setState(projectRoot, hooks, 'approved');
    const file = path.join(dir, HOOK_APPROVALS_FILENAME);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const key =
      os.platform() === 'win32'
        ? path.resolve(projectRoot).toLowerCase()
        : path.resolve(projectRoot);
    expect(onDisk[key]).toEqual({
      hash: hashProjectHooks(hooks),
      status: 'approved',
    });
    if (os.platform() !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('treats an unreadable file as no decisions', () => {
    fs.writeFileSync(path.join(dir, HOOK_APPROVALS_FILENAME), '[1, 2');
    const approvals = loadHookApprovals();
    expect(approvals.errors).toHaveLength(1);
    expect(approvals.getState(projectRoot, hooks)).toBe('pending');
  });

  describe('isProjectHooksPendingApproval', () => {
    it.each([
      ['no hooks', undefined],
      ['an empty hooks block', {}],
    ])('is false for %s', (_label, value) => {
      expect(getProjectHooksApprovalState(value, projectRoot)).toBeUndefined();
      expect(isProjectHooksPendingApproval(value, projectRoot)).toBe(false);
    });

    it.each([
      [undefined, true],
      ['rejected', true],
      ['approved', false],
    ] as const)('with decision %s is %s', async (decision, expected) => {
      if (decision) {
        await loadHookApprovals().setState(projectRoot, hooks, decision);
      }
      expect(isProjectHooksPendingApproval(hooks, projectRoot)).toBe(expected);
    });
  });
});
