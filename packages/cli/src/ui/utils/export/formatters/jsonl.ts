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
  const sourceMetadata = sessionData.metadata;

  // Add session metadata as the first line
  const metadata: Record<string, unknown> = {
    type: 'session_metadata',
    sessionId: sessionData.sessionId,
    startTime: sessionData.startTime,
  };

  // Add all metadata fields if available
  if (sourceMetadata?.exportTime) {
    metadata['exportTime'] = sourceMetadata.exportTime;
  }
  if (sourceMetadata?.cwd) {
    metadata['cwd'] = sourceMetadata.cwd;
  }
  if (sourceMetadata?.gitRepo) {
    metadata['gitRepo'] = sourceMetadata.gitRepo;
  }
  if (sourceMetadata?.gitBranch) {
    metadata['gitBranch'] = sourceMetadata.gitBranch;
  }
  if (sourceMetadata?.model) {
    metadata['model'] = sourceMetadata.model;
  }
  if (sourceMetadata?.channel) {
    metadata['channel'] = sourceMetadata.channel;
  }
  if (sourceMetadata?.promptCount !== undefined) {
    metadata['promptCount'] = sourceMetadata.promptCount;
  }
  if (sourceMetadata?.contextUsagePercent !== undefined) {
    metadata['contextUsagePercent'] = sourceMetadata.contextUsagePercent;
  }
  if (sourceMetadata?.contextWindowSize !== undefined) {
    metadata['contextWindowSize'] = sourceMetadata.contextWindowSize;
  }
  if (sourceMetadata?.totalTokens !== undefined) {
    metadata['totalTokens'] = sourceMetadata.totalTokens;
  }
  if (sourceMetadata?.filesRead !== undefined) {
    metadata['filesRead'] = sourceMetadata.filesRead;
  }
  if (sourceMetadata?.filesWritten !== undefined) {
    metadata['filesWritten'] = sourceMetadata.filesWritten;
  }
  if (sourceMetadata?.linesAdded !== undefined) {
    metadata['linesAdded'] = sourceMetadata.linesAdded;
  }
  if (sourceMetadata?.linesRemoved !== undefined) {
    metadata['linesRemoved'] = sourceMetadata.linesRemoved;
  }
  if (sourceMetadata?.uniqueFiles && sourceMetadata.uniqueFiles.length > 0) {
    metadata['uniqueFiles'] = sourceMetadata.uniqueFiles;
  }
  if (sourceMetadata?.requestId) {
    metadata['requestId'] = sourceMetadata.requestId;
  }

  lines.push(JSON.stringify(metadata));

  // Add each message as a separate line
  for (const message of sessionData.messages) {
    lines.push(JSON.stringify(message));
  }

  return lines.join('\n');
}
