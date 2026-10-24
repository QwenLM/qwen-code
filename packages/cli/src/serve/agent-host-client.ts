/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Host side of the Agent Host protocol (v2).
 *
 * This daemon joins a coordinator's workspace as a runtime: it enrolls once
 * (credential under `~/.qwen/agent-hosts/`, 0600), heartbeats every 5 s with
 * its program probe and the leases it holds, long-polls for session turns and
 * runs up to {@link MAX_CONCURRENT_HOST_TURNS} at once through the same
 * adapters the coordinator uses locally. Adapter events stream back in
 * ordered batches; permission requests wait for the person's decision, which
 * a decisions long-poll (open only while a turn waits) brings back at once,
 * and heartbeat and event responses bring as well; the result carries the
 * program's native session id so the next turn resumes it. A run the person
 * stops on the coordinator is aborted here and posts no result.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { extractErrorMessage } from '@qwen-code/acp-bridge/bridge';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  HOST_PROTOCOL_VERSION,
  type AgentAdapterEvent,
  type AgentAdapterTurnInput,
  type AgentAdapterTurnResult,
  type HostLeaseStatus,
  type HostProgramProbe,
  type HostTurnAssignment,
  type HostTurnEventBatch,
  type HostTurnResult,
  type SessionAgentPermissionPrompt,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import type { WorkspaceGenerationGuard } from './workspace-registry.js';
import { isLoopbackBind } from './loopback-binds.js';
import { sessionAgentNativeSessionId } from '../runtime/agent-session-source.js';
import {
  AGENT_HOST_CREDENTIAL_REJECTED,
  AGENT_HOST_REPLACEMENT_REQUIRED,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/types.js';
import {
  getAdapter,
  type QwenSessionSendBinding,
} from './session-agents/adapters/index.js';
import { updateSessionAgents } from '@qwen-code/qwen-code-core/agents/session-agents/binding-store.js';
import {
  availablePrograms,
  getHostProgramProbe,
} from './agent-host-programs.js';
import {
  hasAgentHostRelay,
  openAgentHostRelayRun,
  type AgentHostRelayRun,
} from './agent-host-relay.js';
import {
  buildSessionSendServer,
  HOST_TURN_LEASE_MS,
} from './session-agents/orchestrator.js';
import {
  hostDecisionKey,
  type HostAwaitedPermission,
  type HostDecision,
} from './agent-host-decisions.js';

const HEARTBEAT_MS = 5_000;
const RETRY_MS = 2_000;
/** Adapter events are batched this long before they are posted. */
const EVENT_FLUSH_MS = 250;
/** How long one decisions long-poll stays open (the coordinator's maximum). */
const DECISIONS_WAIT_MS = 25_000;
/** Bounds the coordinator's validation of a decisions poll accepts. */
const MAX_AWAITED = 16;
const MAX_SEEN_PER_AWAITED = 8;
/** With no renewal for a lease term the run is gone on the coordinator. */
const TURN_LEASE_MS = HOST_TURN_LEASE_MS;
/** Turns this Host runs at once. */
export const MAX_CONCURRENT_HOST_TURNS = 4;
const MAX_BATCH_EVENTS = 500;
/** UTF-8 bytes of text per batch; the coordinator parses at most 2 MB. */
const MAX_BATCH_BYTES = 1_000_000;
const MAX_RESULT_OUTPUT = 262_144;
const MAX_RESULT_ERROR = 4_096;

interface AgentHostCredential {
  schemaVersion: 1;
  serverUrl: string;
  workspaceId: string;
  hostId: string;
  secret: string;
}

export interface AgentHostConnectionOptions {
  bridge: AcpSessionBridge;
  serverUrl: string;
  workspaceId: string;
  workspaceCwd: string;
  enrollmentToken?: string;
  allowHttp?: boolean;
  name?: string;
  generationGuard?: WorkspaceGenerationGuard;
}

export function normalizeServerUrl(value: string, allowHttp = false): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('--agent-host-server must be an HTTP(S) URL.');
  }
  if (url.protocol === 'http:' && !isLoopbackBind(url.hostname) && !allowHttp) {
    throw new Error(
      '--agent-host-server requires HTTPS outside loopback. For a trusted demo network only, explicitly pass --agent-host-allow-http.',
    );
  }
  return url.toString().replace(/\/$/, '');
}

function credentialPath(
  serverUrl: string,
  workspaceId: string,
  workspaceCwd: string,
): string {
  const key = createHash('sha256')
    .update(`${serverUrl}\0${workspaceId}\0${workspaceCwd}`)
    .digest('hex');
  return path.join(Storage.getGlobalQwenDir(), 'agent-hosts', `${key}.json`);
}

