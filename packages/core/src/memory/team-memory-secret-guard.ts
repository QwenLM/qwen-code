/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import path from 'node:path';
import { isTeamAutoMemPath, TEAM_AUTO_MEMORY_DIRNAME } from './paths.js';
import { isSubpath, QWEN_DIR } from '../utils/paths.js';
import { scanForSecrets } from './secret-scanner.js';

const debugLogger = createDebugLogger('TEAM_MEMORY_SECRET_GUARD');

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
  return checkTeamMemoryContent(content);
}

/** Only for a no-follow backend that admits paths inside this workspace. */
export function checkWorkspaceTeamMemorySecrets(
  filePath: string,
  content: string,
  workspaceRoot: string,
): string | null {
  if (
    !isSubpath(
      path.join(workspaceRoot, QWEN_DIR, TEAM_AUTO_MEMORY_DIRNAME),
      path.resolve(filePath),
    )
  )
    return null;
  return checkTeamMemoryContent(content);
}

function checkTeamMemoryContent(content: string): string | null {
  const matches = scanForSecrets(content);
  if (matches.length === 0) {
    return null;
  }
  // Rule IDs only — never the matched content, which is the secret itself.
  debugLogger.debug(
    `Blocked team-memory write; matched rules: ${matches
      .map((m) => m.ruleId)
      .join(', ')}`,
  );
  const labels = matches.map((m) => m.label).join(', ');
  return (
    `Content contains potential secrets (${labels}) and cannot be written to ` +
    `team memory. Team memory is shared with all repository collaborators. ` +
    `Remove the sensitive content and try again.`
  );
}
