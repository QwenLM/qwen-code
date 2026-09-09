/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The argv tokens the CLI entry has to recognize before it parses
 * anything.
 *
 * Their own module because the entry decides on every launch, and every
 * decision must cost nothing when the answer is no: importing the
 * supervisor runtime, the pty-host runtime, or the dispatch path to read
 * one string would put them on the startup path of every `qwen`
 * invocation.
 */
export const INTERNAL_AGENT_VIEW_SUPERVISOR_ARG =
  '--internal-agent-view-supervisor';

/**
 * The flag that names a process the supervisor spawned to BE a session's
 * PTY host. Internal exactly like the supervisor flag: the strict parser
 * rejects it, so the entry must intercept it before parsing.
 */
export const INTERNAL_AGENT_VIEW_PTY_HOST_ARG =
  '--internal-agent-view-pty-host';

/** The flag that asks for a background session. */
export const BACKGROUND_FLAG = '--bg';

// `bg` is declared `type: 'boolean'` in the help surface, so the attached
// spelling has boolean semantics: `--bg=false` / `--bg=0` / `--bg=off` /
// `--bg=no` is how a wrapper (`qwen --bg=$ENABLED "$TASK"`) turns the
// launch OFF, and `--bg=true` / `--bg=1` / `--bg=on` / `--bg=yes` means
// the same as the bare flag. The match is case-insensitive because the
// wrapper spellings that reach a real argv are the capitalized ones a
// `type: 'boolean'` coercion folds away (`--bg=False`, `--bg=True`), and
// the short forms `off`/`no`/`on`/`yes` are what Make/CI/PowerShell
// writers emit. Only these literals are special — every other attached
// value is prompt data, which is the only way to express a prompt that
// starts with a dash (`--bg=-repro`).
const BACKGROUND_FLAG_OFF_VALUES = new Set(['false', '0', 'off', 'no', 'n']);
const BACKGROUND_FLAG_ON_VALUES = new Set(['true', '1', 'on', 'yes', 'y']);

/** The value of an attached `--bg=<value>` token, or undefined. */
function backgroundFlagAttachedValue(token: string): string | undefined {
  return token.startsWith(`${BACKGROUND_FLAG}=`)
    ? token.slice(BACKGROUND_FLAG.length + 1)
    : undefined;
}

/**
 * True when the token asks for a background launch: the bare flag, or an
 * attached value that is not one of the boolean off spellings. A token
 * that is not one is an ordinary argv word — reading `--bg=false` as a
 * launch dispatched a real agent on the prompt `false …` and certified it
 * with exit 0.
 */
export function isBackgroundFlagToken(token: string): boolean {
  const attached = backgroundFlagAttachedValue(token);
  if (attached === undefined) {
    return token === BACKGROUND_FLAG;
  }
  return !BACKGROUND_FLAG_OFF_VALUES.has(attached.toLowerCase());
}

/**
 * The prompt word a background-flag token carries, or undefined when it
 * carries none: the bare flag and the boolean on spellings consume no
 * word, while an attached `--bg=<prompt>` carries its prompt inside
 * itself even when that prompt starts with a dash.
 */
export function backgroundFlagPromptWord(token: string): string | undefined {
  const attached = backgroundFlagAttachedValue(token);
  if (
    attached === undefined ||
    BACKGROUND_FLAG_ON_VALUES.has(attached.toLowerCase())
  ) {
    return undefined;
  }
  return attached;
}
