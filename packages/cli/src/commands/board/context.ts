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

export const BOARD_ENV = 'QWEN_BOARD';
export const PARTICIPANT_ENV = 'QWEN_BOARD_AS';

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
  const explicit = opts.board || env[BOARD_ENV];
  if (explicit) return explicit;
  return slugify(path.basename(opts.cwd ?? process.cwd()));
}

/**
 * The name this process writes as. Not an identity claim that anything
 * verifies — the board records who wrote what, and the trust boundary is the
 * uid that owns the directory, not the string in this field.
 */
export function resolveParticipantName(opts: BoardContextOptions = {}): string {
  const env = opts.env ?? process.env;
  const explicit = opts.as || env[PARTICIPANT_ENV];
  if (explicit) return explicit;
  return slugify(`${os.userInfo().username}-${process.pid}`);
}
