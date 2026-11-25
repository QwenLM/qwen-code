/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeFilenamePart } from './fileUtils.js';
import { runLogger } from './runLogger.js';
import { isNodeError } from './errors.js';
import {
  getSubagentTranscriptDir,
  type SubagentArtifactContext,
} from '../services/subagent-transcript.js';

const LOGS_DIR = 'logs';
const TOOL_OUTPUTS_DIR = 'tool-outputs';

export interface SessionArtifactCleanupResult {
  failed: number;
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

async function deleteArtifact(
  description: string,
  operation: () => Promise<void>,
): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return true;
    }
    runLogger.error(`Error deleting ${description}:`, error);
    return false;
  }
}

/**
 * Validates a sessionId and returns a sanitized version.
 * Throws an error if the ID is dangerous (e.g., ".", "..", or empty).
 */
export function validateAndSanitizeSessionId(sessionId: string): string {
  if (!sessionId || sessionId === '.' || sessionId === '..') {
    throw new Error(`Invalid sessionId: ${sessionId}`);
  }
  const sanitized = sanitizeFilenamePart(sessionId);
  if (!sanitized) {
    throw new Error(`Invalid sessionId after sanitization: ${sessionId}`);
  }
  return sanitized;
}

/**
 * Asynchronously deletes activity logs and tool outputs for a specific session ID.
 */
export async function deleteSessionArtifactsAsync(
  sessionId: string,
  tempDir: string,
): Promise<SessionArtifactCleanupResult> {
  try {
    const safeSessionId = validateAndSanitizeSessionId(sessionId);
    const logsDir = path.join(tempDir, LOGS_DIR);
    const logPath = path.join(logsDir, `session-${safeSessionId}.jsonl`);
    const toolOutputsBase = path.join(tempDir, TOOL_OUTPUTS_DIR);
    const toolOutputDir = path.join(
      toolOutputsBase,
      `session-${safeSessionId}`,
    );
    const sessionDir = path.join(tempDir, safeSessionId);

    const outcomes = await Promise.all([
      deleteArtifact(`session log ${logPath}`, () => fs.unlink(logPath)),
      deleteArtifact(`session tool outputs ${toolOutputDir}`, () =>
        fs.rm(toolOutputDir, { recursive: true, force: true }),
      ),
      deleteArtifact(`session directory ${sessionDir}`, () =>
        fs.rm(sessionDir, { recursive: true, force: true }),
      ),
    ]);
    return { failed: outcomes.filter((succeeded) => !succeeded).length };
  } catch (error) {
    runLogger.error(
      `Error deleting session artifacts for ${sessionId}:`,
      error,
    );
    return { failed: 1 };
  }
}

/**
 * Iterates through subagent transcript files and deletes their temp artifacts
 * before deleting the transcript directory itself.
 */
export async function deleteSubagentTranscriptDirAndArtifactsAsync(
  projectRoot: SubagentArtifactContext,
  parentSessionId: string,
  tempDir: string,
): Promise<SessionArtifactCleanupResult> {
  let subagentDir: string | undefined;
  try {
    const safeParentSessionId = validateAndSanitizeSessionId(parentSessionId);
    subagentDir = getSubagentTranscriptDir(projectRoot, safeParentSessionId);
    const projectDir = path.dirname(subagentDir);

    // Safety check to ensure we don't escape the project transcript directory
    if (!subagentDir.startsWith(projectDir + path.sep)) {
      throw new Error(`Dangerous subagent directory path: ${subagentDir}`);
    }

    const files = await fs
      .readdir(subagentDir, { withFileTypes: true })
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return [];
        throw err;
      });

    let failed = 0;
    for (const file of files) {
      if (
        file.isFile() &&
        file.name.startsWith('agent-') &&
        file.name.endsWith('.jsonl')
      ) {
        const agentId = file.name.slice('agent-'.length, -'.jsonl'.length);
        const result = await deleteSessionArtifactsAsync(agentId, tempDir);
        failed += result.failed;
      }
    }

    // Preserve the transcript directory when an artifact failed so a later
    // cleanup can discover and retry the same subagent sessions.
    if (failed > 0) {
      return { failed };
    }

    const removed = await deleteArtifact(
      `subagent transcript directory ${subagentDir}`,
      () => fs.rm(subagentDir!, { recursive: true, force: true }),
    );
    return { failed: removed ? 0 : 1 };
  } catch (error) {
    runLogger.error(
      `Error cleaning up subagents for parent ${parentSessionId}:`,
      error,
    );
    return { failed: 1 };
  }
}
