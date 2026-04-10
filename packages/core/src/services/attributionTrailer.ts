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
const MAX_NOTE_BYTES = 128 * 1024; // 128 KB – well within Linux's typical 2 MB

/**
 * Escape a string for safe use inside single quotes in a shell command.
 * Replaces each ' with the sequence '\'' (end quote, escaped quote, start quote).
 */
function shellEscapeSingleQuote(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Generate the git notes add command to attach attribution metadata to the
 * most recent commit. Does NOT include a cd prefix — the caller should pass
 * the working directory to the shell executor directly.
 *
 * Returns null if the serialized note exceeds MAX_NOTE_BYTES.
 */
export function buildGitNotesCommand(
  note: CommitAttributionNote,
): string | null {
  const noteJson = JSON.stringify(note);
  if (Buffer.byteLength(noteJson, 'utf-8') > MAX_NOTE_BYTES) {
    return null;
  }
  const escaped = shellEscapeSingleQuote(noteJson);
  return `git notes --ref=${GIT_NOTES_REF} add -f -m '${escaped}' HEAD`;
}

/**
 * Format a human-readable summary of the attribution for logging/display.
 */
export function formatAttributionSummary(note: CommitAttributionNote): string {
  const lines: string[] = [];
  lines.push(
    `AI Attribution: ${note.summary.totalFilesTouched} file(s) touched`,
  );
  lines.push(
    `  Chars added: ${note.summary.totalAiCharsAdded}, removed: ${note.summary.totalAiCharsRemoved}`,
  );

  for (const [filePath, data] of Object.entries(note.files)) {
    const shortPath =
      filePath.length > 60 ? '...' + filePath.slice(-57) : filePath;
    const created = data.aiCreated ? ' [created]' : '';
    lines.push(
      `  ${shortPath}: +${data.aiCharsAdded}/-${data.aiCharsRemoved}${created}`,
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
