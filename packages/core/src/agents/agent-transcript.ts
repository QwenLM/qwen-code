/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Per-agent transcript for background subagents.
 *
 * Each background subagent produces two sibling files under
 * `<projectDir>/subagents/<sessionId>/`:
 *
 *   agent-<id>.jsonl       — canonical, ChatRecord-shaped event log;
 *                            the model reads this via read_file to check
 *                            in-flight progress and <output-file> in the
 *                            notification XML points here
 *   agent-<id>.meta.json   — sidecar with agentType, description, parent
 *                            session/agent IDs, createdAt
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AgentEventType,
  type AgentEventEmitter,
  type AgentToolCallEvent,
  type AgentToolResultEvent,
  type AgentRoundTextEvent,
  type AgentExternalMessageEvent,
} from './runtime/agent-events.js';
import { type ChatRecord } from '../services/chatRecordingService.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('AGENT_TRANSCRIPT');

function sanitizeFilenameComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Returns the directory holding all subagent transcripts for a given session.
 * Layout: `<projectDir>/subagents/<sessionId>/`.
 */
export function getSubagentSessionDir(
  projectDir: string,
  sessionId: string,
): string {
  // Sanitize sessionId defensively (UUIDs are safe; resumed/external IDs
  // could carry path-traversal bytes).
  return path.join(
    projectDir,
    'subagents',
    sanitizeFilenameComponent(sessionId),
  );
}

/** Returns the canonical JSONL transcript path. */
export function getAgentJsonlPath(
  projectDir: string,
  sessionId: string,
  agentId: string,
): string {
  return path.join(
    getSubagentSessionDir(projectDir, sessionId),
    `agent-${sanitizeFilenameComponent(agentId)}.jsonl`,
  );
}

/** Returns the sidecar metadata file path. */
export function getAgentMetaPath(
  projectDir: string,
  sessionId: string,
  agentId: string,
): string {
  return path.join(
    getSubagentSessionDir(projectDir, sessionId),
    `agent-${sanitizeFilenameComponent(agentId)}.meta.json`,
  );
}

export interface AgentMeta {
  agentId: string;
  agentType: string;
  description: string;
  /** SessionId of the user session that launched this agent. */
  parentSessionId: string;
  /** AgentId of the launching subagent for nested forks; null for top-level. */
  parentAgentId: string | null;
  /** ISO 8601 creation time. */
  createdAt: string;
}

/**
 * Best-effort — a failed sidecar write must not break the agent launch path.
 */
export function writeAgentMeta(metaPath: string, meta: AgentMeta): void {
  try {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  } catch (error) {
    debugLogger.warn(`Failed to write agent meta sidecar ${metaPath}:`, error);
  }
}

export interface AttachJsonlOptions {
  /** Subagent identifier — populated on every record. */
  agentId: string;
  /** Display name (subagent type), e.g. "explore". */
  agentName?: string;
  /** UI hint. */
  agentColor?: string;
  /** Parent user-session UUID — recorded as `sessionId` on every record. */
  sessionId: string;
  /** cwd at launch time, for resume context. */
  cwd: string;
  /** CLI version for compatibility tracking. */
  version: string;
  /** Optional git branch at launch time. */
  gitBranch?: string;
  /**
   * Launching prompt — recorded as the first `user`-role record so the
   * transcript is self-describing. Empty/omitted seeds nothing.
   */
  initialUserPrompt?: string;
}

export interface AttachJsonlTranscriptResult {
  /** Removes the event listeners and closes the file handle. Idempotent. */
  cleanup: () => void;
}

/**
 * Subscribes to an AgentEventEmitter and appends ChatRecord-shaped JSONL
 * lines to `jsonlPath`. Maintains a parentUuid chain so consumers can walk
 * the transcript tree the same way they walk the main session log.
 *
 * Holds a single append-mode fd for the lifetime of the writer so streaming
 * tools (which can fire many TOOL_CALL/TOOL_RESULT events per round) avoid
 * an open+write+close syscall storm. The fd is opened lazily on the first
 * write so callers that attach but never produce a record don't materialize
 * an empty file.
 */
