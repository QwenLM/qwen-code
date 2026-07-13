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

import {
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  rmSync,
  lstatSync,
  existsSync,
  constants,
} from 'node:fs';
import { join } from 'node:path';
import { createDebugLogger, sessionIdContext } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('SKILL_ARGS_FILE');

/** Where a skill finds the arguments it was invoked with. */
export const SKILL_ARGS_DIR = join('.qwen', 'tmp');

/** A component safe to put in a filename. */
function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The current session id.
 *
 * Prefers the async-local `sessionIdContext` over the process-global
 * `QWEN_CODE_SESSION_ID`, and in that order for a reason: in daemon mode a single
 * process serves many sessions, the env var holds whichever `Config` booted
 * first, and each turn binds its own session through `sessionIdContext.run(...)`.
 * Reading only the env would make a later session write under the first
 * session's name while `submit` — a subprocess whose shell env the daemon sets
 * from the async-local value (see `getShellContextEnvVars`) — reads a different
 * one. Both sides must agree, so both read the same context first.
 *
 * Empty string when neither is set (a bare `node dist/cli.js`), which just means
 * one un-scoped directory.
 */
export function currentSessionId(): string {
  return (
    sessionIdContext.getStore()?.trim() ||
    process.env['QWEN_CODE_SESSION_ID']?.trim() ||
    ''
  );
}

/**
 * Directory holding this session's skill-args files.
 *
 * The session scope lives in the **directory**, not the filename, so the file is
 * always `qwen-skill-args-<skill>.txt` — a stable name the skill prompt and the
 * cleanup step can reference without knowing the session id. A concurrent review
 * in another session writes into a different directory, so the two do not race,
 * and a stale file from an earlier session sits under that session's directory
 * where this run never looks.
 */
export function skillArgsDir(sessionId: string = currentSessionId()): string {
  return sessionId
    ? join(SKILL_ARGS_DIR, `s-${safe(sessionId)}`)
    : SKILL_ARGS_DIR;
}

/**
 * Path of the args file for `skillName` in this session.
 *
 * Session-scoped by its directory (see `skillArgsDir`). Per-skill within that,
 * so two skills in one session cannot read each other's arguments. Sanitised
 * because the skill name becomes a filename: `../../etc/passwd` must not choose
 * where the CLI writes.
 */
export function skillArgsPath(
  skillName: string,
  sessionId: string = currentSessionId(),
): string {
  return join(
    skillArgsDir(sessionId),
    `qwen-skill-args-${safe(skillName)}.txt`,
  );
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
    const dir = skillArgsDir();
    mkdirSync(dir, { recursive: true });
    // `O_NOFOLLOW` protects the final filename, but not the parent: a symlinked
    // `s-<session>` directory — `s-attacker -> victim/` — redirects the write
    // into `victim/qwen-skill-args-review.txt`, truncating an arbitrary
    // user-writable file and leaving its 0644 mode to expose the raw arguments.
    // Refuse a session directory that is a symlink; `mkdirSync(recursive)` above
    // is a no-op on an existing one, so this is the only place to catch it.
    if (lstatSync(dir).isSymbolicLink()) {
      debugLogger.warn(
        `Skill args directory ${dir} is a symlink; refusing to write through it.`,
      );
      return null;
    }
    // `O_NOFOLLOW`, so a symlink planted at this path is an error, not a write
    // through it. `O_TRUNC` because a bare invocation leaves no file, so a stale
    // one from a previous run must not survive to authorise this one. Mode 0600:
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
      // `writeSync` can write fewer bytes than it was given and return the count
      // — a short write leaves a truncated argument record that both loaders then
      // advertise as authoritative, so a parser could pick the wrong review
      // target or lose `--comment`. Loop until every byte is on disk.
      const buf = Buffer.from(args, 'utf8');
      let off = 0;
      while (off < buf.length) {
        off += writeSync(fd, buf, off, buf.length - off);
      }
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
 * Remove this skill's args file for the session.
 *
 * A bare `/review` records no arguments, so it never calls `writeSkillArgs` — and
 * `O_TRUNC` only truncates a file that is being written. Without this, an
 * argument-bearing `/review 6771 --comment` followed by a bare `/review` in the
 * same session leaves the authorised record intact, and the later run reuses the
 * earlier one's posting authority. The bare path calls this to erase it.
 *
 * Returns true when the record is gone, false when it could not be removed —
 * the caller must treat false as "authority not revoked", not proceed as if it
 * were. Never throws.
 */
export function clearSkillArgs(skillName: string): boolean {
  const path = skillArgsPath(skillName);
  try {
    rmSync(path, { force: true });
  } catch (err) {
    // This is a *revocation* — a bare invocation erasing a prior run's posting
    // authority. Swallowing a failure here leaves the authorised record on disk
    // for `submit` to trust, so the caller must know it did not happen: return
    // false, and the loader surfaces it rather than proceeding as if revoked.
    debugLogger.warn(
      `Could not clear skill args for ${skillName}: ${(err as Error).message}`,
    );
    return false;
  }
  // `rmSync(force)` does not report whether anything was there, and a stale file
  // that survives is the whole risk — confirm it is gone.
  if (existsSync(path)) {
    debugLogger.warn(`Skill args for ${skillName} survived removal at ${path}`);
    return false;
  }
  return true;
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
    `\n\nYour invocation arguments have been written verbatim to a session-` +
    `private file. Its exact path is below — use it wherever these instructions ` +
    `say to read the args file (e.g. \`< '${path}'\`), and do not retype the ` +
    `arguments, which is how they get mistyped.\n` +
    `<skill-args-file>${path}</skill-args-file>\n` +
    `<skill-args>${args}</skill-args>\n`
  );
}
