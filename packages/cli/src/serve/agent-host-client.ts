/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { extractErrorMessage } from '@qwen-code/acp-bridge/bridge';
import type {
  HostRunAssignment,
  HostRunResult,
} from '@qwen-code/qwen-code-core';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { DEFAULT_RUN_LEASE_MS } from '@qwen-code/qwen-code-core/agents/workspace-agents/host-lease.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import type { WorkspaceGenerationGuard } from './workspace-registry.js';
import { selectRejectOption } from '../external-agents/acp-subagent-executor.js';
import { streamAgentTurn } from './workspace-agents/stream-agent-turn.js';
import type { AgentRunStep } from './workspace-agents/agent-events.js';
import { isLoopbackBind } from './loopback-binds.js';
import {
  AGENT_HOST_SESSION_SOURCE_TYPE,
  agentThreadSessionId,
} from '../runtime/agent-session-source.js';
import {
  AGENT_HOST_CREDENTIAL_REJECTED,
  AGENT_HOST_REPLACEMENT_REQUIRED,
  AGENT_PROGRAM_LABELS,
  type AgentProgram,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/types.js';

const HEARTBEAT_MS = 5_000;
const LEASE_RENEW_MS = 20_000;
const RETRY_MS = 2_000;
const HOST_PROVIDER: AgentProgram = 'qwen';
const HOST_PROVIDERS = [AGENT_PROGRAM_LABELS[HOST_PROVIDER]];

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

function normalizeServerUrl(value: string, allowHttp = false): string {
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
  } & T;
  if (!response.ok) {
    throw Object.assign(
      new Error(
        result.error ?? `Agent Host request failed (${response.status}).`,
      ),
      { status: response.status },
    );
  }
  return result;
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

async function pickup(
  credential: AgentHostCredential,
  waitMs = 25_000,
  stopSignal?: AbortSignal,
): Promise<HostRunAssignment | undefined> {
  const response = await fetch(
    `${credential.serverUrl}/agent-hosts/${encodeURIComponent(credential.workspaceId)}/${encodeURIComponent(credential.hostId)}/pickup`,
    {
      method: 'POST',
      headers: {
        authorization: `AgentHost ${credential.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ waitMs }),
      signal: stopSignal
        ? AbortSignal.any([stopSignal, AbortSignal.timeout(waitMs + 10_000)])
        : AbortSignal.timeout(waitMs + 10_000),
      redirect: 'error',
    },
  );
  if (response.status === 204) return undefined;
  const result = (await response.json().catch(() => ({}))) as {
    assignment?: HostRunAssignment;
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

function modelPrompt(assignment: HostRunAssignment): string {
  const instructions = assignment.agent.instructions?.trim();
  return [
    `You are ${assignment.agent.name}, an independent persistent workspace Agent running on a managed Host.`,
    instructions ? `Your workspace instructions:\n${instructions}` : undefined,
    'Work on the assigned task using read-only inspection tools. Do not call thread_* tools on this Host. End with a concise result for the parent Agent or person; the Host will post it back to the shared thread.',
    assignment.prompt,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function executeAssignment(
  options: AgentHostConnectionOptions,
  credential: AgentHostCredential,
  assignment: HostRunAssignment,
  stopSignal?: AbortSignal,
): Promise<HostRunResult> {
  const requestedProvider =
    assignment.agent.execution?.mode === 'managed-host'
      ? assignment.agent.execution.provider
      : undefined;
  if (requestedProvider && requestedProvider !== HOST_PROVIDER) {
    throw new Error(
      `This Agent Host cannot run the requested ${requestedProvider} provider.`,
    );
  }
  const promptId = `agent-host:${assignment.runId}:${assignment.attempt}`;
  const execution = new AbortController();
  const stopExecution = () => execution.abort(stopSignal?.reason);
  if (stopSignal?.aborted) stopExecution();
  else stopSignal?.addEventListener('abort', stopExecution, { once: true });
  execution.signal.throwIfAborted();
  let finished = false;
  // Measured on this host's clock: the coordinator's may disagree. A held
  // lease re-picked keeps its first `acquiredAt`, so the span is capped at
  // one lease term rather than read as a longer one.
  const leaseMs = Math.min(
    assignment.lease.expiresAt - assignment.lease.acquiredAt,
    DEFAULT_RUN_LEASE_MS,
  );
  let renewedAt = Date.now();
  const renewLease = async () => {
    try {
      options.generationGuard?.assertOpen();
      const response = await requestJson<{ lease?: { leaseId: string } }>(
        `${credential.serverUrl}/agent-hosts/${encodeURIComponent(credential.workspaceId)}/${encodeURIComponent(credential.hostId)}/heartbeat`,
        {
          method: 'POST',
          signal: AbortSignal.any([
            execution.signal,
            AbortSignal.timeout(10_000),
          ]),
          headers: {
            authorization: `AgentHost ${credential.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            workspaceCwd: options.workspaceCwd,
            providers: HOST_PROVIDERS,
            run: {
              threadId: assignment.threadId,
              runId: assignment.runId,
              leaseId: assignment.lease.leaseId,
              attempt: assignment.attempt,
            },
          }),
        },
      );
      if (response.lease?.leaseId !== assignment.lease.leaseId) {
        throw Object.assign(
          new Error(
            'Coordinator did not confirm the run lease. Upgrade the coordinator.',
          ),
          { status: 409 },
        );
      }
      renewedAt = Date.now();
    } catch (error) {
      // A timeout or a busy store leaves most of the lease; the next renewal
      // may land. Only a lost credential or lease, or a lease that has run
      // out, ends the run.
      const status = (error as { status?: number }).status;
      if (
        !finished &&
        (options.generationGuard?.closed ||
          status === 401 ||
          status === 404 ||
          status === 409 ||
          Date.now() - renewedAt >= leaseMs)
      ) {
        execution.abort(error);
      }
    }
  };
  await renewLease();
  if (execution.signal.aborted) {
    stopSignal?.removeEventListener('abort', stopExecution);
  }
  execution.signal.throwIfAborted();
  const renew = setInterval(() => void renewLease(), LEASE_RENEW_MS);
  const updates = new AbortController();
  let stream: Promise<void> | undefined;
  let progress: {
    sequence: number;
    stage: string;
    detail: string;
    outputText: string;
    thoughtText: string;
    steps?: AgentRunStep[];
  } = {
    sequence: 1,
    stage: 'starting',
    detail: 'Assignment accepted; starting the executor',
    outputText: '',
    thoughtText: '',
  };
  // Set once Qwen Code's session stats are available. Without it the
  // coordinator never charged a remote run, and a tree could spend past its
  // budget on another machine.
  let measureTokens: (() => Promise<number | undefined>) | undefined;
  let sending = false;
  const flush = async () => {
    if (sending || execution.signal.aborted) return;
    sending = true;
    try {
      const tokens = await measureTokens?.();
      execution.signal.throwIfAborted();
      await requestJson(
        `${credential.serverUrl}/agent-hosts/${encodeURIComponent(credential.workspaceId)}/${encodeURIComponent(credential.hostId)}/progress`,
        {
          method: 'POST',
          signal: AbortSignal.any([
            execution.signal,
            AbortSignal.timeout(4000),
          ]),
          headers: {
            authorization: `AgentHost ${credential.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...progress,
            threadId: assignment.threadId,
            runId: assignment.runId,
            leaseId: assignment.lease.leaseId,
            attempt: assignment.attempt,
            ...(tokens !== undefined ? { tokens } : {}),
          }),
        },
      );
    } catch {
      // Telemetry is retried by the next heartbeat, never blocks execution.
    } finally {
      sending = false;
    }
  };
  const report = (
    stage: string,
    detail: string,
    outputText = progress.outputText,
    thoughtText = progress.thoughtText,
    steps = progress.steps,
  ) => {
    // ponytail: bounded live preview; the final result retains the full answer.
    progress = {
      sequence: progress.sequence + 1,
      stage,
      detail: detail.slice(0, 1200),
      outputText: outputText.slice(0, 262144),
      thoughtText: thoughtText.slice(0, 65536),
      ...(steps ? { steps } : {}),
    };
  };
  const progressHeartbeat = setInterval(() => void flush(), 2000);
  progressHeartbeat.unref?.();
  renew.unref?.();
  let summary: string | undefined;
  let tokens: number | undefined;
  const sessionId = agentThreadSessionId(
    `${credential.hostId}:${assignment.agent.id}`,
    assignment.threadId,
  );
  let sessionReady = false;
  try {
    void flush();
    const sourceId = `${credential.hostId}:${assignment.agent.id}`;
    const sessions = new SessionService(options.workspaceCwd);
    const live = options.bridge
      .listWorkspaceSessions(options.workspaceCwd)
      .find((session) => session.sessionId === sessionId);
    if (!live) {
      const request = {
        workspaceCwd: options.workspaceCwd,
        sessionId,
        sourceType: AGENT_HOST_SESSION_SOURCE_TYPE,
        sourceId,
        approvalMode: ApprovalMode.PLAN,
      };
      if (await sessions.sessionExists(sessionId)) {
        await options.bridge.resumeSession(request);
      } else {
        await options.bridge.spawnOrAttach({
          ...request,
          sessionScope: 'thread',
        });
      }
    }
    sessionReady = true;
    stream = streamAgentTurn(
      options.bridge,
      sessionId,
      promptId,
      AbortSignal.any([updates.signal, execution.signal]),
      (update) => {
        if (update.permission) {
          // Nobody on this host can approve, and the turn would wait on it
          // for good.
          const optionId = selectRejectOption(
            update.permission.options.map((option) => ({
              optionId: option.optionId,
              kind: option.kind,
            })),
          );
          options.bridge.respondToSessionPermission(
            sessionId,
            update.permission.requestId,
            optionId
              ? { outcome: { outcome: 'selected', optionId } }
              : { outcome: { outcome: 'cancelled' } },
          );
          return;
        }
        report(
          update.stage,
          update.detail ?? '',
          update.outputText,
          update.thoughtText,
          update.steps,
        );
      },
    ).catch((error: unknown) => {
      if (!updates.signal.aborted) execution.abort(error);
    });
    const sessionTotal = async (): Promise<number | undefined> => {
      try {
        const stats = await options.bridge.getSessionStatsStatus(sessionId);
        return Object.values(stats.models).reduce(
          (total, model) => total + (model.tokens?.total ?? 0),
          0,
        );
      } catch {
        return undefined;
      }
    };
    // The session carries earlier turns on this thread; only what this
    // attempt adds is its spend.
    const baseline = await sessionTotal();
    if (baseline !== undefined) {
      measureTokens = async () => {
        const total = await sessionTotal();
        return total === undefined ? undefined : Math.max(0, total - baseline);
      };
    }
    report('waiting', 'Qwen Code accepted the task; waiting for the model.');
    await options.bridge.sendPrompt(
      sessionId,
      {
        sessionId,
        prompt: [{ type: 'text', text: assignment.prompt }],
      },
      execution.signal,
      { promptId, modelPrompt: modelPrompt(assignment) },
    );
    for (;;) {
      execution.signal.throwIfAborted();
      const turn = await options.bridge.getSessionTurnStatus(
        sessionId,
        undefined,
        promptId,
      );
      if (turn?.promptId === promptId) {
        if (turn.state === 'error' || turn.state === 'cancelled') {
          throw new Error(
            extractErrorMessage(turn.error ?? 'Managed Agent cancelled.'),
          );
        }
        if (turn.state === 'completed') {
          summary = turn.resultText?.trim();
          break;
        }
      }
      await delay(250, undefined, { signal: execution.signal });
    }
    execution.signal.throwIfAborted();
  } catch (error) {
    throw execution.signal.aborted ? execution.signal.reason : error;
  } finally {
    stopSignal?.removeEventListener('abort', stopExecution);
    finished = true;
    clearInterval(renew);
    clearInterval(progressHeartbeat);
    updates.abort();
    await stream;
    await flush();
    tokens = await measureTokens?.();
    if (sessionReady) {
      await options.bridge
        .closeSession(sessionId, undefined, {
          requireAgentClose: true,
          agentCloseTimeoutMs: 10_000,
        })
        .catch((error: unknown) => {
          writeStderrLine(
            `Agent Host could not close session: ${String(error)}`,
          );
        });
    }
  }
  if (!summary) {
    throw new Error('Managed Agent finished without a final answer.');
  }
  return {
    threadId: assignment.threadId,
    runId: assignment.runId,
    hostId: credential.hostId,
    leaseId: assignment.lease.leaseId,
    attempt: assignment.attempt,
    status: 'completed',
    // The coordinator refuses a summary past this bound with a 400, which
    // this client treats as permanent; sending it bounded keeps the answer.
    close: { kind: 'review', summary: summary.slice(0, 262_144) },
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

async function returnResult(
  credential: AgentHostCredential,
  initial: HostRunResult,
  generationGuard?: WorkspaceGenerationGuard,
  stopSignal?: AbortSignal,
): Promise<void> {
  let result = initial;
  for (;;) {
    generationGuard?.assertOpen();
    stopSignal?.throwIfAborted();
    try {
      await requestJson(
        `${credential.serverUrl}/agent-hosts/${encodeURIComponent(credential.workspaceId)}/${encodeURIComponent(credential.hostId)}/result`,
        {
          method: 'POST',
          headers: {
            authorization: `AgentHost ${credential.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(result),
          signal: stopSignal
            ? AbortSignal.any([
                stopSignal,
                AbortSignal.timeout(DEFAULT_RUN_LEASE_MS),
              ])
            : AbortSignal.timeout(DEFAULT_RUN_LEASE_MS),
        },
      );
      return;
    } catch (error) {
      stopSignal?.throwIfAborted();
      if ((error as { status?: number }).status === 401) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'stale_lease' || message === 'attempt_moved_on') {
        writeStderrLine(
          `qwen serve: discarded managed Agent result (${message}).`,
        );
        return;
      }
      if (isPermanentRejection(error)) {
        // Retrying would get the same answer and hold this host forever. A
        // rejected answer becomes a failure the thread can show; a rejected
        // failure is dropped and the lease runs out.
        if (result.status === 'failed') {
          writeStderrLine(
            `qwen serve: managed Agent result rejected; giving up: ${message}`,
          );
          return;
        }
        const { close: _close, ...rest } = result;
        result = {
          ...rest,
          status: 'failed',
          error: `The coordinator rejected this result: ${message}`,
        };
        continue;
      }
      writeStderrLine(
        `qwen serve: managed Agent result upload failed; retrying: ${message}`,
      );
      await delay(RETRY_MS);
    }
  }
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

export async function startAgentHostConnection(
  options: AgentHostConnectionOptions,
): Promise<void> {
  const key = JSON.stringify([
    normalizeServerUrl(options.serverUrl, options.allowHttp),
    options.workspaceId,
    options.workspaceCwd,
  ]);
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

async function connectAgentHost(
  options: AgentHostConnectionOptions,
  stop: AbortController,
): Promise<void> {
  const assertOpen = () => {
    options.generationGuard?.assertOpen();
    stop.signal.throwIfAborted();
  };
  assertOpen();
  const providers = HOST_PROVIDERS;
  const serverUrl = normalizeServerUrl(options.serverUrl, options.allowHttp);
  if (
    new URL(serverUrl).protocol === 'http:' &&
    !isLoopbackBind(new URL(serverUrl).hostname)
  ) {
    writeStderrLine(
      'WARNING: Agent Host HTTP demo mode sends credentials, task content and results without encryption. Use only on a trusted network.',
    );
  }
  const legacyFilePath = credentialPath(
    serverUrl,
    options.workspaceId,
    options.workspaceCwd,
  );
  // Old clients delete their legacy file on revocation without checking its
  // identity. Keep updated credentials outside that deletion path.
  const filePath = legacyFilePath.replace(/\.json$/, '.v2.json');
  const savedCurrentCredential = await readCredential(filePath);
  let credential =
    savedCurrentCredential ?? (await readCredential(legacyFilePath));
  const discardRevokedCredential = async (expected: AgentHostCredential) => {
    await removeRevokedCredential(filePath, expected);
    await removeRevokedCredential(legacyFilePath, expected);
  };
  assertOpen();
  const sendHeartbeat = async (
    target: AgentHostCredential,
    enrollmentToken?: string,
  ): Promise<void> => {
    await requestJson(
      `${serverUrl}/agent-hosts/${encodeURIComponent(target.workspaceId)}/${encodeURIComponent(target.hostId)}/heartbeat`,
      {
        method: 'POST',
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]),
        headers: {
          authorization: `AgentHost ${target.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          workspaceCwd: options.workspaceCwd,
          providers,
          ...(enrollmentToken ? { enrollmentToken } : {}),
        }),
      },
    );
  };
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
        providers,
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

  let offline = false;
  const heartbeat = async (): Promise<boolean> => {
    try {
      assertOpen();
      await sendHeartbeat(activeCredential);
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
    try {
      for (;;) {
        assertOpen();
        try {
          const assignment = await pickup(
            activeCredential,
            undefined,
            stop.signal,
          );
          assertOpen();
          if (!assignment) continue;
          writeStderrLine(
            `qwen serve: Agent Host ${activeCredential.hostId} running ${assignment.agent.name} on ${assignment.threadId}.`,
          );
          let result: HostRunResult;
          try {
            result = await executeAssignment(
              options,
              activeCredential,
              assignment,
              stop.signal,
            );
          } catch (error) {
            result = {
              threadId: assignment.threadId,
              runId: assignment.runId,
              hostId: activeCredential.hostId,
              leaseId: assignment.lease.leaseId,
              attempt: assignment.attempt,
              status:
                error instanceof Error && error.message === 'not_leasable'
                  ? 'cancelled'
                  : 'failed',
              error: extractErrorMessage(error),
            };
          }
          await returnResult(
            activeCredential,
            result,
            options.generationGuard,
            stop.signal,
          );
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
      const active = activeConnections.get(
        JSON.stringify([serverUrl, options.workspaceId, options.workspaceCwd]),
      );
      if (
        active?.bridge === options.bridge &&
        active.generationGuard === options.generationGuard &&
        active.stop === stop
      ) {
        activeConnections.delete(
          JSON.stringify([
            serverUrl,
            options.workspaceId,
            options.workspaceCwd,
          ]),
        );
      }
    }
  })();
}
