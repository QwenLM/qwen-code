/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMockServer,
  type MockServerHandle,
} from '../../packages/channels/plugin-example/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI_BIN =
  process.env['TEST_CLI_PATH'] ?? path.join(REPO_ROOT, 'dist', 'cli.js');
const TOKEN = 'multi-workspace-channel-test-token';

let daemon: ChildProcess | undefined;
let primaryServer: MockServerHandle | undefined;
let secondaryServer: MockServerHandle | undefined;
let testRoot: string | undefined;

interface ChannelWorkersStatus {
  runtime?: {
    channelWorkers?: Array<{
      workspaceCwd: string;
      state: string;
      channels: string[];
    }>;
  };
}

interface ChannelControlState {
  enabled: boolean;
  selection: { mode: 'all' } | { mode: 'names'; names: string[] } | null;
  transition: string;
  workers: Array<{
    workspaceCwd: string;
    state: string;
    channels: string[];
    pid?: number;
  }>;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function waitForListening(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `daemon did not listen\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, 20_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      cleanup();
      resolve(Number(match[1]));
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `daemon exited before listening (code=${code}, signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function stopDaemon(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  child.kill('SIGTERM');
  let forceKillTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        forceKillTimer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
      }),
    ]);
  } finally {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
  }
}

async function waitForRunningWorkers(
  baseUrl: string,
): Promise<ChannelWorkersStatus> {
  const deadline = Date.now() + 15_000;
  let lastStatus: ChannelWorkersStatus | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/daemon/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    lastStatus = (await response.json()) as ChannelWorkersStatus;
    const workers = lastStatus.runtime?.channelWorkers ?? [];
    if (
      workers.length === 2 &&
      workers.every((worker) => worker.state === 'running')
    ) {
      return lastStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `workers did not reach running state: ${JSON.stringify(lastStatus)}`,
  );
}

