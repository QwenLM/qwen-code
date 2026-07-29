/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandResult, RunCommand } from './exec.js';

/** Start `argv` as a systemd user transient unit (survives the invoking shell). */
export function startUnit(
  run: RunCommand,
  unit: string,
  argv: string[],
): Promise<CommandResult> {
  return run([
    'systemd-run',
    '--user',
    `--unit=${unit}`,
    '--collect',
    '--',
    ...argv,
  ]);
}

export function stopUnit(
  run: RunCommand,
  unit: string,
): Promise<CommandResult> {
  return run(['systemctl', '--user', 'stop', unit]);
}

/**
 * `systemctl --user is-active` prints `activating` (with a nonzero exit
 * code) for a unit that has been accepted by systemd but hasn't finished
 * starting yet. Treating that as "not active" makes `up` re-issue
 * `systemd-run --unit=<name>` for a unit still coming up; systemd then
 * refuses the duplicate name and `up` reports a spurious failure. Both
 * `active` and `activating` count as "already active" here.
 */
export async function isActive(
  run: RunCommand,
  unit: string,
): Promise<boolean> {
  const r = await run(['systemctl', '--user', 'is-active', unit]);
  const state = r.stdout.trim();
  return state === 'active' || state === 'activating';
}
