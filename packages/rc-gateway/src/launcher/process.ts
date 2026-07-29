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

export async function isActive(
  run: RunCommand,
  unit: string,
): Promise<boolean> {
  const r = await run(['systemctl', '--user', 'is-active', unit]);
  return r.stdout.trim() === 'active';
}
