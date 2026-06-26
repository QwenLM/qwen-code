/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isTeamAutoMemPath } from './paths.js';
import { scanForSecrets } from './secret-scanner.js';

/**
 * Guards writes to team memory against leaking credentials. Team memory is
 * committed to the repo and shared with every collaborator, so any write that
 * targets the team directory and contains a detected secret is rejected —
 * unconditionally (even if the team tier is otherwise disabled), since the
 * directory is source-controlled regardless.
 *
 * Returns an error message to block the write, or null to allow it. The cheap
 * path check runs first, so non-memory writes pay only a single path compare.
 */
export function checkTeamMemorySecrets(
  filePath: string,
  content: string,
  projectRoot: string,
): string | null {
  if (!isTeamAutoMemPath(filePath, projectRoot)) {
    return null;
  }
  const matches = scanForSecrets(content);
  if (matches.length === 0) {
    return null;
  }
  const labels = matches.map((m) => m.label).join(', ');
  return (
    `Content contains potential secrets (${labels}) and cannot be written to ` +
    `team memory. Team memory is shared with all repository collaborators. ` +
    `Remove the sensitive content and try again.`
  );
}
