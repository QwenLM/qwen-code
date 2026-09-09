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
import {
  ApprovalMode,
  SessionService,
  Storage,
  type HostRunAssignment,
  type HostRunResult,
} from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import { isLoopbackBind } from './loopback-binds.js';
import {
  AGENT_HOST_SESSION_SOURCE_TYPE,
  agentThreadSessionId,
} from '../runtime/agent-session-source.js';

const HEARTBEAT_MS = 5_000;
const LEASE_RENEW_MS = 20_000;
const RETRY_MS = 2_000;
const PROVIDERS = ['Qwen Code ACP'];

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
  name?: string;
}

function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password
  ) {
    throw new Error('--agent-host-server must be an HTTP(S) URL.');
  }
  if (url.protocol === 'http:' && !isLoopbackBind(url.hostname)) {
    throw new Error(
      '--agent-host-server requires HTTPS unless the primary daemon is on loopback.',
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

async function requestJson<T>(
  url: string,
  init: RequestInit,
): Promise<T> {
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
    instructions
      ? `Your workspace instructions:\n${instructions}`
      : undefined,
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

  const promptId = `agent-host:${assignment.runId}:${assignment.attempt}`;
  const renew = setInterval(
    () => void pickup(credential.serverUrl, credential, 0).catch(() => {}),
    LEASE_RENEW_MS,
  );
  renew.unref?.();
  try {
    await options.bridge.sendPrompt(
      sessionId,
      {
        sessionId,
        prompt: [{ type: 'text', text: assignment.prompt }],
      },
      undefined,
      { promptId, modelPrompt: modelPrompt(assignment) },
    );
  } finally {
    clearInterval(renew);
  }
  const turn = await options.bridge.getSessionTurnStatus(
    sessionId,
    undefined,
    promptId,
  );
  const summary = turn?.resultText?.trim();
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

export async function startAgentHostConnection(
  options: AgentHostConnectionOptions,
): Promise<void> {
  const serverUrl = normalizeServerUrl(options.serverUrl);
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
        providers: PROVIDERS,
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
            providers: PROVIDERS,
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
            status: 'failed',
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
