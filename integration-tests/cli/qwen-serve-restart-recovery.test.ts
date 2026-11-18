/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN =
  process.env['TEST_CLI_PATH'] ??
  path.resolve(__dirname, '../../packages/cli/dist/index.js');
const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
      process.env['QWEN_SANDBOX']!.toLowerCase() !== 'false',
  ) ||
  !existsSync(CLI_BIN);

interface RunningDaemon {
  child: ChildProcess;
  baseUrl: string;
  stdout: string;
  stderr: string;
}

interface JsonResponse {
  status: number;
  body: unknown;
}

interface RecoveryItem {
  sessionId: string;
  interruption: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function jsonFetch(
  baseUrl: string,
  route: string,
  init?: RequestInit,
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep the raw text for diagnostics.
  }
  return { status: response.status, body };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recoveryItems(body: unknown): RecoveryItem[] | undefined {
  const record = asRecord(body);
  const workspaces = record?.['workspaces'];
  if (!Array.isArray(workspaces)) return undefined;
  const first = asRecord(workspaces[0]);
  const items = first?.['items'];
  if (!Array.isArray(items)) return undefined;
  return items.flatMap((item) => {
    const entry = asRecord(item);
    return typeof entry?.['sessionId'] === 'string' &&
      typeof entry['interruption'] === 'string'
      ? [
          {
            sessionId: entry['sessionId'],
            interruption: entry['interruption'],
          },
        ]
      : [];
  });
}

function findSessionFile(
  workspace: string,
  sessionId: string,
  suffix: string,
): string | undefined {
  const visit = (dir: string): string | undefined => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry);
      let stats;
      try {
        stats = statSync(candidate);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        const found = visit(candidate);
        if (found) return found;
      } else if (entry === `${sessionId}${suffix}`) {
        return candidate;
      }
    }
    return undefined;
  };
  return visit(path.join(workspace, 'projects'));
}

async function waitForContinuationEvidence(
  workspace: string,
  sessionId: string,
  promptId: string,
): Promise<void> {
  await waitFor(
    'continued transcript',
    async () => {
      const transcriptPath = findSessionFile(workspace, sessionId, '.jsonl');
      if (!transcriptPath) return false;
      const transcript = readFileSync(transcriptPath, 'utf8');
      return (
        transcript.includes('recovered answer after restart') &&
        transcript.includes(promptId)
      );
    },
    60_000,
  );

  const ledgerPath = findSessionFile(workspace, sessionId, '.ledger.jsonl');
  expect(ledgerPath).toBeTruthy();
  await waitFor(
    'continued ledger terminal',
    async () => {
      const ledger = ledgerPath ? readFileSync(ledgerPath, 'utf8') : '';
      return ledger.split('\n').some((line) => {
        if (!line) return false;
        try {
          const record = JSON.parse(line) as {
            promptId?: unknown;
            terminal?: unknown;
          };
          return (
            record.promptId === promptId && record.terminal === 'completed'
          );
        } catch {
          return false;
        }
      });
    },
    30_000,
  );
}

function daemonEnv(workspace: string, qwenHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    QWEN_CODE_NO_RELAUNCH: '1',
    QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
    QWEN_HOME: qwenHome,
    QWEN_RUNTIME_DIR: workspace,
    QWEN_SERVE_RATE_LIMIT: '0',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

function signalDaemonGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    child.kill('SIGKILL');
  }
}