async function readCredential(
  filePath: string,
): Promise<AgentHostCredential | undefined> {
  try {
    const value = JSON.parse(
      await fs.readFile(filePath, 'utf8'),
    ) as Partial<AgentHostCredential>;
    if (
      value.schemaVersion === 1 &&
      typeof value.serverUrl === 'string' &&
      typeof value.workspaceId === 'string' &&
      typeof value.hostId === 'string' &&
      typeof value.secret === 'string'
    ) {
      return value as AgentHostCredential;
    }
    throw new Error(`Malformed Agent Host credential: ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeCredential(
  filePath: string,
  credential: AgentHostCredential,
  expected: AgentHostCredential | undefined,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lock = await lockCredential(filePath);
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let completed = false;
  try {
    const current = await readCredential(filePath);
    lock.assertHeld();
    if (
      current &&
      (current.hostId !== expected?.hostId ||
        current.secret !== expected?.secret) &&
      (current.hostId !== credential.hostId ||
        current.secret !== credential.secret)
    ) {
      throw new Error(
        'Saved Agent Host credential changed. Retry with the latest credential.',
      );
    }
    await fs.writeFile(temporary, `${JSON.stringify(credential, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    lock.assertHeld();
    await fs.rename(temporary, filePath);
    lock.assertHeld();
    completed = true;
  } finally {
    const cleanup = fs.rm(temporary, { force: true }).finally(lock.release);
    if (completed) {
      await cleanup;
    } else {
      await cleanup.catch((error) =>
        writeStderrLine(
          `Agent Host credential cleanup failed: ${extractErrorMessage(error)}`,
        ),
      );
    }
  }
}

async function lockCredential(filePath: string) {
  let compromised: Error | undefined;
  const release = await lockfile.lock(filePath, {
    realpath: false,
    retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
    onCompromised: (error) => {
      compromised = error;
      writeStderrLine(
        `Agent Host credential lock compromised: ${error.message}`,
      );
    },
  });
  return {
    assertHeld: () => {
      if (compromised) throw compromised;
    },
    release: () => (compromised ? Promise.resolve() : release()),
  };
}

async function removeRevokedCredential(
  filePath: string,
  expected: AgentHostCredential,
): Promise<void> {
  const lock = await lockCredential(filePath);
  try {
    const current = await readCredential(filePath);
    lock.assertHeld();
    if (
      current?.hostId === expected.hostId &&
      current.secret === expected.secret
    ) {
      await fs.rm(filePath, { force: true });
      lock.assertHeld();
    }
  } finally {
    await lock.release();
  }
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
    ...init,
  });
  const result = (await response.json().catch(() => ({}))) as {
    error?: string;
    cancelled?: unknown;
  } & T;
  if (!response.ok) {
    throw Object.assign(
      new Error(
        result.error ?? `Agent Host request failed (${response.status}).`,
      ),
      {
        status: response.status,
        ...(result.cancelled === true ? { cancelled: true } : {}),
      },
    );
  }
  return result;
}

/** The coordinator's 409 for a run the person stopped. */
export function isCancellation(error: unknown): boolean {
  return (
    (error as { status?: number } | null | undefined)?.status === 409 &&
    (error as { cancelled?: unknown }).cancelled === true
  );
}

/** A 4xx the same request will get again; 408 and 429 are worth a retry. */
function isPermanentRejection(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

/**
 * True only for the agent-host route's own credential rejection. A bare 401
 * can also come from the coordinator's bearer gate while the runtime is
 * still starting, or while collaboration is off and the routes are
 * unmounted — neither says anything about this Host's credential, and
 * treating them as revocation deletes the credential and strands the Host
 * until an operator re-joins it by hand. The route answers with the same
 * exported constant, so the two halves cannot drift apart silently.
 */
export function isRevocation(error: unknown): boolean {
  return (
    (error as { status?: number } | null | undefined)?.status === 401 &&
    (error as Error | null | undefined)?.message ===
      AGENT_HOST_CREDENTIAL_REJECTED
  );
}

/** Where the credential for this (coordinator, workspace, cwd) lives. */
function credentialFiles(
  serverUrl: string,
  workspaceId: string,
  workspaceCwd: string,
): { legacy: string; current: string } {
  const legacy = credentialPath(serverUrl, workspaceId, workspaceCwd);
  // Old clients delete their legacy file on revocation without checking its
  // identity. Keep updated credentials outside that deletion path.
  return { legacy, current: legacy.replace(/\.json$/, '.v2.json') };
}

/**
 * True when a saved credential would let this connection resume, false when
 * none exists, and undefined when one could not be read (malformed, EACCES,
 * I/O): that is not evidence of revocation, so callers must not prune on it.
 */
export async function hasAgentHostCredential(target: {
  serverUrl: string;
  workspaceId: string;
  workspaceCwd: string;
  allowHttp?: boolean;
}): Promise<boolean | undefined> {
  let files: { legacy: string; current: string };
  try {
    files = credentialFiles(
      normalizeServerUrl(target.serverUrl, target.allowHttp),
      target.workspaceId,
      target.workspaceCwd,
    );
  } catch {
    // A target that does not normalize can never resume.
    return false;
  }
  try {
    return Boolean(
      (await readCredential(files.current)) ??
        (await readCredential(files.legacy)),
    );
  } catch {
    return undefined;
  }
}

function hostUrl(credential: AgentHostCredential, suffix: string): string {
  return `${credential.serverUrl}/agent-hosts/${encodeURIComponent(credential.workspaceId)}/${encodeURIComponent(credential.hostId)}/${suffix}`;
}

function hostHeaders(credential: AgentHostCredential): Record<string, string> {
  return {
    authorization: `AgentHost ${credential.secret}`,
    'content-type': 'application/json',
  };
}

async function pickup(
  credential: AgentHostCredential,
  waitMs = 25_000,
  stopSignal?: AbortSignal,
): Promise<HostTurnAssignment | undefined> {
  const response = await fetch(hostUrl(credential, 'pickup'), {
    method: 'POST',
    headers: hostHeaders(credential),
    body: JSON.stringify({ waitMs }),
    signal: stopSignal
      ? AbortSignal.any([stopSignal, AbortSignal.timeout(waitMs + 10_000)])
      : AbortSignal.timeout(waitMs + 10_000),
    redirect: 'error',
  });
  if (response.status === 204) return undefined;
  const result = (await response.json().catch(() => ({}))) as {
    assignment?: HostTurnAssignment;
    error?: string;
  };
  if (!response.ok || !result.assignment) {
    throw Object.assign(
      new Error(
        result.error ?? `Agent Host pickup failed (${response.status}).`,
      ),
      { status: response.status },
    );
  }
  return result.assignment;
}

/** One decisions long-poll; resolves with the decisions it brought. */
async function pollDecisions(
  credential: AgentHostCredential,
  awaiting: HostAwaitedPermission[],
  signal: AbortSignal,
): Promise<HostDecision[]> {
  const response = await requestJson<{ decisions?: HostDecision[] }>(
    hostUrl(credential, 'decisions'),
    {
      method: 'POST',
      headers: hostHeaders(credential),
      body: JSON.stringify({ waitMs: DECISIONS_WAIT_MS, awaiting }),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(DECISIONS_WAIT_MS + 10_000),
      ]),
    },
  );
  return Array.isArray(response.decisions) ? response.decisions : [];
}

