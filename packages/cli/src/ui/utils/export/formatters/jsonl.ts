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
  const metadata: Record<string, unknown> = {
    type: 'session_metadata',
    sessionId: sessionData.sessionId,
    startTime: sessionData.startTime,
  };

  // Add requestId if available
  if (sessionData.metadata?.requestId) {
    metadata['requestId'] = sessionData.metadata.requestId;
  }

  lines.push(JSON.stringify(metadata));

  // Add each message as a separate line
  for (const message of sessionData.messages) {
    lines.push(JSON.stringify(message));
  }

  return lines.join('\n');
}
