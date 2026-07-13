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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('SKILL_ARGS_FILE');

/** Where a skill finds the arguments it was invoked with. */
export const SKILL_ARGS_DIR = join('.qwen', 'tmp');

/**
 * Path of the args file for `skillName`.
 *
 * Per-skill, so two skills invoked in one session cannot read each other's
 * arguments. The name is sanitised because it becomes a filename: a skill named
 * `../../etc/passwd` must not be able to choose where the CLI writes.
 */
export function skillArgsPath(skillName: string): string {
  const safe = skillName.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(SKILL_ARGS_DIR, `qwen-skill-args-${safe}.txt`);
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
    // Verbatim. No trailing newline, no trimming, no shell quoting: the file is
    // the argument string, byte for byte, and a parser reading it gets exactly
    // what the user typed.
    writeFileSync(path, args, 'utf8');
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