/** The `session_send` MCP server command for a run, or undefined. */
export function sessionSendServerFor(
  relay: Pick<AgentHostRelayRun, 'url' | 'token'> | undefined,
): AgentAdapterTurnInput['sessionSendServer'] {
  return relay ? buildSessionSendServer(relay.url, relay.token) : undefined;
}

interface PermissionWaiter {
  resolve(optionId: string): void;
  reject(error: Error): void;
}

/** One assignment this Host is executing. */
interface HostTurn {
  assignment: HostTurnAssignment;
  controller: AbortController;
  /**
   * The coordinator refused this lease, or the person stopped the run there;
   * nothing more is sent for it.
   */
  lost: boolean;
  relay?: AgentHostRelayRun;
  renewedAt: number;
  sequence: number;
  pending: AgentAdapterEvent[];
  /** Sent but unacknowledged; retried with the same sequence. */
  inflight?: Pick<HostTurnEventBatch, 'sequence' | 'events'>;
  sendChain: Promise<void>;
  flushTimer?: ReturnType<typeof setTimeout>;
  /** The current waiter per requestId; a re-armed wait replaces it. */
  waiters: Map<string, PermissionWaiter>;
  /** A decision no waiter took yet, per requestId (the newest wins). */
  early: Map<string, { key: string; optionId: string }>;
  /**
   * Keys of the decisions each requestId's waiters already took. The
   * coordinator resends a decision until it sees `permission_resolved`; a
   * re-armed wait takes only a decision it has not used.
   */
  used: Map<string, string[]>;
  /** requestIds the adapter reported resolved; later decisions are stale. */
  resolved: Set<string>;
}

/** Splits off the next batch: bounded in count and in text size. */
function takeBatch(pending: AgentAdapterEvent[]): AgentAdapterEvent[] {
  let bytes = 0;
  let count = 0;
  for (const event of pending) {
    const size = Buffer.byteLength(
      'text' in event ? event.text : JSON.stringify(event),
    );
    if (
      count > 0 &&
      (count >= MAX_BATCH_EVENTS || bytes + size > MAX_BATCH_BYTES)
    ) {
      break;
    }
    bytes += size;
    count += 1;
  }
  return pending.splice(0, count);
}

/** Bounded so the coordinator's validation never refuses an answer. */
function boundResult(result: AgentAdapterTurnResult): AgentAdapterTurnResult {
  return {
    ...result,
    outputText: result.outputText.slice(0, MAX_RESULT_OUTPUT),
    ...(result.error !== undefined
      ? { error: result.error.slice(0, MAX_RESULT_ERROR) }
      : {}),
  };
}

const activeConnections = new Map<
  string,
  {
    bridge: AcpSessionBridge;
    generationGuard?: WorkspaceGenerationGuard;
    stop: AbortController;
    start: Promise<void>;
  }
>();

function connectionKey(
  serverUrl: string,
  workspaceId: string,
  workspaceCwd: string,
): string {
  return JSON.stringify([serverUrl, workspaceId, workspaceCwd]);
}

export async function startAgentHostConnection(
  options: AgentHostConnectionOptions,
): Promise<void> {
  const key = connectionKey(
    normalizeServerUrl(options.serverUrl, options.allowHttp),
    options.workspaceId,
    options.workspaceCwd,
  );
  const existing = activeConnections.get(key);
  if (existing) {
    if (
      existing.bridge === options.bridge &&
      existing.generationGuard === options.generationGuard &&
      !options.enrollmentToken &&
      !existing.stop.signal.aborted
    ) {
      return existing.start;
    }
    existing.stop.abort(new Error('Agent Host connection replaced.'));
    activeConnections.delete(key);
  }
  const stop = new AbortController();
  const start = connectAgentHost(options, stop);
  activeConnections.set(key, {
    bridge: options.bridge,
    generationGuard: options.generationGuard,
    stop,
    start,
  });
  try {
    await start;
  } catch (error) {
    if (activeConnections.get(key)?.start === start)
      activeConnections.delete(key);
    throw error;
  }
}

/** True while a connection to this (coordinator, workspace, cwd) runs. */
export function isAgentHostConnectionRunning(target: {
  serverUrl: string;
  workspaceId: string;
  workspaceCwd: string;
  allowHttp?: boolean;
}): boolean {
  try {
    const existing = activeConnections.get(
      connectionKey(
        normalizeServerUrl(target.serverUrl, target.allowHttp),
        target.workspaceId,
        target.workspaceCwd,
      ),
    );
    return existing !== undefined && !existing.stop.signal.aborted;
  } catch {
    return false;
  }
}

/**
 * Stops a running connection (its turns are aborted and their leases lapse
 * on the coordinator). The saved credential stays; revocation is the
 * coordinator's call. Returns false when no such connection was running.
 */
export function stopAgentHostConnection(target: {
  serverUrl: string;
  workspaceId: string;
  workspaceCwd: string;
  allowHttp?: boolean;
}): boolean {
  const key = connectionKey(
    normalizeServerUrl(target.serverUrl, target.allowHttp),
    target.workspaceId,
    target.workspaceCwd,
  );
  const existing = activeConnections.get(key);
  if (!existing) return false;
  existing.stop.abort(new Error('Agent Host connection stopped.'));
  activeConnections.delete(key);
  return true;
}

