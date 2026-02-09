/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExportSessionData } from '../types.js';

/**
 * Converts ExportSessionData to JSONL (JSON Lines) format.
 * Each message is output as a separate JSON object on its own line.
 */
export function toJsonl(sessionData: ExportSessionData): string {
  const lines: string[] = [];

  // Add session metadata as the first line
  lines.push(
    JSON.stringify({
      type: 'session_metadata',
      sessionId: sessionData.sessionId,
      startTime: sessionData.startTime,
    }),
  );

  // Add each message as a separate line
  for (const message of sessionData.messages) {
    lines.push(JSON.stringify(message));
  }

  return lines.join('\n');
}