export function attachJsonlTranscriptWriter(
  emitter: AgentEventEmitter,
  jsonlPath: string,
  options: AttachJsonlOptions,
): AttachJsonlTranscriptResult {
  let lastUuid: string | null = null;
  let fd: number | null = null;
  let openFailed = false;

  const ensureOpen = (): boolean => {
    if (fd !== null) return true;
    if (openFailed) return false;
    try {
      fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
      fd = fs.openSync(jsonlPath, 'a');
      return true;
    } catch (error) {
      debugLogger.warn(`Failed to open JSONL transcript ${jsonlPath}:`, error);
      openFailed = true;
      return false;
    }
  };

  const baseFields = (type: ChatRecord['type']) => ({
    uuid: randomUUID(),
    parentUuid: lastUuid,
    sessionId: options.sessionId,
    timestamp: new Date().toISOString(),
    type,
    cwd: options.cwd,
    version: options.version,
    gitBranch: options.gitBranch,
    agentId: options.agentId,
    agentName: options.agentName,
    agentColor: options.agentColor,
    isSidechain: true,
  });

  const append = (record: ChatRecord) => {
    if (!ensureOpen()) return;
    try {
      fs.writeSync(fd!, JSON.stringify(record) + '\n');
      lastUuid = record.uuid;
    } catch (error) {
      debugLogger.warn(`Failed to append JSONL record to ${jsonlPath}:`, error);
    }
  };

  const onRoundText = (event: AgentRoundTextEvent) => {
    if (!event.text) return;
    append({
      ...baseFields('assistant'),
      message: { role: 'model', parts: [{ text: event.text }] },
    });
  };

  const onToolCall = (event: AgentToolCallEvent) => {
    append({
      ...baseFields('assistant'),
      message: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: event.callId,
              name: event.name,
              args: event.args,
            },
          },
        ],
      },
    });
  };

  const onToolResult = (event: AgentToolResultEvent) => {
    // Prefer the real response parts the model saw; fall back to a status
    // stub only when the agent aborted before a response was formed.
    const parts = event.responseParts ?? [
      {
        functionResponse: {
          id: event.callId,
          name: event.name,
          response: {
            success: event.success,
            ...(event.error ? { error: event.error } : {}),
          },
        },
      },
    ];
    append({
      ...baseFields('tool_result'),
      message: { role: 'user', parts },
      toolCallResult: {
        callId: event.callId,
        ...(event.durationMs !== undefined
          ? { durationMs: event.durationMs }
          : {}),
      },
    });
  };

  const recordUserMessage = (text: string) => {
    if (!text) return;
    append({
      ...baseFields('user'),
      message: { role: 'user', parts: [{ text }] },
    });
  };

  const onExternalMessage = (event: AgentExternalMessageEvent) => {
    recordUserMessage(event.text);
  };

  if (options.initialUserPrompt) {
    recordUserMessage(options.initialUserPrompt);
  }

  emitter.on(AgentEventType.ROUND_TEXT, onRoundText);
  emitter.on(AgentEventType.TOOL_CALL, onToolCall);
  emitter.on(AgentEventType.TOOL_RESULT, onToolResult);
  emitter.on(AgentEventType.EXTERNAL_MESSAGE, onExternalMessage);

  const cleanup = () => {
    emitter.off(AgentEventType.ROUND_TEXT, onRoundText);
    emitter.off(AgentEventType.TOOL_CALL, onToolCall);
    emitter.off(AgentEventType.TOOL_RESULT, onToolResult);
    emitter.off(AgentEventType.EXTERNAL_MESSAGE, onExternalMessage);
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
      fd = null;
    }
  };

  return { cleanup };
}
