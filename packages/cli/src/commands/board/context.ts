/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Board and participant resolution for the `qwen board` commands.
 *
 * Both are resolvable without configuration so a foreign agent can run a
 * command with no setup: the board defaults to a name derived from the project
 * directory, and the participant defaults to the process's own session name.
 * An explicit `--board` is what makes the cross-workspace case expressible —
 * two repositories share a board precisely because the board is *not* the
 * directory.
 *
 * Environment variables take precedence over the derived defaults so a pane
 * launched by `qwen fleet up` inherits both without repeating them on every
 * command.
 */

import * as path from 'node:path';
import * as os from 'node:os';

// Re-exported rather than redeclared: the prompt section and the CLI must
// agree on these names, and two copies of a constant is the same failure mode
// the board design exists to avoid.
export {
  BOARD_ENV,
  BOARD_PARTICIPANT_ENV as PARTICIPANT_ENV,
} from '@qwen-code/qwen-code-core';
import {
  BOARD_ENV as BOARD_ENV_NAME,
  BOARD_PARTICIPANT_ENV as PARTICIPANT_ENV_NAME,
} from '@qwen-code/qwen-code-core';

/**
 * Reduce an arbitrary directory name to something the board layout accepts:
 * letters, digits, dot, dash, underscore, starting alphanumeric.
 */
function slugify(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64);
  return cleaned || 'board';
}

export interface BoardContextOptions {
  board?: string;
  as?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveBoardName(opts: BoardContextOptions = {}): string {
  const env = opts.env ?? process.env;
  const explicit = opts.board || env[BOARD_ENV_NAME];
  if (explicit) return explicit;
  return slugify(path.basename(opts.cwd ?? process.cwd()));
}

/**
 * The name this process writes as. Not an identity claim that anything
 * verifies — the board records who wrote what, and the trust boundary is the
 * uid that owns the directory, not the string in this field.
 *
 * The fallback deliberately excludes the pid. Every `qwen board …` is a fresh
 * process, so a pid-based default would make `claim` and `done` on the same
 * task come from two different participants, and an ask addressed to the name
 * a peer used last time could never be found. A stable per-user default keeps
 * a single agent coherent across invocations; two agents sharing an account
 * collide visibly on the board and are separated with `--as`, which
 * `fleet up` always sets.
 */
export function resolveParticipantName(opts: BoardContextOptions = {}): string {
  const env = opts.env ?? process.env;
  const explicit = opts.as || env[PARTICIPANT_ENV_NAME];
  if (explicit) return explicit;
  let username: string | undefined;
  try {
    username = os.userInfo().username;
  } catch {
    // `os.userInfo()` throws SystemError when the effective uid has no passwd
    // entry (containers, root). Fall back to the environment before a generic
    // name so a stable per-user default still holds where the env is set.
    username = env.USER ?? env.LOGNAME;
  }
  return slugify(username ?? 'user');
}

/**
 * Whether this invocation is a person at a terminal, as opposed to an agent
 * shelling out.
 *
 * `decision` exists because approval, acceptance and adjudication need
 * authority no agent holds. Until now that was a sentence in the prompt, on a
 * command line agents use for everything else — so anything with a shell could
 * approve its own request. This is the cheapest structural difference
 * available: an agent's tool call captures stdout, a person's terminal does
 * not.
 *
 * It is a barrier, not a proof. An agent that allocated a pty would pass, and
 * `--force` bypasses it outright for scripting. Both are fine: the threat here
 * is a model taking the path of least resistance, not one working to defeat a
 * check. What matters is that resolving is no longer the easiest thing to do.
 */
export function isInteractiveInvocation(
  stdout: { isTTY?: boolean } = process.stdout,
  stdin: { isTTY?: boolean } = process.stdin,
): boolean {
  return Boolean(stdout.isTTY) && Boolean(stdin.isTTY);
}
