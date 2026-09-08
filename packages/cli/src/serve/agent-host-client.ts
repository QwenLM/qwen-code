/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { isLoopbackBind } from './loopback-binds.js';

const HEARTBEAT_MS = 5_000;
const PROVIDERS = ['Qwen Code ACP'];

interface AgentHostCredential {
  schemaVersion: 1;
  serverUrl: string;
  workspaceId: string;
  hostId: string;
  secret: string;
}

export interface AgentHostConnectionOptions {
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
}
