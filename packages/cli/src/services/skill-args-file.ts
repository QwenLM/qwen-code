/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Persist a skill's invocation arguments to a file, so the skill can *read*
// them instead of asking the model to copy them out of the conversation.
//
// The arguments already reach the model: the slash-command loaders append the
// raw invocation to the skill body. But a skill that needs its arguments as
// *data* — to hand to a parser, to a subcommand, to anything deterministic — has
// until now had to ask the model to transcribe them into a file, and a
// transcription is a recall.
//
// It recalls wrong. Dogfooding `/review 6771`, the model wrote `--effort high`
// into the argument file: not the user's argument, but an **example** lifted out
// of the skill's own documentation. The parser did its job perfectly on the input
// it was given, resolved the target as a local review, found a clean working
// tree, and reported "no changes to review". A request to review a pull request
// became a no-op, and nothing anywhere raised an error — the one failure shape
// a review must never have.
//
// So the CLI writes the arguments down at launch, verbatim, before the model has
// any say in it. Nothing to copy, nothing to miscopy.

import { mkdirSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('SKILL_ARGS_FILE');

/** Where a skill finds the arguments it was invoked with. */
export const SKILL_ARGS_DIR = join('.qwen', 'tmp');

/** A component safe to put in a filename. */
function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The current session id, from the environment the CLI exports it to.
 *
 * `Config` sets `QWEN_CODE_SESSION_ID` for the whole process, and a `qwen review
 * submit` subprocess spawned by the skill's shell tool inherits it — so both the
 * loader that writes the args file and the subcommand that reads it derive the
 * same path from the same id, with no model input in between. Empty string when
 * unset (a bare `node dist/cli.js`), which simply means one un-scoped file.
 */
export function currentSessionId(): string {
  return process.env['QWEN_CODE_SESSION_ID']?.trim() ?? '';
}

/**
 * Path of the args file for `skillName` in this session.
 *
 * **Scoped to the session**, not just the skill. A fixed per-skill name was
 * forgeable and stale-prone: any file at a predictable path authorised a post,
 * two concurrent reviews in one workspace raced last-writer-wins, and a bare
 * invocation left a previous run's file behind to speak for this one. Keying on
 * the session id — which the model cannot choose and cannot see — ties the record
 * to the run that wrote it. Per-skill within that, so two skills in one session
 * cannot read each other's arguments. Sanitised because both halves become a
 * filename.
 */
export function skillArgsPath(
  skillName: string,
  sessionId: string = currentSessionId(),
): string {
  const scope = sessionId ? `${safe(sessionId)}-` : '';
  return join(SKILL_ARGS_DIR, `qwen-skill-args-${scope}${safe(skillName)}.txt`);
}

/**
 * Write a skill's raw arguments to its args file. Returns the path, or null if
 * the write failed.
 *
 * **Never throws.** A read-only checkout, a full disk, a sandbox with no write
 * access — none of those should stop a skill from running. The skill degrades to
 * what it did before this existed (the model reads the arguments from the
 * conversation), which is worse but not broken, so a failure here is logged and
 * swallowed rather than taking the invocation down with it.
 */
export function writeSkillArgs(skillName: string, args: string): string | null {
  const path = skillArgsPath(skillName);
  try {
    mkdirSync(SKILL_ARGS_DIR, { recursive: true });
    // `O_NOFOLLOW`, so a symlink planted at this path is an error, not a write
    // through it — a reproduction overwrote an arbitrary user-writable file that
    // way. `O_TRUNC` because a bare invocation leaves no file, so a stale one
    // from a previous run must not survive to authorise this one. Mode 0600:
    // arguments can carry a token, and the default 0644 makes them world-read.
    //
    // Verbatim otherwise. No trailing newline, no trimming, no shell quoting:
    // the file is the argument string, byte for byte.
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, args, null, 'utf8');
    } finally {
      closeSync(fd);
    }
    return path;
  } catch (err) {
    debugLogger.warn(
      `Could not write skill args to ${path}: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * The note appended to the skill body telling it where its arguments are.
 *
 * The arguments themselves are still appended to the prompt by the caller — a
 * skill that only needs to *read* them should not have to open a file. This adds
 * the path for the skills that need them as data.
 */
export function skillArgsNote(path: string, args: string): string {
  return (
    `\n\nYour invocation arguments have been written verbatim to \`${path}\`. ` +
    `Use that file when you need them as data (piping them to a parser, for ` +
    `instance) — read it or redirect from it rather than retyping the ` +
    `arguments, which is how they get mistyped.\n` +
    `<skill-args>${args}</skill-args>\n`
  );
}
