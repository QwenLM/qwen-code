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
import type {
  HostRunAssignment,
  HostRunResult,
} from '@qwen-code/qwen-code-core';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import { runCodexAppServer } from '../external-agents/codex-subagent-executor.js';
import { streamAgentTurn } from './workspace-agents/stream-agent-turn.js';
import { codexHostSession } from './workspace-agents/codex-host-session.js';
import { isLoopbackBind } from './loopback-binds.js';
import {
  AGENT_HOST_SESSION_SOURCE_TYPE,
  agentThreadSessionId,
} from '../runtime/agent-session-source.js';

const HEARTBEAT_MS = 5_000;
const LEASE_RENEW_MS = 20_000;
const RETRY_MS = 2_000;
const PROVIDER_LABELS = {
  qwen: 'Qwen Code ACP',
  codex: 'Codex CLI',
} as const;

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
  provider: keyof typeof PROVIDER_LABELS;
  enrollmentToken?: string;
  allowHttp?: boolean;
  name?: string;
}

function normalizeServerUrl(value: string, allowHttp = false): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password
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
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(credential, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await fs.rename(temporary, filePath);
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & T;
  if (!response.ok) {
    throw new Error(
      result.error ?? `Agent Host request failed (${response.status}).`,
    );
  }
  return result;
}

async function pickup(
  serverUrl: string,
  credential: AgentHostCredential,
  waitMs = 25_000,
): Promise<HostRunAssignment | undefined> {
  const response = await fetch(
    `${serverUrl}/agent-hosts/${encodeURIComponent(credential.workspaceId)}/${encodeURIComponent(credential.hostId)}/pickup`,
    {
      method: 'POST',
      headers: {
        authorization: `AgentHost ${credential.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ waitMs }),
    },
  );
  if (response.status === 204) return undefined;
  const result = (await response.json().catch(() => ({}))) as {
    assignment?: HostRunAssignment;
    error?: string;
  };
  if (!response.ok || !result.assignment) {
    throw new Error(
      result.error ?? `Agent Host pickup failed (${response.status}).`,
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
): Promise<HostRunResult> {
  const promptId = `agent-host:${assignment.runId}:${assignment.attempt}`;
  const execution = new AbortController();
  let finished = false;
  const renewLease = async () => {
    try {
      const response = await requestJson<{ lease?: { leaseId: string } }>(
        `${credential.serverUrl}/agent-hosts/${encodeURIComponent(credential.workspaceId)}/${encodeURIComponent(credential.hostId)}/heartbeat`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: {
            authorization: `AgentHost ${credential.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            workspaceCwd: options.workspaceCwd,
            providers: [PROVIDER_LABELS[options.provider]],
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
        throw new Error(
          'Coordinator did not confirm the run lease. Upgrade the coordinator.',
        );
      }
    } catch (error) {
      if (!finished) execution.abort(error);
    }
  };
  await renewLease();
  execution.signal.throwIfAborted();
  const renew = setInterval(() => void renewLease(), LEASE_RENEW_MS);
  const updates = new AbortController();
  let stream: Promise<void> | undefined;
  let progress = {
    sequence: 1,
    stage: 'starting',
    detail: '执行器已接单，正在启动',
    outputText: '',
    thoughtText: '',
  };
  let sending = false;
  const flush = async () => {
    if (sending) return;
    sending = true;
    try {
      await requestJson(
        `${credential.serverUrl}/agent-hosts/${encodeURIComponent(credential.workspaceId)}/${encodeURIComponent(credential.hostId)}/progress`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(4000),
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
  ) => {
    // ponytail: bounded live preview; the final result retains the full answer.
    progress = {
      sequence: progress.sequence + 1,
      stage,
      detail: detail.slice(0, 1200),
      outputText: outputText.slice(0, 262144),
      thoughtText: thoughtText.slice(0, 65536),
    };
  };
  const progressHeartbeat = setInterval(() => void flush(), 500);
  progressHeartbeat.unref?.();
  renew.unref?.();
  let summary: string | undefined;
  try {
    if (options.provider === 'codex') {
      const session = await codexHostSession(
        path.join(Storage.getGlobalQwenDir(), 'agent-hosts', 'codex-sessions'),
        [
          credential.serverUrl,
          credential.workspaceId,
          credential.hostId,
          options.workspaceCwd,
          assignment.agent.id,
          assignment.threadId,
        ],
      );
      if (session.threadId) report('resuming', '正在继续原 Codex 会话');
      const messages = new Map<string, string>();
      summary = await runCodexAppServer(
        {
          command: 'codex',
          cwd: options.workspaceCwd,
          session,
          keepAlive: true,
          onMessage: (id, text) => {
            messages.set(id, text);
            report(
              'responding',
              '正在回复',
              [...messages.values()].join('\n\n'),
            );
          },
          onActivity: report,
          onThought: (delta) =>
            report(
              'thinking',
              'Codex 正在思考',
              undefined,
              progress.thoughtText + delta,
            ),
        },
        modelPrompt(assignment),
        'read-only',
        execution.signal,
      );
    } else {
      void flush();
      const sessionId = agentThreadSessionId(
        `${credential.hostId}:${assignment.agent.id}`,
        assignment.threadId,
      );
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
      stream = streamAgentTurn(
        options.bridge,
        sessionId,
        promptId,
        AbortSignal.any([updates.signal, execution.signal]),
        report,
      ).catch((error: unknown) => {
        if (!updates.signal.aborted) execution.abort(error);
      });
      report('waiting', 'Qwen Code 已接单，等待模型回复');
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
            throw new Error(turn.error?.message ?? 'Managed Agent cancelled.');
          }
          if (turn.state === 'completed') {
            summary = turn.resultText?.trim();
            break;
          }
        }
        await delay(250, undefined, { signal: execution.signal });
      }
    }
    execution.signal.throwIfAborted();
  } catch (error) {
    throw execution.signal.aborted ? execution.signal.reason : error;
  } finally {
    finished = true;
    clearInterval(renew);
    clearInterval(progressHeartbeat);
    updates.abort();
    await stream;
    await flush();
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
    close: { kind: 'review', summary },
  };
}