async function startDaemon(
  workspace: string,
  qwenHome: string,
  fakeBaseUrl: string,
  cliPath = CLI_BIN,
): Promise<RunningDaemon> {
  const child = spawn(
    process.execPath,
    [
      cliPath,
      'serve',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
      '--workspace',
      workspace,
      '--no-web',
      '--no-open',
      '--chat-recording',
      '--session-reap-interval-ms',
      '0',
      '--session-idle-timeout-ms',
      '600000',
      '--rate-limit-prompt',
      '0',
      '--rate-limit-window-ms',
      '1',
    ],
    {
      cwd: path.resolve(__dirname, '../..'),
      detached: process.platform !== 'win32',
      env: {
        ...daemonEnv(workspace, qwenHome),
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: fakeBaseUrl,
        OPENAI_MODEL: 'fake-model',
        QWEN_MODEL: 'fake-model',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const running: RunningDaemon = {
    child,
    baseUrl: '',
    stdout: '',
    stderr: '',
  };
  child.stdout?.on('data', (chunk) => {
    running.stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    running.stderr += String(chunk);
  });
  running.baseUrl = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      signalDaemonGroup(child, 'SIGKILL');
      reject(
        new Error(
          `${message}; stdout=${running.stdout}; stderr=${running.stderr}`,
        ),
      );
    };
    const timer = setTimeout(() => fail('daemon boot timeout'), 30_000);
    const onData = (chunk: Buffer) => {
      const match = `${running.stdout}${chunk}`.match(
        /listening on http:\/\/127\.0\.0\.1:(\d+)/,
      );
      if (!match || settled) return;
      settled = true;
      cleanup();
      resolve(`http://127.0.0.1:${match[1]}`);
    };
    const onExit = (code: number | null) => {
      fail(`daemon exited before listening with ${code}`);
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
  return running;
}

async function stopDaemon(
  daemon: RunningDaemon,
  options: { signal?: NodeJS.Signals; group?: boolean; waitMs?: number } = {},
): Promise<void> {
  if (daemon.child.exitCode !== null) return;
  const signal = options.signal ?? 'SIGKILL';
  const group = options.group ?? true;
  const waitMs = options.waitMs ?? 15_000;
  if (group) {
    signalDaemonGroup(daemon.child, signal);
  } else {
    daemon.child.kill(signal);
  }
  await Promise.race([once(daemon.child, 'exit'), sleep(waitMs)]).catch(
    () => undefined,
  );
  if (daemon.child.exitCode === null) {
    signalDaemonGroup(daemon.child, 'SIGKILL');
    await Promise.race([once(daemon.child, 'exit'), sleep(5_000)]).catch(
      () => undefined,
    );
  }
}

const describeDaemon = SKIP ? describe.skip : describe;

describeDaemon('qwen serve — restart recovery', () => {
  let root = '';
  let workspace = '';
  let qwenHome = '';
  let fake: FakeOpenAIServer | undefined;
  let daemon: RunningDaemon | undefined;
  const holdState: { release?: () => void } = {};
  const releaseHeld = () => {
    holdState.release?.();
  };
  let holdNext = true;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'qwen-restart-recovery-'));
    workspace = path.join(root, 'workspace');
    qwenHome = path.join(root, 'qwen-home');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(qwenHome, { recursive: true });
    writeFileSync(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify(
        {
          security: { auth: { selectedType: 'openai' } },
          model: { name: 'fake-model' },
          general: { chatRecording: true },
          telemetry: { enabled: false },
        },
        null,
        2,
      ),
    );
    fake = await startFakeOpenAIServer(
      () => {
        if (holdNext) {
          holdNext = false;
          const hold = new Promise<void>((resolve) => {
            holdState.release = resolve;
          });
          return {
            contentChunks: ['partial response before the crash'],
            holdAfterChunks: 1,
            holdUntil: hold,
          };
        }
        return { content: 'recovered answer after restart' };
      },
      { listenHost: '127.0.0.1', baseUrlHost: '127.0.0.1' },
    );
    daemon = await startDaemon(workspace, qwenHome, fake.baseUrl);
  }, 60_000);

  afterAll(async () => {
    releaseHeld();
    if (daemon) await stopDaemon(daemon);
    await fake?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('lists and continues a session after the daemon is SIGKILLed', async () => {
    if (!daemon || !fake) return;
    const fakeServer = fake;
    const baseUrl = daemon.baseUrl;
    await waitFor(
      'daemon runtime',
      async () => {
        const health = await fetch(`${baseUrl}/health`);
        return health.ok;
      },
      60_000,
    );
    await waitFor(
      'daemon runtime ready',
      async () => {
        const ready = await jsonFetch(baseUrl, '/sessions/recovery', {
          method: 'POST',
          body: JSON.stringify({ workspaces: [workspace] }),
        });
        const record = asRecord(ready.body);
        return (
          ready.status !== 503 || record?.['code'] !== 'daemon_runtime_starting'
        );
      },
      60_000,
    );

    const created = await jsonFetch(baseUrl, '/session', {
      method: 'POST',
      body: JSON.stringify({ cwd: workspace, sessionScope: 'thread' }),
    });
    expect(created.status).toBe(200);
    const createdRecord = asRecord(created.body);
    const sessionId = createdRecord?.['sessionId'];
    if (typeof sessionId !== 'string') {
      throw new Error('session create returned no sessionId');
    }

    const prompt = await jsonFetch(baseUrl, `/session/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({
        prompt: [{ type: 'text', text: 'E2E restart recovery' }],
      }),
    });
    expect(prompt.status).toBe(202);
    await waitFor(
      'fake model request',
      async () => fakeServer.requests.length > 0,
      30_000,
    );

    const oldDaemon = daemon;
    await stopDaemon(oldDaemon);
    releaseHeld();
    await sleep(500);
    daemon = await startDaemon(workspace, qwenHome, fakeServer.baseUrl);

    let scanItems: RecoveryItem[] | undefined;
    await waitFor(
      'recovery scan',
      async () => {
        const scan = await jsonFetch(daemon!.baseUrl, '/sessions/recovery', {
          method: 'POST',
          body: JSON.stringify({ workspaces: [workspace] }),
        });
        const record = asRecord(scan.body);
        if (record?.['code'] === 'daemon_runtime_starting') return false;
        expect(scan.status).toBe(200);
        scanItems = recoveryItems(scan.body);
        return scanItems !== undefined;
      },
      60_000,
    );
    const item = scanItems?.find((entry) => entry.sessionId === sessionId);
    expect(item).toMatchObject({
      sessionId,
      interruption: 'in_flight',
    });

    let continuation = await jsonFetch(
      daemon.baseUrl,
      '/sessions/recovery/continue',
      {
        method: 'POST',
        body: JSON.stringify({
          sessions: [{ workspace, sessionId }],
        }),
      },
    );
    const continuationRecord = asRecord(continuation.body);
    const results = continuationRecord?.['results'];
    let result = Array.isArray(results) ? asRecord(results[0]) : undefined;
    if (result?.['code'] === 'tool_turn') {
      continuation = await jsonFetch(
        daemon.baseUrl,
        '/sessions/recovery/continue',
        {
          method: 'POST',
          body: JSON.stringify({
            sessions: [{ workspace, sessionId }],
            confirmToolTurn: true,
          }),
        },
      );
      result = asRecord(
        (
          asRecord(continuation.body)?.['results'] as unknown[] | undefined
        )?.[0],
      );
    }
    expect(result).toMatchObject({ status: 'accepted' });
    const continuationPromptId = result?.['promptId'];
    expect(typeof continuationPromptId).toBe('string');
    await waitForContinuationEvidence(
      workspace,
      sessionId,
      String(continuationPromptId),
    );
  }, 120_000);

  it('lists and continues a session after a graceful shutdown', async () => {
    if (!daemon || !fake) return;
    const fakeServer = fake;
    holdNext = true;
    holdState.release = undefined;

    await waitFor(
      'daemon runtime',
      async () => {
        const health = await fetch(`${daemon!.baseUrl}/health`);
        return health.ok;
      },
      60_000,
    );
    await waitFor(
      'daemon runtime ready',
      async () => {
        const ready = await jsonFetch(daemon!.baseUrl, '/sessions/recovery', {
          method: 'POST',
          body: JSON.stringify({ workspaces: [workspace] }),
        });
        const record = asRecord(ready.body);
        return (
          ready.status !== 503 || record?.['code'] !== 'daemon_runtime_starting'
        );
      },
      60_000,
    );

    const created = await jsonFetch(daemon.baseUrl, '/session', {
      method: 'POST',
      body: JSON.stringify({ cwd: workspace, sessionScope: 'thread' }),
    });
    expect(created.status).toBe(200);
    const sessionId = asRecord(created.body)?.['sessionId'];
    if (typeof sessionId !== 'string') {
      throw new Error('session create returned no sessionId');
    }

    const requestCount = fakeServer.requests.length;
    const prompt = await jsonFetch(
      daemon.baseUrl,
      `/session/${sessionId}/prompt`,
      {
        method: 'POST',
        body: JSON.stringify({
          prompt: [{ type: 'text', text: 'E2E graceful recovery' }],
        }),
      },
    );
    expect(prompt.status).toBe(202);
    await waitFor(
      'fake model request',
      async () => fakeServer.requests.length > requestCount,
      30_000,
    );

    const oldDaemon = daemon;
    await stopDaemon(oldDaemon, {
      signal: 'SIGTERM',
      group: false,
      waitMs: 30_000,
    });
    releaseHeld();
    await sleep(500);
    daemon = await startDaemon(workspace, qwenHome, fakeServer.baseUrl);

    let scanItems: RecoveryItem[] | undefined;
    await waitFor(
      'recovery scan',
      async () => {
        const scan = await jsonFetch(daemon!.baseUrl, '/sessions/recovery', {
          method: 'POST',
          body: JSON.stringify({ workspaces: [workspace] }),
        });
        const record = asRecord(scan.body);
        if (record?.['code'] === 'daemon_runtime_starting') return false;
        expect(scan.status).toBe(200);
        scanItems = recoveryItems(scan.body);
        return scanItems !== undefined;
      },
      60_000,
    );
    const item = scanItems?.find((entry) => entry.sessionId === sessionId);
    expect(item).toMatchObject({
      sessionId,
      interruption: 'daemon_shutdown',
    });

    const continuation = await jsonFetch(
      daemon.baseUrl,
      '/sessions/recovery/continue',
      {
        method: 'POST',
        body: JSON.stringify({
          sessions: [{ workspace, sessionId }],
        }),
      },
    );
    const records = asRecord(continuation.body)?.['results'];
    const result = Array.isArray(records) ? asRecord(records[0]) : undefined;
    expect(result).toMatchObject({ status: 'accepted' });
    const continuationPromptId = result?.['promptId'];
    expect(typeof continuationPromptId).toBe('string');
    await waitForContinuationEvidence(
      workspace,
      sessionId,
      String(continuationPromptId),
    );
  }, 120_000);

  it('cleans up a daemon that exits before listening', async () => {
    if (!fake) return;
    await expect(
      startDaemon(workspace, qwenHome, fake.baseUrl, '/nonexistent/qwen-cli'),
    ).rejects.toThrow(/daemon exited before listening.+Cannot find module/s);
  });
});