async function waitForRunningControl(
  baseUrl: string,
): Promise<ChannelControlState> {
  const deadline = Date.now() + 15_000;
  let lastState: ChannelControlState | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/workspace/channel`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    lastState = (await response.json()) as ChannelControlState;
    if (
      lastState.enabled &&
      lastState.transition === 'idle' &&
      lastState.workers.length === 1 &&
      lastState.workers[0]?.state === 'running'
    ) {
      return lastState;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `runtime channel did not reach running state: ${JSON.stringify(lastState)}`,
  );
}

afterEach(async () => {
  await stopDaemon(daemon);
  await Promise.allSettled([
    primaryServer?.close() ?? Promise.resolve(),
    secondaryServer?.close() ?? Promise.resolve(),
  ]);
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
  daemon = undefined;
  primaryServer = undefined;
  secondaryServer = undefined;
  testRoot = undefined;
});

describe('qwen serve multi-workspace channel workers', () => {
  it('controls a real mock-plugin worker after a channel-less boot', async () => {
    testRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'qwen-serve-channel-runtime-')),
    );
    const qwenHome = path.join(testRoot, 'qwen-home');
    const runtimeDir = path.join(testRoot, 'runtime');
    const workspace = path.join(testRoot, 'workspace');
    mkdirSync(workspace);
    mkdirSync(runtimeDir);
    primaryServer = await createMockServer({ httpPort: 0, wsPort: 0 });

    const extensionDir = path.join(qwenHome, 'extensions');
    mkdirSync(extensionDir, { recursive: true });
    symlinkSync(
      path.join(REPO_ROOT, 'packages', 'channels', 'plugin-example'),
      path.join(extensionDir, 'qwen-channel-plugin-example'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    writeJson(path.join(qwenHome, 'settings.json'), {
      security: { folderTrust: { enabled: true } },
    });
    const trustedFoldersPath = path.join(qwenHome, 'trustedFolders.json');
    writeJson(trustedFoldersPath, { [workspace]: 'TRUST_FOLDER' });
    writeJson(path.join(workspace, '.qwen', 'settings.json'), {
      channels: {
        runtime: {
          type: 'plugin-example',
          serverWsUrl: primaryServer.wsUrl,
          senderPolicy: 'open',
          sessionScope: 'user',
          cwd: workspace,
        },
      },
    });
    const env = {
      ...process.env,
      QWEN_HOME: qwenHome,
      QWEN_RUNTIME_DIR: runtimeDir,
      QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFoldersPath,
      OPENAI_API_KEY: 'fake-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_MODEL: 'fake-model',
      QWEN_MODEL: 'fake-model',
    };
    const spawnDaemon = () =>
      spawn(
        process.execPath,
        [
          CLI_BIN,
          'serve',
          '--hostname',
          '127.0.0.1',
          '--port',
          '0',
          '--no-web',
          '--token',
          TOKEN,
          '--workspace',
          workspace,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], env },
      );

    daemon = spawnDaemon();
    let port = await waitForListening(daemon);
    let baseUrl = `http://127.0.0.1:${port}`;
    const authHeaders = {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    };
    const before = await fetch(`${baseUrl}/workspace/channel`, {
      headers: authHeaders,
    });
    expect(await before.json()).toMatchObject({
      enabled: false,
      selection: null,
      workers: [],
    });

    const enable = await fetch(`${baseUrl}/workspace/channel`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        selection: { mode: 'names', names: ['runtime'] },
      }),
    });
    expect(enable.status).toBe(201);
    await primaryServer.waitForConnection(15_000);
    const running = await waitForRunningControl(baseUrl);
    const firstPid = running.workers[0]?.pid;
    expect(running).toMatchObject({
      selection: { mode: 'names', names: ['runtime'] },
      workers: [
        expect.objectContaining({
          workspaceCwd: workspace,
          channels: ['runtime'],
          state: 'running',
        }),
      ],
    });

    const same = await fetch(`${baseUrl}/workspace/channel`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        selection: { mode: 'names', names: ['runtime'] },
      }),
    });
    expect(same.status).toBe(200);
    expect(await same.json()).toMatchObject({
      changed: false,
      state: { workers: [expect.objectContaining({ pid: firstPid })] },
    });

    const stop = await fetch(`${baseUrl}/workspace/channel`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toMatchObject({
      changed: true,
      state: { enabled: false, selection: null, workers: [] },
    });

    await stopDaemon(daemon);
    daemon = spawnDaemon();
    port = await waitForListening(daemon);
    baseUrl = `http://127.0.0.1:${port}`;
    const afterRestart = await fetch(`${baseUrl}/workspace/channel`, {
      headers: authHeaders,
    });
    expect(await afterRestart.json()).toMatchObject({
      enabled: false,
      selection: null,
      workers: [],
    });
  }, 60_000);

  it('starts real workers for primary and secondary workspaces', async () => {
    testRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'qwen-serve-channel-workers-')),
    );
    const qwenHome = path.join(testRoot, 'qwen-home');
    const runtimeDir = path.join(testRoot, 'runtime');
    const primaryWorkspace = path.join(testRoot, 'primary');
    const secondaryWorkspace = path.join(testRoot, 'secondary');
    mkdirSync(primaryWorkspace);
    mkdirSync(secondaryWorkspace);
    mkdirSync(runtimeDir);

    primaryServer = await createMockServer({ httpPort: 0, wsPort: 0 });
    secondaryServer = await createMockServer({ httpPort: 0, wsPort: 0 });

    const extensionDir = path.join(qwenHome, 'extensions');
    mkdirSync(extensionDir, { recursive: true });
    symlinkSync(
      path.join(REPO_ROOT, 'packages', 'channels', 'plugin-example'),
      path.join(extensionDir, 'qwen-channel-plugin-example'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    writeJson(path.join(qwenHome, 'settings.json'), {
      security: { folderTrust: { enabled: true } },
    });
    const trustedFoldersPath = path.join(qwenHome, 'trustedFolders.json');
    writeJson(trustedFoldersPath, {
      [primaryWorkspace]: 'TRUST_FOLDER',
      [secondaryWorkspace]: 'TRUST_FOLDER',
    });
    writeJson(path.join(primaryWorkspace, '.qwen', 'settings.json'), {
      channels: {
        primary: {
          type: 'plugin-example',
          serverWsUrl: primaryServer.wsUrl,
          senderPolicy: 'open',
          sessionScope: 'user',
          cwd: primaryWorkspace,
        },
      },
    });
    writeJson(path.join(secondaryWorkspace, '.qwen', 'settings.json'), {
      channels: {
        secondary: {
          type: 'plugin-example',
          serverWsUrl: secondaryServer.wsUrl,
          senderPolicy: 'open',
          sessionScope: 'user',
          cwd: secondaryWorkspace,
        },
      },
    });

    daemon = spawn(
      process.execPath,
      [
        CLI_BIN,
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        '0',
        '--no-web',
        '--token',
        TOKEN,
        '--workspace',
        primaryWorkspace,
        '--workspace',
        secondaryWorkspace,
        '--channel',
        'primary',
        '--channel',
        'secondary',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          QWEN_HOME: qwenHome,
          QWEN_RUNTIME_DIR: runtimeDir,
          QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFoldersPath,
          OPENAI_API_KEY: 'fake-key',
          OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
          OPENAI_MODEL: 'fake-model',
          QWEN_MODEL: 'fake-model',
        },
      },
    );

    const port = await waitForListening(daemon);
    const baseUrl = `http://127.0.0.1:${port}`;
    await fetch(`${baseUrl}/health`);

    try {
      await Promise.all([
        primaryServer.waitForConnection(15_000),
        secondaryServer.waitForConnection(15_000),
      ]);
    } catch (error) {
      throw new Error(
        `workers did not connect (daemon exitCode=${daemon.exitCode}, signal=${daemon.signalCode})`,
        { cause: error },
      );
    }

    const status = await waitForRunningWorkers(baseUrl);
    expect(status.runtime?.channelWorkers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceCwd: primaryWorkspace,
          state: 'running',
          channels: ['primary'],
        }),
        expect.objectContaining({
          workspaceCwd: secondaryWorkspace,
          state: 'running',
          channels: ['secondary'],
        }),
      ]),
    );
    expect(daemon.exitCode).toBeNull();
  }, 45_000);
});
