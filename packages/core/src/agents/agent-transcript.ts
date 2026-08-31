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
 *   agent-<id>.jsonl.stream — transient live text, removed when the writer
 *                            closes
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AgentEventType,
  type AgentEventEmitter,
  type AgentToolCallEvent,
  type AgentToolResponsesFinalizedEvent,
  type AgentRoundTextEvent,
  type AgentStreamTextEvent,
  type AgentExternalMessageEvent,
} from './runtime/agent-events.js';
import type {
  AgentBootstrapRecordPayload,
  ChatRecord,
} from '../services/chatRecordingService.js';
import { MAX_SUBAGENT_DEPTH_LIMIT } from '../config/config.js';
import type { Config, SandboxConfig } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { getCachedGitBranch } from '../utils/gitUtils.js';
import { _recoverObjectsFromLine } from '../utils/jsonl-utils.js';
import type { Content } from '@google/genai';

const debugLogger = createDebugLogger('AGENT_TRANSCRIPT');
const MAX_PENDING_STREAM_BYTES = 64 * 1024;

export function sanitizeFilenameComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Root dir holding every session's subagent transcripts: `<projectDir>/subagents/`. */
export function getSubagentsRootDir(projectDir: string): string {
  return path.join(projectDir, 'subagents');
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
    getSubagentsRootDir(projectDir),
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
  /** Tool call in the parent session that launched this agent. */
  toolUseId?: string;
  /** AgentId of the launching subagent for nested forks; null for top-level. */
  parentAgentId: string | null;
  /** ISO 8601 creation time. */
  createdAt: string;
  /**
   * Persisted lifecycle status. Background-resume discovery treats
   * `running` as resumable work that was interrupted by process exit.
   */
  status?: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  /**
   * Whether the original launch ran asynchronously. Completed entries are
   * restored only when this is explicitly true so legacy foreground sidecars
   * are never exposed as reusable background agents.
   */
  isBackgrounded?: boolean;
  /** Whether the original launch used temporary worktree isolation. */
  isolation?: 'worktree';
  /** ISO 8601 timestamp of the latest lifecycle transition. */
  lastUpdatedAt?: string;
  /** Resolved approval mode used when the agent was launched. */
  resolvedApprovalMode?: string;
  /**
   * Immutable launch-time execution policy for a restricted fork.
   * Legacy absence allows every tool except the mandatory interaction-tool
   * exclusion; an empty list means deny-all.
   */
  executionAllowedTools?: string[];
  /** Launch-time CLI/runtime flags that should survive process restart. */
  persistedCliFlags?: AgentPersistedCliFlags;
  /** Canonical subagent config name used to recreate this agent. */
  subagentName?: string;
  /** UI hint preserved for resumed task rows. */
  agentColor?: string;
  /** Number of explicit resume attempts performed so far. */
  resumeCount?: number;
  /**
   * Nesting depth at launch time; restored on background/foreground resume
   * via {@link normalizeResumedAgentDepth} — never trust the raw value.
   */
  depth?: number;
  /**
   * Concrete model ID this agent runs with. Persisted so a process-restart
   * recovery can enforce per-model concurrency caps on the revive path.
   */
  model?: string;
  /** Last terminal error, if any. */
  lastError?: string;
}

export interface AgentTraceNode {
  agentId: string;
  agentType: string;
  description: string;
  parentSessionId: string;
  parentAgentId: string | null;
  rootAgentId: string;
  toolUseId?: string;
  depth?: number;
  status?: AgentMeta['status'];
  createdAt: string;
  lastUpdatedAt?: string;
  lastError?: string;
  lineageState: 'complete' | 'orphaned' | 'cycle';
}

export interface AgentTrace {
  nodes: AgentTraceNode[];
  rootAgentIds: string[];
  warnings: string[];
}

const TRACE_WARNING_LIMIT = 20;
export const MAX_AGENT_TRACE_NODES = 2_000;
const TRACE_READ_CONCURRENCY = 8;

