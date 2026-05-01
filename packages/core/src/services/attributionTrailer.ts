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

/** Maximum byte length for the -m argument to avoid shell ARG_MAX limits. */
const MAX_NOTE_BYTES = 128 * 1024; // 128 KB

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
 * Build the git notes add invocation to attach attribution metadata to the
 * most recent commit. Caller should pass the result to a process-spawning
 * API (`child_process.execFile`) along with a `cwd` option.
 *
 * Returns null if the serialized note exceeds MAX_NOTE_BYTES.
 */
export function buildGitNotesCommand(
  note: CommitAttributionNote,
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
      'HEAD',
    ],
  };
}

/**
 * Format a human-readable summary of the attribution for logging/display.
 */
export function formatAttributionSummary(note: CommitAttributionNote): string {
  const lines: string[] = [];
  lines.push(
    `AI Attribution: ${note.summary.aiPercent}% AI, ${note.summary.totalFilesTouched} file(s)`,
  );
  lines.push(
    `  AI chars: ${note.summary.aiChars}, Human chars: ${note.summary.humanChars}`,
  );

  for (const [filePath, data] of Object.entries(note.files)) {
    const shortPath =
      filePath.length > 60 ? '...' + filePath.slice(-57) : filePath;
    lines.push(
      `  ${shortPath}: ${data.percent}% AI (+${data.aiChars}/${data.humanChars}h)`,
    );
  }

  if (note.excludedGenerated.length > 0) {
    lines.push(
      `  Excluded generated: ${note.excludedGenerated.length} file(s)`,
    );
  }

  return lines.join('\n');
}

/**
 * Get the git notes ref used for AI attribution.
 */
export function getAttributionNotesRef(): string {
  return GIT_NOTES_REF;
}