async function connectAgentHost(
  options: AgentHostConnectionOptions,
  stop: AbortController,
): Promise<void> {
  const assertOpen = () => {
    options.generationGuard?.assertOpen();
    stop.signal.throwIfAborted();
  };
  assertOpen();
  const serverUrl = normalizeServerUrl(options.serverUrl, options.allowHttp);
  if (
    new URL(serverUrl).protocol === 'http:' &&
    !isLoopbackBind(new URL(serverUrl).hostname)
  ) {
    writeStderrLine(
      'WARNING: Agent Host HTTP demo mode sends credentials, task content and results without encryption. Use only on a trusted network.',
    );
  }
  let probes: HostProgramProbe[] = await getHostProgramProbe().catch(
    (error: unknown) => {
      writeStderrLine(
        `qwen serve: Agent Host program probe failed: ${extractErrorMessage(error)}`,
      );
      return [];
    },
  );
  // The qwen program is this daemon's own bridge, so it is always there; the
  // fallback only keeps enrollment (which needs one program) from failing on
  // a probe error.
  const providersFor = (current: readonly HostProgramProbe[]): string[] => {
    const ids = availablePrograms(current);
    return ids.length > 0 ? ids : ['qwen'];
  };
  const files = credentialFiles(
    serverUrl,
    options.workspaceId,
    options.workspaceCwd,
  );
  const filePath = files.current;
  const legacyFilePath = files.legacy;
  const savedCurrentCredential = await readCredential(filePath);
  let credential =
    savedCurrentCredential ?? (await readCredential(legacyFilePath));
  const discardRevokedCredential = async (expected: AgentHostCredential) => {
    await removeRevokedCredential(filePath, expected);
    await removeRevokedCredential(legacyFilePath, expected);
  };
  assertOpen();
  const turns = new Map<string, HostTurn>();
  /**
   * `session_send` for remote `qwen` turns. The hidden session outlives a run
   * and its MCP servers are fixed when it is (re)created, so the relay token
   * belongs to the (chat session, agent) binding, like the coordinator's own
   * qwen agents (see qwen-acp.ts); posts go to that binding's current turn.
   */
  const qwenRelayBindings = new Map<
    string,
    { relay: AgentHostRelayRun; runId?: string }
  >();
  const qwenRelayKey = (assignment: HostTurnAssignment) =>
    `${assignment.sessionId}\0${assignment.agent.agentId}`;
  const qwenSessionSendFor = (
    assignment: HostTurnAssignment,
  ): QwenSessionSendBinding => {
    const key = qwenRelayKey(assignment);
    const relayId = `qs-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
    return {
      // A daemon that cannot offer a relay has no token to lose: report the
      // binding current, or every turn would close and re-resume the hidden
      // session. Only a lost token on a relay-capable daemon is stale.
      isCurrent: () => !hasAgentHostRelay() || qwenRelayBindings.has(key),
      rotate: () => {
        qwenRelayBindings.get(key)?.relay.close();
        qwenRelayBindings.delete(key);
        const relay = openAgentHostRelayRun(relayId, (text) => {
          const runId = qwenRelayBindings.get(key)?.runId;
          const current = runId ? turns.get(runId) : undefined;
          // A post outside a turn has nowhere to go: the coordinator only
          // accepts events for a leased run.
          if (current) pushEvent(current, { type: 'session_send', text });
        });
        if (!relay) return undefined;
        qwenRelayBindings.set(key, { relay, runId: assignment.runId });
        return sessionSendServerFor(relay);
      },
    };
  };
  interface HeartbeatResponse {
    leases?: HostLeaseStatus[];
    decisions?: HostDecision[];
  }
  const sendHeartbeat = async (
    target: AgentHostCredential,
    enrollmentToken?: string,
  ): Promise<HeartbeatResponse> =>
    requestJson<HeartbeatResponse>(hostUrl(target, 'heartbeat'), {
      method: 'POST',
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]),
      headers: hostHeaders(target),
      body: JSON.stringify({
        workspaceCwd: options.workspaceCwd,
        protocol: HOST_PROTOCOL_VERSION,
        providers: providersFor(probes),
        programs: probes,
        runs: [...turns.values()]
          .filter((turn) => !turn.lost)
          .map((turn) => ({
            runId: turn.assignment.runId,
            attempt: turn.assignment.attempt,
            leaseId: turn.assignment.leaseId,
          })),
        ...(enrollmentToken ? { enrollmentToken } : {}),
      }),
    });
  if (credential && options.enrollmentToken) {
    const savedCredential = credential;
    try {
      await sendHeartbeat(savedCredential, options.enrollmentToken);
    } catch (error) {
      if (
        (error as { status?: number }).status === 409 &&
        (error as Error).message === AGENT_HOST_REPLACEMENT_REQUIRED
      ) {
        credential = undefined;
      } else {
        if ((error as { status?: number }).status !== 401) throw error;
        try {
          await sendHeartbeat(savedCredential);
          throw new Error('Invalid or expired Agent Host enrollment token.');
        } catch (credentialError) {
          if (!isRevocation(credentialError)) {
            throw credentialError;
          }
          await discardRevokedCredential(savedCredential);
          credential = undefined;
        }
      }
    }
    assertOpen();
  }
  if (!credential) {
    if (!options.enrollmentToken) {
      throw new Error(
        'No saved Agent Host credential. Set QWEN_AGENT_HOST_ENROLLMENT_TOKEN once.',
      );
    }
    const enrolled = await requestJson<{
      host: { id: string };
      secret: string;
    }>(`${serverUrl}/agent-hosts/enroll`, {
      method: 'POST',
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: options.workspaceId,
        token: options.enrollmentToken,
        name: options.name?.trim() || os.hostname(),
        workspaceCwd: options.workspaceCwd,
        providers: providersFor(probes),
      }),
    });
    assertOpen();
    credential = {
      schemaVersion: 1,
      serverUrl,
      workspaceId: options.workspaceId,
      hostId: enrolled.host.id,
      secret: enrolled.secret,
    };
    await writeCredential(filePath, credential, savedCurrentCredential);
  } else if (!savedCurrentCredential) {
    await writeCredential(filePath, credential, undefined);
  }
  const activeCredential = credential;

  /* -------------------------------------------------------------------- */
  /* Turns                                                                */
  /* -------------------------------------------------------------------- */

  /**
   * Stops a turn this Host may no longer finish: the adapter is cancelled,
   * then the `session_send` relay closes, and no result is posted.
   */
  const loseTurn = (turn: HostTurn, reason: string, cancelled = false) => {
    if (turn.lost) return;
    turn.lost = true;
    const error = new Error(reason);
    turn.controller.abort(error);
    turn.relay?.close();
    if (turn.flushTimer) {
      clearTimeout(turn.flushTimer);
      turn.flushTimer = undefined;
    }
    turn.pending = [];
    for (const waiter of turn.waiters.values()) waiter.reject(error);
    turn.waiters.clear();
    if (cancelled) {
      writeStderrLine(
        `qwen serve: run ${turn.assignment.runId} was stopped on the coordinator.`,
      );
    }
    refreshDecisionPoll();
  };

  const cancelTurn = (turn: HostTurn) =>
    loseTurn(turn, 'The run was cancelled on the coordinator.', true);

  /** Hands decision `key` to the current waiter of `requestId`. */
  const takeDecision = (
    turn: HostTurn,
    requestId: string,
    key: string,
    optionId: string,
  ): boolean => {
    const waiter = turn.waiters.get(requestId);
    if (!waiter) return false;
    turn.waiters.delete(requestId);
    turn.early.delete(requestId);
    turn.used.set(requestId, [
      ...(turn.used.get(requestId) ?? []).slice(1 - MAX_SEEN_PER_AWAITED),
      key,
    ]);
    waiter.resolve(optionId);
    return true;
  };

  /**
   * Applies decisions from any response. Idempotent: a resent decision is
   * taken once, and only by a waiter that has not used it.
   */
  const applyDecisions = (decisions: readonly HostDecision[] = []) => {
    let taken = false;
    for (const decision of decisions) {
      const turn = turns.get(decision.runId);
      if (
        !turn ||
        turn.lost ||
        turn.assignment.attempt !== decision.attempt ||
        turn.resolved.has(decision.requestId)
      ) {
        continue;
      }
      const key = hostDecisionKey(decision);
      if (turn.used.get(decision.requestId)?.includes(key)) continue;
      if (takeDecision(turn, decision.requestId, key, decision.optionId)) {
        taken = true;
        continue;
      }
      turn.early.set(decision.requestId, { key, optionId: decision.optionId });
    }
    if (taken) refreshDecisionPoll();
  };

  /* -------------------------------------------------------------------- */
  /* Decisions long-poll                                                  */
  /* -------------------------------------------------------------------- */

  /** The requests this Host's turns wait on, with the keys each has used. */
  const awaitedPermissions = (): HostAwaitedPermission[] => {
    const awaited: HostAwaitedPermission[] = [];
    for (const turn of turns.values()) {
      if (turn.lost) continue;
      for (const requestId of turn.waiters.keys()) {
        awaited.push({
          runId: turn.assignment.runId,
          attempt: turn.assignment.attempt,
          requestId,
          seen: turn.used.get(requestId) ?? [],
        });
      }
    }
    // TODO(multi-agent): past this many open requests the rest wait for the
    // heartbeat; 4 turns rarely hold more than one each.
    return awaited.slice(0, MAX_AWAITED);
  };

  let decisionPoll: AbortController | undefined;
  /**
   * Keeps exactly one decisions long-poll open while any turn waits on a
   * person, restarted whenever the set of waits changes so the coordinator
   * always matches against the current ones.
   */
  const refreshDecisionPoll = () => {
    decisionPoll?.abort();
    decisionPoll = undefined;
    if (stop.signal.aborted || awaitedPermissions().length === 0) return;
    const controller = new AbortController();
    decisionPoll = controller;
    const signal = AbortSignal.any([stop.signal, controller.signal]);
    void (async () => {
      while (!signal.aborted) {
        const awaiting = awaitedPermissions();
        if (awaiting.length === 0) break;
        try {
          applyDecisions(
            await pollDecisions(activeCredential, awaiting, signal),
          );
        } catch (error) {
          if (signal.aborted) break;
          if (isRevocation(error)) {
            await discardRevokedCredential(activeCredential).catch(
              () => undefined,
            );
            stop.abort(error);
            break;
          }
          // A coordinator without the decisions route answers 404 for
          // good; the heartbeat still brings decisions, so back off to it.
          await delay(
            isPermanentRejection(error) ? HEARTBEAT_MS : RETRY_MS,
            undefined,
            { signal },
          ).catch(() => undefined);
        }
      }
      if (decisionPoll === controller) decisionPoll = undefined;
    })();
  };

  /** Posts the next batch (or retries the unacknowledged one). */
  const sendBatch = async (turn: HostTurn): Promise<void> => {
    if (turn.lost || stop.signal.aborted) return;
    if (!turn.inflight) {
      if (turn.pending.length === 0) return;
      turn.sequence += 1;
      turn.inflight = {
        sequence: turn.sequence,
        events: takeBatch(turn.pending),
      };
    }
    const { assignment } = turn;
    const batch: HostTurnEventBatch = {
      sessionId: assignment.sessionId,
      runId: assignment.runId,
      attempt: assignment.attempt,
      leaseId: assignment.leaseId,
      ...turn.inflight,
    };
    try {
      const response = await requestJson<{
        decisions?: HostDecision[];
      }>(hostUrl(activeCredential, 'events'), {
        method: 'POST',
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]),
        headers: hostHeaders(activeCredential),
        body: JSON.stringify(batch),
      });
      turn.inflight = undefined;
      turn.renewedAt = Date.now();
      applyDecisions(response.decisions);
      if (turn.pending.length > 0) scheduleFlush(turn, 0);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (isCancellation(error)) {
        cancelTurn(turn);
        return;
      }
      if (status === 409 || status === 404 || isRevocation(error)) {
        // The run moved on (re-leased, or this Host was removed).
        loseTurn(turn, extractErrorMessage(error));
        return;
      }
      if (isPermanentRejection(error)) {
        // Resending gets the same answer (a batch too large, an event the
        // coordinator does not accept); drop it so the run is not stuck.
        writeStderrLine(
          `qwen serve: coordinator refused agent events; dropped ${turn.inflight?.events.length ?? 0}: ${extractErrorMessage(error)}`,
        );
        turn.inflight = undefined;
        if (turn.pending.length > 0) scheduleFlush(turn, 0);
        return;
      }
      // Transient: keep the batch and retry it with the same sequence (the
      // coordinator answers `duplicate` if the first one had landed).
      scheduleFlush(turn, RETRY_MS);
    }
  };

  const flush = (turn: HostTurn): Promise<void> => {
    turn.sendChain = turn.sendChain.then(() => sendBatch(turn));
    return turn.sendChain;
  };

  const scheduleFlush = (turn: HostTurn, delayMs = EVENT_FLUSH_MS) => {
    if (turn.flushTimer || turn.lost) return;
    turn.flushTimer = setTimeout(() => {
      turn.flushTimer = undefined;
      void flush(turn);
    }, delayMs);
    turn.flushTimer.unref?.();
  };

  const pushEvent = (turn: HostTurn, event: AgentAdapterEvent) => {
    if (turn.lost) return;
    if (event.type === 'permission_resolved') {
      turn.resolved.add(event.requestId);
      turn.early.delete(event.requestId);
      // Settled elsewhere (the adapter's own cancel): retire the waiter so the
      // decisions poll stops advertising it. A later awaitPermission for the
      // same id registers a fresh one.
      const waiter = turn.waiters.get(event.requestId);
      if (waiter) {
        turn.waiters.delete(event.requestId);
        waiter.reject(new Error('Permission resolved elsewhere.'));
        refreshDecisionPoll();
      }
    }
    turn.pending.push(event);
    scheduleFlush(turn);
  };

  const awaitPermission = (
    turn: HostTurn,
    prompt: SessionAgentPermissionPrompt,
  ): Promise<string> => {
    if (turn.lost) {
      return Promise.reject(new Error('Agent Host lease lost.'));
    }
    const { requestId } = prompt;
    // Waiting again on a request reported resolved makes it live again.
    turn.resolved.delete(requestId);
    // A re-armed wait (the adapter's bridge refused the vote) replaces the
    // previous one; decisions go to the current waiter only.
    const previous = turn.waiters.get(requestId);
    turn.waiters.delete(requestId);
    previous?.reject(new Error('Permission request re-armed.'));
    return new Promise<string>((resolve, reject) => {
      turn.waiters.set(requestId, { resolve, reject });
      const early = turn.early.get(requestId);
      if (
        early &&
        !turn.used.get(requestId)?.includes(early.key) &&
        takeDecision(turn, requestId, early.key, early.optionId)
      ) {
        return;
      }
      turn.early.delete(requestId);
      refreshDecisionPoll();
    });
  };

  /**
   * Drains every queued event; false if the lease or the Host went away. A
   * coordinator that keeps failing is given one lease term, then the result
   * goes out anyway (the heartbeat keeps the lease alive meanwhile).
   */
  const drain = async (turn: HostTurn): Promise<boolean> => {
    const deadline = Date.now() + TURN_LEASE_MS;
    if (turn.flushTimer) {
      clearTimeout(turn.flushTimer);
      turn.flushTimer = undefined;
    }
    while (!turn.lost && !stop.signal.aborted) {
      await flush(turn);
      if (turn.flushTimer) {
        clearTimeout(turn.flushTimer);
        turn.flushTimer = undefined;
      }
      if (!turn.inflight && turn.pending.length === 0) return true;
      // The last batch landed and more is queued: send it right away.
      if (!turn.inflight) continue;
      if (Date.now() - turn.renewedAt >= TURN_LEASE_MS) return false;
      if (Date.now() >= deadline) {
        writeStderrLine(
          'qwen serve: could not deliver all agent events; posting the result.',
        );
        return true;
      }
      await delay(RETRY_MS, undefined, { signal: stop.signal }).catch(
        () => undefined,
      );
    }
    return false;
  };

  const returnResult = async (turn: HostTurn, initial: HostTurnResult) => {
    let result = initial;
    for (;;) {
      options.generationGuard?.assertOpen();
      stop.signal.throwIfAborted();
      if (turn.lost) return;
      try {
        await requestJson(hostUrl(activeCredential, 'result'), {
          method: 'POST',
          headers: hostHeaders(activeCredential),
          body: JSON.stringify(result),
          signal: AbortSignal.any([
            stop.signal,
            AbortSignal.timeout(TURN_LEASE_MS),
          ]),
        });
        return;
      } catch (error) {
        stop.signal.throwIfAborted();
        if (isRevocation(error)) throw error;
        const status = (error as { status?: number }).status;
        const message = extractErrorMessage(error);
        if (status === 409) {
          if (isCancellation(error)) {
            writeStderrLine(
              `qwen serve: run ${turn.assignment.runId} was stopped on the coordinator; result discarded.`,
            );
            return;
          }
          writeStderrLine(
            `qwen serve: discarded agent turn result (${message}).`,
          );
          return;
        }
        if (isPermanentRejection(error)) {
          // Retrying would get the same answer. A rejected answer becomes a
          // failure the session can show; a rejected failure is dropped and
          // the lease runs out.
          if (result.result.status === 'failed') {
            writeStderrLine(
              `qwen serve: agent turn result rejected; giving up: ${message}`,
            );
            return;
          }
          result = {
            ...result,
            result: {
              status: 'failed',
              outputText: '',
              error: `The coordinator rejected this result: ${message}`.slice(
                0,
                MAX_RESULT_ERROR,
              ),
              ...(result.result.nativeSessionId
                ? { nativeSessionId: result.result.nativeSessionId }
                : {}),
            },
          };
          continue;
        }
        writeStderrLine(
          `qwen serve: agent turn result upload failed; retrying: ${message}`,
        );
        // The heartbeat keeps renewing this run's lease meanwhile.
        await delay(RETRY_MS, undefined, { signal: stop.signal });
      }
    }
  };

  const runAssignment = async (assignment: HostTurnAssignment) => {
    const turn: HostTurn = {
      assignment,
      controller: new AbortController(),
      lost: false,
      renewedAt: Date.now(),
      sequence: 0,
      pending: [],
      sendChain: Promise.resolve(),
      waiters: new Map(),
      early: new Map(),
      used: new Map(),
      resolved: new Set(),
    };
    turns.set(assignment.runId, turn);
    const stopTurn = () => turn.controller.abort(stop.signal.reason);
    if (stop.signal.aborted) stopTurn();
    else stop.signal.addEventListener('abort', stopTurn, { once: true });
    let relay: AgentHostRelayRun | undefined;
    let remoteQwenBound = false;
    let result: AgentAdapterTurnResult;
    try {
      // Qwen's hidden session id is planned per (agent, chat session), the
      // same id the coordinator would use locally.
      const nativeSessionId =
        assignment.nativeSessionId ??
        (assignment.program === 'qwen'
          ? sessionAgentNativeSessionId(
              assignment.agent.agentId,
              assignment.sessionId,
            )
          : undefined);
      // A `qwen` turn runs in a hidden `sourceType: 'agent'` session on this
      // Host's own bridge. The ACP child authorizes that session only through
      // a session-agents binding naming it, and the agent is not in this
      // Host's roster, so write a binding that carries the coordinator's
      // persona (`remotePersona`, see acpAgent session authorization).
      if (assignment.program === 'qwen' && nativeSessionId) {
        await markRemoteQwenTurn(
          options.workspaceCwd,
          assignment,
          nativeSessionId,
        );
        remoteQwenBound = true;
      }
      // qwen: the per-binding relay above, handed to the adapter. Other
      // programs start a process per turn, so a per-run relay fits them.
      const qwenSessionSend =
        assignment.program === 'qwen'
          ? qwenSessionSendFor(assignment)
          : undefined;
      if (qwenSessionSend) {
        const binding = qwenRelayBindings.get(qwenRelayKey(assignment));
        if (binding) binding.runId = assignment.runId;
      } else {
        relay = openAgentHostRelayRun(assignment.runId, (text) =>
          pushEvent(turn, { type: 'session_send', text }),
        );
      }
      turn.relay = relay;
      // Cancelled while the binding was being written: never start.
      if (turn.lost) relay?.close();
      turn.controller.signal.throwIfAborted();
      const sessionSendServer = sessionSendServerFor(relay);
      const adapter = getAdapter(assignment.program, {
        workspaceCwd: options.workspaceCwd,
        bridge: options.bridge,
        agentId: assignment.agent.agentId,
        ...(qwenSessionSend ? { sessionSend: qwenSessionSend } : {}),
      });
      result = await adapter.runTurn({
        prompt: assignment.prompt,
        ...(assignment.freshPrompt !== undefined
          ? { freshPrompt: assignment.freshPrompt }
          : {}),
        ...(assignment.agent.instructions
          ? { instructions: assignment.agent.instructions }
          : {}),
        ...(assignment.agent.model ? { model: assignment.agent.model } : {}),
        ...(nativeSessionId ? { nativeSessionId } : {}),
        cwd: options.workspaceCwd,
        ...(sessionSendServer ? { sessionSendServer } : {}),
        signal: turn.controller.signal,
        onEvent: (event) => pushEvent(turn, event),
        awaitPermission: (prompt) => awaitPermission(turn, prompt),
      });
    } catch (error) {
      result = {
        status: turn.controller.signal.aborted ? 'cancelled' : 'failed',
        outputText: '',
        error: extractErrorMessage(error),
      };
    } finally {
      stop.signal.removeEventListener('abort', stopTurn);
      relay?.close();
      if (remoteQwenBound) {
        await settleRemoteQwenTurn(options.workspaceCwd, assignment).catch(
          (error: unknown) =>
            writeStderrLine(
              `qwen serve: could not settle remote agent binding for run ${assignment.runId}: ${extractErrorMessage(error)}`,
            ),
        );
      }
      for (const waiter of turn.waiters.values()) {
        waiter.reject(new Error('Agent turn ended.'));
      }
      turn.waiters.clear();
      refreshDecisionPoll();
    }
    try {
      // Events (a `session_send` above all) must land before the result:
      // once the run is finished the coordinator refuses them.
      if (!(await drain(turn))) return;
      await returnResult(turn, {
        sessionId: assignment.sessionId,
        runId: assignment.runId,
        attempt: assignment.attempt,
        leaseId: assignment.leaseId,
        result: boundResult(result),
      });
    } finally {
      turns.delete(assignment.runId);
      refreshDecisionPoll();
    }
  };

  /* -------------------------------------------------------------------- */
  /* Heartbeat and pickup                                                  */
  /* -------------------------------------------------------------------- */

  let offline = false;
  const heartbeat = async (): Promise<boolean> => {
    try {
      assertOpen();
      // Cached by the probe (60 s); a CLI installed later shows up here.
      probes = await getHostProgramProbe().catch(() => probes);
      const response = await sendHeartbeat(activeCredential);
      const now = Date.now();
      for (const lease of response.leases ?? []) {
        const turn = turns.get(lease.runId);
        if (!turn) continue;
        if (lease.cancelled === true) cancelTurn(turn);
        else if (lease.ok) turn.renewedAt = now;
        else loseTurn(turn, 'The coordinator refused this run lease.');
      }
      applyDecisions(response.decisions);
      if (offline) {
        writeStderrLine(
          `qwen serve: Agent Host ${activeCredential.hostId} reconnected.`,
        );
      }
      offline = false;
      return true;
    } catch (error) {
      // Only the route's own credential rejection is a revocation; a bare
      // 401 also comes from the coordinator's bearer gate while the runtime
      // is still starting (or when collaboration is off), and deleting the
      // credential then strands the Host until someone re-joins it by hand.
      if (isRevocation(error)) {
        await discardRevokedCredential(activeCredential).catch(() => undefined);
        stop.abort(error);
      }
      if (options.generationGuard?.closed) {
        stop.abort(error);
      }
      // A lease nobody renewed for a full term is gone on the coordinator.
      const now = Date.now();
      for (const turn of turns.values()) {
        if (now - turn.renewedAt >= TURN_LEASE_MS) {
          loseTurn(turn, 'Lost contact with the coordinator.');
        }
      }
      if (stop.signal.aborted) return false;
      if (!offline) {
        writeStderrLine(
          `qwen serve: Agent Host heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      offline = true;
      return false;
    }
  };

  if (!(await heartbeat())) {
    stop.signal.throwIfAborted();
    throw new Error(
      'Agent Host could not confirm its connection to the coordinator. Check the callback URL and saved credential.',
    );
  }
  const timer = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  timer.unref?.();
  writeStderrLine(
    `qwen serve: connected as Agent Host ${activeCredential.hostId} for ${options.workspaceId}.`,
  );

  void (async () => {
    const running = new Set<Promise<void>>();
    try {
      for (;;) {
        assertOpen();
        while (running.size >= MAX_CONCURRENT_HOST_TURNS) {
          await Promise.race(running);
          assertOpen();
        }
        try {
          const assignment = await pickup(
            activeCredential,
            undefined,
            stop.signal,
          );
          assertOpen();
          if (!assignment) continue;
          if (assignment.protocol !== HOST_PROTOCOL_VERSION) {
            // A v1 coordinator hands out thread runs this Host no longer
            // executes; the run's lease lapses there.
            writeStderrLine(
              'qwen serve: the coordinator speaks an older Agent Host protocol; upgrade it to run agents on this Host.',
            );
            await delay(25_000, undefined, { signal: stop.signal });
            continue;
          }
          writeStderrLine(
            `qwen serve: Agent Host ${activeCredential.hostId} running ${assignment.agent.name} (${assignment.program}).`,
          );
          const task: Promise<void> = runAssignment(assignment)
            .catch(async (error: unknown) => {
              if (isRevocation(error)) {
                await discardRevokedCredential(activeCredential).catch(
                  () => undefined,
                );
                stop.abort(error);
                return;
              }
              if (!stop.signal.aborted) {
                writeStderrLine(
                  `qwen serve: agent turn failed: ${extractErrorMessage(error)}`,
                );
              }
            })
            .finally(() => {
              running.delete(task);
            });
          running.add(task);
        } catch (error) {
          if (isRevocation(error)) {
            await discardRevokedCredential(activeCredential).catch(
              () => undefined,
            );
            stop.abort(error);
            return;
          }
          if (options.generationGuard?.closed || stop.signal.aborted) {
            return;
          }
          writeStderrLine(
            `qwen serve: Agent Host pickup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          await delay(RETRY_MS);
        }
      }
    } catch (error) {
      if (!options.generationGuard?.closed && !stop.signal.aborted) {
        writeStderrLine(
          `qwen serve: Agent Host connection stopped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      clearInterval(timer);
      // A binding relay outlives its runs, not the connection. `close` is
      // identity-guarded, so a later connection's relay for the same
      // binding is left alone.
      for (const binding of qwenRelayBindings.values()) binding.relay.close();
      qwenRelayBindings.clear();
      // Turns stop with the connection (their listeners abort on `stop`).
      if (!stop.signal.aborted) {
        stop.abort(new Error('Agent Host connection stopped.'));
      }
      const key = connectionKey(
        serverUrl,
        options.workspaceId,
        options.workspaceCwd,
      );
      const active = activeConnections.get(key);
      if (
        active?.bridge === options.bridge &&
        active.generationGuard === options.generationGuard &&
        active.stop === stop
      ) {
        activeConnections.delete(key);
      }
    }
  })();
}

/**
 * Bind a coordinator's `qwen` turn to this Host's hidden agent session (see
 * `SessionAgentBinding.remotePersona`). The run entry has no lease: from this
 * daemon's point of view the turn executes locally.
 */
async function markRemoteQwenTurn(
  workspaceCwd: string,
  assignment: HostTurnAssignment,
  nativeSessionId: string,
): Promise<void> {
  const agentId = assignment.agent.agentId;
  await updateSessionAgents(workspaceCwd, assignment.sessionId, (file) => {
    file.bindings[agentId] = {
      ...file.bindings[agentId],
      agentId,
      nativeSessionId,
      remotePersona: {
        name: assignment.agent.name,
        ...(assignment.agent.instructions
          ? { instructions: assignment.agent.instructions }
          : {}),
        ...(assignment.agent.model ? { model: assignment.agent.model } : {}),
      },
    };
    file.runs = file.runs.filter((run) => run.id !== assignment.runId);
    file.runs.push({
      id: assignment.runId,
      agentId,
      status: 'running',
      triggerRecordIds: [],
      chainDepth: 0,
      createdAt: Date.now(),
      startedAt: Date.now(),
      attempts: assignment.attempt,
    });
  });
}

async function settleRemoteQwenTurn(
  workspaceCwd: string,
  assignment: HostTurnAssignment,
): Promise<void> {
  await updateSessionAgents(workspaceCwd, assignment.sessionId, (file) => {
    for (const run of file.runs) {
      if (run.id === assignment.runId && run.status === 'running') {
        run.status = 'completed';
        run.endedAt = Date.now();
      }
    }
  });
}
