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
import type {
  AgentBootstrapRecordPayload,
  ChatRecord,
} from '../services/chatRecordingService.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { _recoverObjectsFromLine } from '../utils/jsonl-utils.js';
import type { FunctionDeclaration, Content } from '@google/genai';

const debugLogger = createDebugLogger('AGENT_TRANSCRIPT');

function sanitizeFilenameComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Returns the directory holding all subagent transcripts for a given session.
 * Layout: `<projectDir>/subagents/<sessionId>/`.
 *
 * TODO: this path is part of the model-facing contract via `<output-file>` in
 * the task-notification XML. When a second background task kind lands (e.g. a
 * shell pool), migrate to `<projectDir>/tasks/<sessionId>/<kind>-<id>.jsonl`
 * so the namespace generalizes. Update `read-file.ts` auto-allow accordingly.
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
  /**
   * Persisted lifecycle status. Background-resume discovery treats
   * `running` as resumable work that was interrupted by process exit.
   */
  status?: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  /** ISO 8601 timestamp of the latest lifecycle transition. */
  lastUpdatedAt?: string;
  /** Resolved approval mode used when the agent was launched. */
  resolvedApprovalMode?: string;
  /** Canonical subagent config name used to recreate this agent. */
  subagentName?: string;
  /** UI hint preserved for resumed task rows. */
  agentColor?: string;
  /** Number of explicit resume attempts performed so far. */
  resumeCount?: number;
  /** Last terminal error, if any. */
  lastError?: string;
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

export function readAgentMeta(metaPath: string): AgentMeta | undefined {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as AgentMeta;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLogger.warn(`Failed to read agent meta sidecar ${metaPath}:`, error);
    }
    return undefined;
  }
}

export function patchAgentMeta(
  metaPath: string,
  updates: Partial<AgentMeta>,
): AgentMeta | undefined {
  const current = readAgentMeta(metaPath);
  if (!current) return undefined;
  const next: AgentMeta = {
    ...current,
    ...updates,
  };
  writeAgentMeta(metaPath, next);
  return next;
}

export function readLastTranscriptRecordUuidSync(
  jsonlPath: string,
): string | null {
  try {
    const raw = fs.readFileSync(jsonlPath, 'utf8');
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i]?.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ChatRecord;
        return parsed.uuid ?? null;
      } catch {
        const recovered = _recoverObjectsFromLine<ChatRecord>(trimmed);
        const lastRecovered = recovered[recovered.length - 1];
        if (lastRecovered?.uuid) {
          return lastRecovered.uuid;
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLogger.warn(
        `Failed to read last transcript record UUID from ${jsonlPath}:`,
        error,
      );
    }
  }
  return null;
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
  /**
   * Exact bootstrap history that seeded the agent before its first runtime
   * turn. Used by transcript-first resume to reconstruct fork constraints.
   */
  bootstrapHistory?: Content[];
  /**
   * Immutable launch-time system instruction for fork resume.
   */
  bootstrapSystemInstruction?: string | Content;
  /**
   * Immutable launch-time tool declarations / allowlist for fork resume.
   */
  bootstrapTools?: Array<string | FunctionDeclaration>;
  /**
   * Launching prompt that should be treated as the first model-facing task
   * prompt during transcript-based resume. For forks this may differ from the
   * bootstrap's visible user directive (e.g. `Begin.` vs full boilerplate).
   */
  launchTaskPrompt?: string;
  /**
   * When true, continue appending onto an existing transcript rather than
   * starting a fresh UUID chain.
   */
  appendToExisting?: boolean;
  /**
   * Optional explicit parent UUID to use for the first appended record.
   * Resume flows pass the last stable transcript UUID here so new records
   * branch away from any dangling tail produced by an interrupted turn.
   */
  initialParentUuid?: string | null;
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
  let lastUuid: string | null =
    options.initialParentUuid !== undefined
      ? options.initialParentUuid
      : options.appendToExisting
        ? readLastTranscriptRecordUuidSync(jsonlPath)
        : null;
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

  const recordUserMessage = (
    text: string,
    externalInputKind?: AgentExternalMessageEvent['kind'],
  ) => {
    if (!text) return;
    append({
      ...baseFields('user'),
      message: { role: 'user', parts: [{ text }] },
      ...(externalInputKind ? { externalInputKind } : {}),
    });
  };

  const recordSystem = (
    subtype: NonNullable<ChatRecord['subtype']>,
    payload: ChatRecord['systemPayload'],
  ) => {
    append({
      ...baseFields('system'),
      subtype,
      systemPayload: payload,
    });
  };

  const onExternalMessage = (event: AgentExternalMessageEvent) => {
    recordUserMessage(event.text, event.kind ?? 'message');
  };

  const hasBootstrapPayload =
    options.bootstrapHistory !== undefined ||
    options.bootstrapSystemInstruction !== undefined ||
    options.bootstrapTools !== undefined;

  if (hasBootstrapPayload) {
    const payload: AgentBootstrapRecordPayload = {
      kind: 'fork',
      history: structuredClone(options.bootstrapHistory ?? []),
      ...(options.bootstrapSystemInstruction !== undefined
        ? {
            systemInstruction: structuredClone(
              options.bootstrapSystemInstruction,
            ),
          }
        : {}),
      ...(options.bootstrapTools !== undefined
        ? { tools: structuredClone(options.bootstrapTools) }
        : {}),
    };
    recordSystem('agent_bootstrap', payload);
  }

  if (options.initialUserPrompt) {
    recordUserMessage(options.initialUserPrompt);
  }

  if (options.launchTaskPrompt) {
    recordSystem('agent_launch_prompt', {
      displayText: options.launchTaskPrompt,
    });
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
