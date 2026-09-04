/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Attribution Trailer Utility
 *
 * Generates git notes commands for storing per-file AI attribution metadata
 * on commits. This keeps the commit message clean (only Co-Authored-By trailer)
 * while storing detailed contribution data in git notes.
 */

import type { CommitAttributionNote } from './commitAttribution.js';

const GIT_NOTES_REF = 'refs/notes/ai-attribution';

/**
 * Maximum byte length for the JSON note. Sized for the most
 * restrictive ARG_MAX in the wild: Windows' `CreateProcess`
 * lpCommandLine is capped around 32,768 UTF-16 chars including the
 * git executable path, the other argv entries, and separators, so
 * the note itself has to fit in that minus a safety margin (~2 KB)
 * for everything else. Linux/macOS ARG_MAX is much larger; sizing
 * for Windows just means we cap earlier on those platforms — the
 * note is meant to be small metadata, not a payload, so the limit
 * is rarely the binding constraint.
 */
const MAX_NOTE_BYTES = 30 * 1024; // 30 KB

/**
 * argv-form git notes invocation, designed for `child_process.execFile`.
 *
 * We return argv rather than a shell-quoted command string because the JSON
 * note travels as a separate argv entry — no shell quoting is needed and no
 * shell metacharacters can be re-evaluated. This matters most on Windows
 * where bash-style single-quote escaping (`'\''`) is invalid and would
 * corrupt the note (or, worse, allow interpolation under PowerShell/cmd).
 */
export interface GitNotesCommand {
  command: string;
  args: string[];
}

/**
 * Build the git notes add invocation to attach attribution metadata to a
 * specific commit. `targetCommit` MUST be the SHA the caller captured
 * after detecting the commit's HEAD movement — passing the symbolic
 * `'HEAD'` opens a TOCTOU window where a post-commit hook, a chained
 * `git commit && git tag -m ...`, or a parallel process can advance
 * HEAD between capture and exec, and `-f` would silently overwrite the
 * note on the wrong commit.
 *
 * Caller should pass the result to a process-spawning API
 * (`child_process.execFile`) along with a `cwd` option.
 *
 * Returns null if the serialized note exceeds MAX_NOTE_BYTES.
 */
export function buildGitNotesCommand(
  note: CommitAttributionNote,
  targetCommit: string,
): GitNotesCommand | null {
  const noteJson = JSON.stringify(note);
  if (Buffer.byteLength(noteJson, 'utf-8') > MAX_NOTE_BYTES) {
    return null;
  }
  return {
    command: 'git',
    args: [
      'notes',
      `--ref=${GIT_NOTES_REF}`,
      'add',
      '-f',
      '-m',
      noteJson,
      targetCommit,
    ],
  };
}
