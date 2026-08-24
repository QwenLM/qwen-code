/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Runs the committed guard suite the way the Windows merge lane executes it
// (win32 + cmd.exe, no Git-Bash markers), so a lane-red defect is caught on
// every platform instead of first going red inside the merge queue. The
// spoof must be in place BEFORE the suite module evaluates its runIf
// conditions, hence the dynamic import, and re-armed before every test
// because the suite's own afterEach restores all mocks.

import os from 'node:os';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const savedEnv: Record<string, string | undefined> = {};
for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
  savedEnv[key] = process.env[key];
}

process.env['QWEN_DAEMON_GUARD_LANE_SPOOF'] = 'win32-cmd';
vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
vi.spyOn(os, 'platform').mockReturnValue('win32');
for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
  delete process.env[key];
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(os, 'platform').mockReturnValue('win32');
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const key of ['MSYSTEM', 'TERM', 'ComSpec'] as const) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  delete process.env['QWEN_DAEMON_GUARD_LANE_SPOOF'];
});

await import('./daemon-git-worktree-guard.test.js');

it('harness premise: the lane resolves to win32/cmd', async () => {
  const { getShellConfiguration } = await import('@qwen-code/qwen-code-core');
  expect(process.platform).toBe('win32');
  expect(os.platform()).toBe('win32');
  expect(getShellConfiguration().shell).toBe('cmd');
});
