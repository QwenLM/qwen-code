/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview A2A inbound on top of session multi-agent.
 *
 * Implements core's `A2ASessionPort` with the orchestrator's public API, the
 * bridge's session spawn and a read-only transcript read. An A2A task is one
 * agent run in a chat session created for the caller; the core A2A modules
 * own grants, idempotency and the caller-to-task mapping.
 *
 * The session is an ordinary chat session (`sourceType: 'default'`, like a
 * scheduled task's run session), so it is listed in WebShell as
 * "A2A · <caller>" and the workspace owner can read along and answer the
 * agent's tool approvals there — an A2A caller cannot. `sourceId` marks it
 * as A2A-created; it is attribution only, never what authorizes a caller
 * (that is the caller's mapping file). A session carrying a `sourceId` also
 * stays on the Legacy engine, which is the one that writes agent records.
 */

import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import {
  AGENT_MESSAGE_SUBTYPE,
  type AgentMessageRecordPayload,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import {
  A2ASessionError,
  type A2ARecordedReply,
  type A2ASessionPort,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/a2a-server.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  SessionAgentError,
  type SessionAgentOrchestrator,
} from './orchestrator.js';

export const A2A_SESSION_SOURCE_TYPE = 'default';
export const A2A_SESSION_SOURCE_ID_PREFIX = 'a2a:';

/**
 * Archived transcripts larger than this are refused, not read: the reply
 * lookup rejects (the poll fails) rather than take the run for unanswered.
 */
const MAX_ARCHIVED_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

export function a2aSessionSourceId(callerId: string): string {
  return `${A2A_SESSION_SOURCE_ID_PREFIX}${callerId}`;
}

/** The orchestrator surface A2A uses: public methods only. */
export type A2AOrchestrator = Pick<
  SessionAgentOrchestrator,
  'bridge' | 'mention' | 'snapshot' | 'cancel'
>;

export type A2ASessionBridge = Pick<
  AcpSessionBridge,
  'spawnOrAttach' | 'updateSessionMetadata' | 'killSession'
>;

/** The record fields a reply lookup reads. */
export interface A2ATranscriptRecord {
  subtype?: string;
  timestamp?: string;
  systemPayload?: unknown;
}

export interface A2ASessionPortOptions {
  workspaceCwd: string;
  /**
   * The workspace's own session runtime dir (`sessionRuntimeBaseDir`), where
   * its transcripts are. Without it the process default is used, which is
   * the primary workspace's.
   */
  runtimeBaseDir?: string;
  /** The workspace runtime's current bridge. */
  bridge: A2ASessionBridge;
  /**
   * The workspace's orchestrator (`getSessionAgentOrchestrator`), never one
   * created here: `ensureSessionAgentOrchestrator` from a second caller would
   * build it without the session-agent routes' options. Undefined while
   * collaboration is starting or off.
   */
  orchestrator: A2AOrchestrator | undefined;
  /** Test seam: a session's records, active or archived. */
  loadRecords?: (
    sessionId: string,
  ) => Promise<readonly A2ATranscriptRecord[] | undefined>;
}

function sessionService(workspaceCwd: string, runtimeBaseDir?: string) {
  return new SessionService(
    workspaceCwd,
    runtimeBaseDir !== undefined ? { runtimeBaseDir } : {},
  );
}

function defaultLoadRecords(workspaceCwd: string, runtimeBaseDir?: string) {
  return async (
    sessionId: string,
  ): Promise<readonly A2ATranscriptRecord[] | undefined> => {
    const service = sessionService(workspaceCwd, runtimeBaseDir);
    const data =
      (await service.loadSession(sessionId)) ??
      (await service.loadArchivedSession(sessionId, {
        maxBytes: MAX_ARCHIVED_TRANSCRIPT_BYTES,
      }));
    return data?.conversation.messages;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `agent_message` payload of `record` when it is `runId`'s reply. */
function replyPayload(
  record: A2ATranscriptRecord,
  runId: string,
): AgentMessageRecordPayload | undefined {
  if (record.subtype !== AGENT_MESSAGE_SUBTYPE) return undefined;
  const payload = record.systemPayload;
  if (
    !isRecord(payload) ||
    payload['runId'] !== runId ||
    typeof payload['displayText'] !== 'string' ||
    typeof payload['status'] !== 'string'
  ) {
    return undefined;
  }
  return payload as unknown as AgentMessageRecordPayload;
}

/**
 * Maps an orchestrator refusal: a 4xx is the request's fault (no such agent
 * to address, a managed session, a malformed post) and is a refusal to the
 * caller; a 503 is retryable. Anything else stays an internal failure, which
 * the transport logs without telling the caller.
 */
function mapOrchestratorError(error: unknown): unknown {
  if (!(error instanceof SessionAgentError)) return error;
  if (error.status === 503) {
    return new A2ASessionError('unavailable', error.message);
  }
  if (error.status >= 400 && error.status < 500) {
    return new A2ASessionError('refused', error.message);
  }
  return error;
}

export function createA2ASessionPort(
  options: A2ASessionPortOptions,
): A2ASessionPort {
  const { workspaceCwd, bridge, orchestrator } = options;
  const loadRecords =
    options.loadRecords ??
    defaultLoadRecords(workspaceCwd, options.runtimeBaseDir);

  /** The orchestrator, when it runs on this runtime's bridge. */
  const current = (): A2AOrchestrator => {
    if (!orchestrator || !Object.is(orchestrator.bridge, bridge)) {
      throw new A2ASessionError(
        'unavailable',
        'Workspace agents are not running.',
      );
    }
    return orchestrator;
  };

  return {
    async createSession({ callerId, title }) {
      current();
      // TODO(multi-agent): confirm on a live daemon that a session whose
      // first record is an `agent_mention` (no prompt has run in it) gets its
      // transcript written and shows up in the WebShell session list.
      const session = await bridge.spawnOrAttach({
        workspaceCwd,
        sessionScope: 'thread',
        sourceType: A2A_SESSION_SOURCE_TYPE,
        sourceId: a2aSessionSourceId(callerId),
      });
      try {
        bridge.updateSessionMetadata(session.sessionId, {
          displayName: title,
          titleSource: 'auto',
        });
      } catch {
        // The session still works under its generated id.
      }
      return session.sessionId;
    },

    async discardSession(sessionId) {
      await bridge.killSession(sessionId, { requireZeroAttaches: true });
      await sessionService(workspaceCwd, options.runtimeBaseDir).removeSession(
        sessionId,
      );
    },

    async mention(sessionId, input) {
      try {
        const result = await current().mention(sessionId, input);
        return {
          runs: result.runs.map((run) => ({
            runId: run.runId,
            agentId: run.agentId,
          })),
        };
      } catch (error) {
        throw mapOrchestratorError(error);
      }
    },

    async liveRun(sessionId, runId) {
      // Snapshot frames: live runs, and finished ones the orchestrator has
      // not settled (reply record pending, or retryable after a restart).
      // One left over from a replaced bridge no longer owns the session.
      if (!orchestrator || !Object.is(orchestrator.bridge, bridge)) {
        return undefined;
      }
      const frame = (await orchestrator.snapshot(sessionId)).find(
        (candidate) => candidate.runId === runId,
      );
      if (!frame) return undefined;
      return {
        status: frame.status,
        activityAt: frame.activityAt,
        ...(frame.error ? { error: frame.error } : {}),
        ...(frame.totalTokens !== undefined
          ? { totalTokens: frame.totalTokens }
          : {}),
        ...(frame.recorded !== undefined ? { recorded: frame.recorded } : {}),
        ...(frame.retryable ? { retryable: true } : {}),
      };
    },

    async recordedReply(
      sessionId,
      runId,
    ): Promise<A2ARecordedReply | undefined> {
      const records = await loadRecords(sessionId);
      if (!records) return undefined;
      for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index]!;
        const payload = replyPayload(record, runId);
        if (!payload) continue;
        const at = record.timestamp ? Date.parse(record.timestamp) : NaN;
        return { payload, ...(Number.isFinite(at) ? { at } : {}) };
      }
      return undefined;
    },

    async cancel(sessionId, runId) {
      try {
        return await current().cancel(sessionId, runId);
      } catch (error) {
        throw mapOrchestratorError(error);
      }
    },
  };
}
