/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { isActive } from './process.js';
import type { RunCommand, CommandResult } from './exec.js';

function stub(state: string, code = state === 'active' ? 0 : 3): RunCommand {
  return async (): Promise<CommandResult> => ({
    code,
    stdout: `${state}\n`,
    stderr: '',
  });
}

describe('isActive', () => {
  it('is true for "active"', async () => {
    expect(await isActive(stub('active'), 'qwen-rc-gateway')).toBe(true);
  });

  it('is true for "activating" — a unit systemd accepted but hasn\'t finished starting', async () => {
    // `systemd-run` returning success only means the job was accepted; the
    // unit reads back as "activating" (nonzero exit code) for a beat after.
    // A second `up` during that window must NOT decide the unit is down and
    // re-issue `systemd-run --unit=<name>`, which systemd would refuse as a
    // duplicate — hence "activating" counts as active.
    expect(await isActive(stub('activating'), 'qwen-rc-gateway')).toBe(true);
  });

  it('is false for "inactive"', async () => {
    expect(await isActive(stub('inactive'), 'qwen-rc-gateway')).toBe(false);
  });

  it('is false for "failed"', async () => {
    expect(await isActive(stub('failed'), 'qwen-rc-gateway')).toBe(false);
  });

  it('is false when the command errors out (e.g. no session D-Bus)', async () => {
    const run: RunCommand = async () => ({
      code: 1,
      stdout: '',
      stderr: 'Failed to connect to bus: No such file or directory',
    });
    expect(await isActive(run, 'qwen-rc-gateway')).toBe(false);
  });
});
