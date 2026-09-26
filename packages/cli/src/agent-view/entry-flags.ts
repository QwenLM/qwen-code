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

/** The prefix of an attached `--bg=<value>` token. */
export const BACKGROUND_FLAG_ATTACHED_PREFIX = `${BACKGROUND_FLAG}=`;

/**
 * The two words yargs-parser consumes as a space-separated boolean flag's
 * value.
 *
 * Measured against this repo's installed yargs-parser (21.1.1, `bg`
 * declared boolean): `--bg false` parses as `bg: false` with NO positional
 * and `--bg true` as `bg: true` with none, while `--bg FALSE`, `--bg 0`,
 * `--bg off` and `--bg no` all leave `bg: true` and put the word in `_`.
 * Exactly these two lowercase literals are the flag's value.
 *
 * The reader has to agree with that because `--bg` is intercepted before
 * the parser runs. Reading every non-dash word as prompt data meant the
 * unquoted-variable wrapper form `qwen --bg $ENABLED "$TASK"` with
 * ENABLED=false dispatched a real agent on the prompt `false …` and
 * certified it with exit 0 — burning quota on a task the operator had
 * switched off, where the parser itself would have started no session.
 */
export const BACKGROUND_FLAG_OFF_WORD = 'false';
export const BACKGROUND_FLAG_ON_WORD = 'true';
