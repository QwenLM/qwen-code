/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Per-agent transcript writer for background agents.
 *
 * Subscribes to AgentEventEmitter events and appends human-readable
 * lines to a plain-text file. The model reads this file via read_file
 * to check on a background agent's progress.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentEventType,
  type AgentEventEmitter,
  type AgentToolCallEvent,
  type AgentToolResultEvent,
  type AgentToolOutputUpdateEvent,
  type AgentRoundTextEvent,
  type AgentFinishEvent,
  type AgentStartEvent,
} from '../agents/runtime/agent-events.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('AGENT_TRANSCRIPT');

const MAX_ARG_PREVIEW = 80;
const MAX_PROGRESS_PREVIEW = 200;
// Throttle in-flight tool output updates so streaming tools (e.g.
// run_shell_command) don't spam the transcript with every chunk. One
// progress line per callId every ~2s keeps the file useful as a
// live-progress window without bloating it.
const PROGRESS_THROTTLE_MS = 2000;

/**
 * Returns the directory where background agent transcript files are stored.
 */
export function getAgentTranscriptDir(projectTempDir: string): string {
  return path.join(projectTempDir, 'agents');
}

/**
 * Returns the full path for a specific agent's transcript file.
 */
export function getAgentTranscriptPath(
  projectTempDir: string,
  agentId: string,
): string {
  // Sanitize agentId to prevent path traversal
  const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getAgentTranscriptDir(projectTempDir), `${safeId}.txt`);
}

/**
 * Truncate a string to maxLen, appending '...' if truncated.
 */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

/**
 * Extract a short, single-line tail preview from a streaming tool's
 * accumulated output. Returns an empty string if the payload isn't a
 * string (structured displays aren't useful as a progress preview).
 */
function formatProgressPreview(outputChunk: unknown): string {
  if (typeof outputChunk !== 'string' || outputChunk.length === 0) return '';
  const tail = outputChunk.slice(-MAX_PROGRESS_PREVIEW);
  return tail.replace(/\s+/g, ' ').trim();
}

/**
 * Format tool call arguments into a compact single-line preview.
 */
function formatArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      // Collapse whitespace (including newlines) before truncating. Tool
      // args like write_file/edit/shell can carry multi-line payloads;
      // without this, a raw newline would split the transcript entry
      // across lines and dump file contents into the progress file.
      const single = value.replace(/\s+/g, ' ').trim();
      parts.push(`${key}="${truncate(single, MAX_ARG_PREVIEW)}"`);
    } else if (value !== undefined && value !== null) {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return parts.join(', ');
}

/**
 * Subscribes to an AgentEventEmitter and writes a plain-text transcript
 * to the given file path. Returns a cleanup function that removes the
 * listeners.
 */
export function attachTranscriptWriter(
  emitter: AgentEventEmitter,
  transcriptPath: string,
): () => void {
  // Ensure the directory exists
  const dir = path.dirname(transcriptPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    debugLogger.warn(`Failed to create transcript directory ${dir}:`, error);
  }

  // Open append-only file descriptor
  let fd: number | null = null;
  try {
    fd = fs.openSync(transcriptPath, 'a');
  } catch (error) {
    debugLogger.warn(
      `Failed to open transcript file ${transcriptPath}:`,
      error,
    );
    return () => {};
  }

  const write = (line: string) => {
    if (fd === null) return;
    try {
      fs.writeSync(fd, line + '\n');
    } catch (error) {
      debugLogger.warn('Failed to write to transcript:', error);
    }
  };

  const onStart = (event: AgentStartEvent) => {
    write(
      `[${new Date(event.timestamp).toISOString()}] Agent started: ${event.name}`,
    );
    if (event.tools.length > 0) {
      write(`  Tools: ${event.tools.join(', ')}`);
    }
  };

  const onToolCall = (event: AgentToolCallEvent) => {
    const argPreview = formatArgs(event.args);
    write(
      `[${new Date(event.timestamp).toISOString()}] Tool call: ${event.name}(${truncate(argPreview, 200)})`,
    );
    if (event.description) {
      write(`  ${event.description}`);
    }
  };

  // Tracks the last progress-line timestamp per in-flight tool callId so we
  // can throttle streaming updates. Cleared when the tool finishes.
  const lastProgressAt = new Map<string, number>();

  const onToolOutputUpdate = (event: AgentToolOutputUpdateEvent) => {
    const now = event.timestamp || Date.now();
    const prev = lastProgressAt.get(event.callId);
    if (prev !== undefined && now - prev < PROGRESS_THROTTLE_MS) return;
    lastProgressAt.set(event.callId, now);

    const preview = formatProgressPreview(event.outputChunk);
    const pidSuffix = event.pid ? ` pid=${event.pid}` : '';
    const previewSuffix = preview
      ? ` — ${truncate(preview, MAX_PROGRESS_PREVIEW)}`
      : '';
    write(
      `[${new Date(now).toISOString()}] Tool progress: callId=${event.callId}${pidSuffix}${previewSuffix}`,
    );
  };

  const onToolResult = (event: AgentToolResultEvent) => {
    lastProgressAt.delete(event.callId);
    const status = event.success ? 'OK' : 'ERROR';
    const duration = event.durationMs ? ` (${event.durationMs}ms)` : '';
    let line = `[${new Date(event.timestamp).toISOString()}] Tool result: ${event.name} → ${status}${duration}`;
    if (event.error) {
      line += ` — ${truncate(event.error, 200)}`;
    }
    write(line);
  };

  const onRoundText = (event: AgentRoundTextEvent) => {
    if (event.text) {
      write(
        `[${new Date(event.timestamp).toISOString()}] Agent response: ${truncate(event.text, 500)}`,
      );
    }
  };

  const onFinish = (event: AgentFinishEvent) => {
    // Clear any orphan throttle entries from tools that never emitted a
    // TOOL_RESULT (abort/crash mid-stream). Without this, lastProgressAt
    // grows for the lifetime of the emitter.
    lastProgressAt.clear();
    write(
      `[${new Date(event.timestamp).toISOString()}] Agent finished: ${event.terminateReason}` +
        (event.rounds ? ` (${event.rounds} rounds)` : '') +
        (event.totalTokens ? `, ${event.totalTokens} tokens` : '') +
        (event.totalToolCalls ? `, ${event.totalToolCalls} tool calls` : ''),
    );
  };

  emitter.on(AgentEventType.START, onStart);
  emitter.on(AgentEventType.TOOL_CALL, onToolCall);
  emitter.on(AgentEventType.TOOL_OUTPUT_UPDATE, onToolOutputUpdate);
  emitter.on(AgentEventType.TOOL_RESULT, onToolResult);
  emitter.on(AgentEventType.ROUND_TEXT, onRoundText);
  emitter.on(AgentEventType.FINISH, onFinish);

  return () => {
    emitter.off(AgentEventType.START, onStart);
    emitter.off(AgentEventType.TOOL_CALL, onToolCall);
    emitter.off(AgentEventType.TOOL_OUTPUT_UPDATE, onToolOutputUpdate);
    emitter.off(AgentEventType.TOOL_RESULT, onToolResult);
    emitter.off(AgentEventType.ROUND_TEXT, onRoundText);
    emitter.off(AgentEventType.FINISH, onFinish);
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
      fd = null;
    }
  };
}