export async function readAgentTrace(
  projectDir: string,
  sessionId: string,
  rootAgentId?: string,
): Promise<AgentTrace> {
  const dir = getSubagentSessionDir(projectDir, sessionId);
  const warnings: string[] = [];
  let discovered: string[];
  try {
    discovered = (await fs.promises.readdir(dir))
      .filter((name) => name.endsWith('.meta.json'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { nodes: [], rootAgentIds: [], warnings: [] };
    }
    throw error;
  }

  const fileNames = discovered.slice(0, MAX_AGENT_TRACE_NODES);
  if (discovered.length > MAX_AGENT_TRACE_NODES) {
    warnings.push(
      `Trace contains more than ${MAX_AGENT_TRACE_NODES} metadata files; results were truncated`,
    );
  }

  const metas = new Map<string, AgentMeta>();
  for (
    let offset = 0;
    offset < fileNames.length;
    offset += TRACE_READ_CONCURRENCY
  ) {
    const batch = fileNames.slice(offset, offset + TRACE_READ_CONCURRENCY);
    await Promise.all(
      batch.map(async (fileName) => {
        try {
          const parsed = JSON.parse(
            await fs.promises.readFile(path.join(dir, fileName), 'utf8'),
          ) as AgentMeta;
          if (
            typeof parsed.agentId !== 'string' ||
            parsed.agentId.length === 0 ||
            typeof parsed.agentType !== 'string' ||
            typeof parsed.description !== 'string' ||
            typeof parsed.createdAt !== 'string' ||
            !Number.isFinite(Date.parse(parsed.createdAt)) ||
            (parsed.parentAgentId !== null &&
              typeof parsed.parentAgentId !== 'string') ||
            (parsed.toolUseId !== undefined &&
              typeof parsed.toolUseId !== 'string') ||
            (parsed.depth !== undefined && !Number.isFinite(parsed.depth)) ||
            (parsed.status !== undefined &&
              ![
                'running',
                'paused',
                'completed',
                'failed',
                'cancelled',
              ].includes(parsed.status)) ||
            (parsed.lastUpdatedAt !== undefined &&
              (typeof parsed.lastUpdatedAt !== 'string' ||
                !Number.isFinite(Date.parse(parsed.lastUpdatedAt)))) ||
            (parsed.lastError !== undefined &&
              typeof parsed.lastError !== 'string') ||
            parsed.parentSessionId !== sessionId ||
            path.basename(
              getAgentMetaPath(projectDir, sessionId, parsed.agentId),
            ) !== fileName
          ) {
            throw new Error('invalid agent metadata identity');
          }
          metas.set(parsed.agentId, parsed);
        } catch (error) {
          if (warnings.length < TRACE_WARNING_LIMIT) {
            warnings.push(
              `${fileName}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }),
    );
  }

  const nodes = [...metas.values()]
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.agentId.localeCompare(right.agentId),
    )
    .map((meta): AgentTraceNode => {
      let cursor = meta;
      const lineage: string[] = [];
      const positions = new Map<string, number>();
      let lineageState: AgentTraceNode['lineageState'] = 'complete';
      let cycleRoot: string | undefined;
      while (cursor.parentAgentId !== null) {
        const previousPosition = positions.get(cursor.agentId);
        if (previousPosition !== undefined) {
          lineageState = 'cycle';
          cycleRoot = [...lineage.slice(previousPosition)].sort()[0];
          break;
        }
        positions.set(cursor.agentId, lineage.length);
        lineage.push(cursor.agentId);
        const parent = metas.get(cursor.parentAgentId);
        if (!parent) {
          lineageState = 'orphaned';
          break;
        }
        cursor = parent;
      }
      const resolvedRoot =
        lineageState === 'cycle'
          ? (cycleRoot ?? cursor.agentId)
          : cursor.agentId;
      return {
        agentId: meta.agentId,
        agentType: meta.agentType,
        description: meta.description,
        parentSessionId: meta.parentSessionId,
        parentAgentId: meta.parentAgentId,
        rootAgentId: resolvedRoot,
        ...(meta.toolUseId ? { toolUseId: meta.toolUseId } : {}),
        ...(meta.depth !== undefined ? { depth: meta.depth } : {}),
        ...(meta.status ? { status: meta.status } : {}),
        createdAt: meta.createdAt,
        ...(meta.lastUpdatedAt ? { lastUpdatedAt: meta.lastUpdatedAt } : {}),
        ...(meta.lastError ? { lastError: meta.lastError } : {}),
        lineageState,
      };
    });
  const filtered = rootAgentId
    ? nodes.filter((node) => node.rootAgentId === rootAgentId)
    : nodes;
  return {
    nodes: filtered,
    rootAgentIds: [...new Set(filtered.map((node) => node.rootAgentId))].sort(),
    warnings,
  };
}

export interface AgentPersistedCliFlags {
  /** Mirrors resolvedApprovalMode; kept here so the restored flag set is explicit. */
  approvalMode?: string;
  bare?: boolean;
  safeMode?: boolean;
  sandbox?: SandboxConfig | null;
  screenReader?: boolean;
  model?: string;
  authType?: string;
  baseUrl?: string;
  maxSessionTurns?: number;
  maxToolCalls?: number;
  /**
   * Launch-time nesting cap. Interprets the persisted `depth` — without it a
   * nested agent launched under a lower cap would resume after restart under
   * the new session's (or default) cap and regain spawn capacity.
   *
   * Always a normalized 1–100 integer when written by this codebase; the
   * resume path still re-normalizes because the sidecar is a plain JSON
   * file a malformed or hand-edited copy of which can carry anything.
   */
  maxSubagentDepth?: number;
}

/**
 * Normalizes a persisted launch depth read from an agent sidecar before it
 * is pinned via the `runWithAgentContext` depthOverride. The sidecar is a
 * plain JSON file, so a malformed or hand-edited value must not mint spawn
 * capacity: a negative depth (or `-1e309`, which parses to -Infinity) would
 * make `canSpawnNestedAgent()` pass for every cap.
 *
 * Absent values return undefined (the resume frame derives its depth as a
 * fresh launch). Anything but an integer within 0–{@link
 * MAX_SUBAGENT_DEPTH_LIMIT} fails CLOSED to the limit: the resumed agent
 * keeps running but cannot spawn — clamping a corrupt value down to 0 would
 * fail open by granting full spawn capacity.
 */
export function normalizeResumedAgentDepth(
  value: number | undefined,
): number | undefined {
  if (value == null) return undefined;
  return Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SUBAGENT_DEPTH_LIMIT
    ? value
    : MAX_SUBAGENT_DEPTH_LIMIT;
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
    return;
  }
  try {
    const now = new Date();
    fs.utimesSync(path.dirname(metaPath), now, now);
  } catch (error) {
    debugLogger.warn(
      `Failed to refresh agent session directory for ${metaPath}:`,
      error,
    );
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

export async function readAgentMetaAsync(
  metaPath: string,
): Promise<AgentMeta | undefined> {
  try {
    return JSON.parse(
      await fs.promises.readFile(metaPath, 'utf8'),
    ) as AgentMeta;
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
   * turn. Used by transcript-first resume to reconstruct fork context.
   */
  bootstrapHistory?: Content[];
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
  /**
   * 1-based attempt number when this attach resumes a transcript after a
   * failed attempt (2+). Seeds an `agent_retry` system marker at the seam so
   * the retry is visible on disk. Not implied by `appendToExisting` —
   * background resume also appends without being a retry.
   */
  retryAttempt?: number;
}

/** Path + options pair for {@link attachJsonlTranscriptWriter}. */
export interface AgentTranscriptAttachTarget {
  jsonlPath: string;
  options: AttachJsonlOptions;
}

/**
 * Single owner of the agent-transcript attach contract: the JSONL path plus
 * the launch metadata shared by every attach site (AgentTool's foreground
 * and background launches, workflow dispatch, background resume). Each site
 * layers its extras on top, so a new launch-metadata field added here lands
 * in every transcript instead of only the sites that happened to be updated.
 *
 * The path follows the merged `sessionId` — the live session by default;
 * background resume overrides it with the persisted parent session.
 */
export function buildAgentTranscriptAttach(
  config: Config,
  agentId: string,
  extras?: Partial<AttachJsonlOptions>,
): AgentTranscriptAttachTarget {
  const projectRoot = config.getProjectRoot();
  const options: AttachJsonlOptions = {
    agentId,
    sessionId: config.getSessionId(),
    cwd: projectRoot,
    version: config.getCliVersion() || 'unknown',
    gitBranch: getCachedGitBranch(projectRoot),
    ...extras,
  };
  return {
    jsonlPath: getAgentJsonlPath(
      config.storage.getProjectDir(),
      options.sessionId,
      options.agentId,
    ),
    options,
  };
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
 * tools (which can fire many TOOL_CALL events per round) avoid
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
  let streamFd: number | null = null;
  const streamPath = `${jsonlPath}.stream`;
  const streamRunId = randomUUID();
  let pendingStreamText = '';
  let pendingStreamBytes = 0;
  let streamFlushTimer: NodeJS.Timeout | null = null;
  let openFailed = false;

  try {
    fs.rmSync(streamPath, { force: true });
  } catch (error) {
    debugLogger.warn(
      `Failed to reset streaming transcript ${streamPath}:`,
      error,
    );
  }

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

  const flushStreamText = () => {
    streamFlushTimer = null;
    if (!pendingStreamText) return;
    const text = pendingStreamText;
    pendingStreamText = '';
    pendingStreamBytes = 0;
    try {
      if (streamFd === null) {
        fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
        streamFd = fs.openSync(streamPath, 'w');
      }
      fs.writeSync(streamFd, text);
    } catch (error) {
      debugLogger.warn(
        `Failed to append streaming transcript ${streamPath}:`,
        error,
      );
    }
  };

  const appendStreamText = (event: AgentStreamTextEvent) => {
    const record = `${JSON.stringify({
      v: 1,
      runId: event.runId ?? streamRunId,
      round: event.round,
      text: event.text,
      thought: event.thought === true,
      timestamp: event.timestamp,
    })}\n`;
    pendingStreamText += record;
    pendingStreamBytes += Buffer.byteLength(record);
    if (pendingStreamBytes >= MAX_PENDING_STREAM_BYTES) {
      if (streamFlushTimer !== null) {
        clearTimeout(streamFlushTimer);
        streamFlushTimer = null;
      }
      flushStreamText();
      return;
    }
    if (streamFlushTimer === null) {
      streamFlushTimer = setTimeout(flushStreamText, 100);
      streamFlushTimer.unref();
    }
  };

  const onRoundText = (event: AgentRoundTextEvent) => {
    const parts = [
      ...(event.thoughtText
        ? [{ text: event.thoughtText, thought: true }]
        : []),
      ...(event.text ? [{ text: event.text }] : []),
    ];
    if (parts.length === 0 && !event.usageMetadata) return;
    append({
      ...baseFields('assistant'),
      message: { role: 'model', parts },
      usageMetadata: event.usageMetadata,
      agentRunId: event.runId ?? streamRunId,
      agentRound: event.round,
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

  const onToolResponsesFinalized = (
    event: AgentToolResponsesFinalizedEvent,
  ) => {
    for (const response of event.responses) {
      append({
        ...baseFields('tool_result'),
        message: { role: 'user', parts: response.responseParts },
        toolCallResult: {
          callId: response.callId,
          ...(response.durationMs !== undefined
            ? { durationMs: response.durationMs }
            : {}),
        },
      });
    }
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

  if (options.bootstrapHistory !== undefined) {
    const payload: AgentBootstrapRecordPayload = {
      kind: 'fork',
      history: structuredClone(options.bootstrapHistory ?? []),
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

  if (options.retryAttempt !== undefined) {
    recordSystem('agent_retry', { attempt: options.retryAttempt });
  }

  emitter.on(AgentEventType.ROUND_TEXT, onRoundText);
  emitter.on(AgentEventType.STREAM_TEXT, appendStreamText);
  emitter.on(AgentEventType.TOOL_CALL, onToolCall);
  emitter.on(AgentEventType.TOOL_RESPONSES_FINALIZED, onToolResponsesFinalized);
  emitter.on(AgentEventType.EXTERNAL_MESSAGE, onExternalMessage);

  const cleanup = () => {
    emitter.off(AgentEventType.ROUND_TEXT, onRoundText);
    emitter.off(AgentEventType.STREAM_TEXT, appendStreamText);
    emitter.off(AgentEventType.TOOL_CALL, onToolCall);
    emitter.off(
      AgentEventType.TOOL_RESPONSES_FINALIZED,
      onToolResponsesFinalized,
    );
    emitter.off(AgentEventType.EXTERNAL_MESSAGE, onExternalMessage);
    if (streamFlushTimer !== null) {
      clearTimeout(streamFlushTimer);
      streamFlushTimer = null;
    }
    flushStreamText();
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
      fd = null;
    }
    if (streamFd !== null) {
      try {
        fs.closeSync(streamFd);
      } catch {
        // Best-effort cleanup; the process will release the descriptor.
      }
      streamFd = null;
    }
    try {
      fs.rmSync(streamPath, { force: true });
    } catch (error) {
      debugLogger.warn(
        `Failed to remove streaming transcript ${streamPath}:`,
        error,
      );
    }
  };

  return { cleanup };
}