async function returnResult(
  serverUrl: string,
  credential: AgentHostCredential,
  result: HostRunResult,
): Promise<void> {
  for (;;) {
    try {
      await requestJson(
        `${serverUrl}/agent-hosts/${encodeURIComponent(credential.workspaceId)}/${encodeURIComponent(credential.hostId)}/result`,
        {
          method: 'POST',
          headers: {
            authorization: `AgentHost ${credential.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(result),
        },
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'stale_lease' || message === 'attempt_moved_on') {
        writeStderrLine(
          `qwen serve: discarded managed Agent result (${message}).`,
        );
        return;
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
  { provider: string; start: Promise<void> }
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
    if (existing.provider !== options.provider)
      throw new Error(
        'This workspace already has a Host connection using another provider.',
      );
    return existing.start;
  }
  const start = connectAgentHost(options);
  activeConnections.set(key, { provider: options.provider, start });
  try {
    await start;
  } catch (error) {
    activeConnections.delete(key);
    throw error;
  }
}

async function connectAgentHost(
  options: AgentHostConnectionOptions,
): Promise<void> {
  const providers = [PROVIDER_LABELS[options.provider]];
  const serverUrl = normalizeServerUrl(options.serverUrl, options.allowHttp);
  if (
    new URL(serverUrl).protocol === 'http:' &&
    !isLoopbackBind(new URL(serverUrl).hostname)
  ) {
    writeStderrLine(
      'WARNING: Agent Host HTTP demo mode sends credentials, task content and results without encryption. Use only on a trusted network.',
    );
  }
  const filePath = credentialPath(
    serverUrl,
    options.workspaceId,
    options.workspaceCwd,
  );
  let credential = await readCredential(filePath);
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: options.workspaceId,
        token: options.enrollmentToken,
        name: options.name?.trim() || os.hostname(),
        workspaceCwd: options.workspaceCwd,
        providers,
      }),
    });
    credential = {
      schemaVersion: 1,
      serverUrl,
      workspaceId: options.workspaceId,
      hostId: enrolled.host.id,
      secret: enrolled.secret,
    };
    await writeCredential(filePath, credential);
  }
  const activeCredential = credential;

  let offline = false;
  const heartbeat = async (): Promise<void> => {
    try {
      await requestJson(
        `${serverUrl}/agent-hosts/${encodeURIComponent(activeCredential.workspaceId)}/${encodeURIComponent(activeCredential.hostId)}/heartbeat`,
        {
          method: 'POST',
          headers: {
            authorization: `AgentHost ${activeCredential.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            workspaceCwd: options.workspaceCwd,
            providers,
          }),
        },
      );
      if (offline) {
        writeStderrLine(
          `qwen serve: Agent Host ${activeCredential.hostId} reconnected.`,
        );
      }
      offline = false;
    } catch (error) {
      if (!offline) {
        writeStderrLine(
          `qwen serve: Agent Host heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      offline = true;
    }
  };

  await heartbeat();
  if (offline) {
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
    for (;;) {
      try {
        const assignment = await pickup(serverUrl, activeCredential);
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
            error: error instanceof Error ? error.message : String(error),
          };
        }
        await returnResult(serverUrl, activeCredential, result);
      } catch (error) {
        writeStderrLine(
          `qwen serve: Agent Host pickup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await delay(RETRY_MS);
      }
    }
  })();
}
