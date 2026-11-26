/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  writeToStderr,
  writeToStdout,
  type Config,
} from '@qwen-code/core';
import {
  formatRelativeTime,
  SessionError,
  SessionSelector,
} from './sessionUtils.js';
import { deleteSessionTranscript } from './sessionTranscriptDeletion.js';

function truncateTitle(name: string, maxLength = 100): string {
  return name.length > maxLength ? name.slice(0, maxLength - 3) + '...' : name;
}

export async function listSessions(config: Config): Promise<void> {
  const sessionSelector = new SessionSelector(config);
  const sessions = await sessionSelector.listSessions();

  if (sessions.length === 0) {
    writeToStdout('No previous sessions found for this project.');
    return;
  }

  writeToStdout(
    `\nAvailable sessions for this project (${sessions.length}):\n`,
  );

  sessions.forEach((session) => {
    const current = session.isCurrentSession ? ', current' : '';
    const time = formatRelativeTime(session.lastUpdated);
    const title = truncateTitle(session.displayName);
    writeToStdout(
      `  ${session.index}. ${title} (${time}${current}) [${session.id}]\n`,
    );
  });
}

export async function deleteSession(
  config: Config,
  identifier: string,
): Promise<void> {
  const sessionSelector = new SessionSelector(config);

  let sessionToDelete;
  try {
    sessionToDelete = await sessionSelector.findSession(identifier);
  } catch (error) {
    if (error instanceof SessionError) {
      writeToStderr(error.message);
    } else {
      writeToStderr(
        `Failed to find session: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
    return;
  }

  // Prevent deleting the current session
  if (sessionToDelete.isCurrentSession) {
    writeToStderr('Cannot delete the current active session.');
    return;
  }

  try {
    if (!sessionToDelete.sessionPath) {
      throw new Error(`Missing session path for session ${sessionToDelete.id}`);
    }
    await deleteSessionTranscript({
      transcriptStore: config.getTranscriptStore(),
      sessionPath: sessionToDelete.sessionPath,
      sessionId: sessionToDelete.id,
      sessionArtifactProjectRoot:
        sessionToDelete.transcriptProjectRoot ??
        config.getSessionArtifactProjectRoot(),
      ...(sessionToDelete.worktreeSession !== undefined
        ? { worktreeSession: sessionToDelete.worktreeSession }
        : {}),
    });

    const time = formatRelativeTime(sessionToDelete.lastUpdated);
    const title = truncateTitle(sessionToDelete.displayName);
    writeToStdout(
      `Deleted session ${sessionToDelete.index}: ${title} (${time})`,
    );
  } catch (error) {
    writeToStderr(
      `Failed to delete session: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
