/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  Agent,
  Client,
  ClientSideConnection,
  InitializeResponse,
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  AcpProcessClient,
  type AcpProcessClientOptions,
} from './AcpProcessClient.js';

type AcpSdkConnection = Pick<
  ClientSideConnection,
  | 'authenticate'
  | 'cancel'
  | 'extMethod'
  | 'initialize'
  | 'loadSession'
  | 'newSession'
  | 'prompt'
  | 'setSessionMode'
  | 'unstable_listSessions'
  | 'unstable_setSessionModel'
>;

interface Harness {
  client: AcpProcessClient;
  child: ChildProcess;
  connection: AcpSdkConnection;
  capturedClients: Client[];
  spawnProcess: ReturnType<typeof vi.fn>;
}

describe('AcpProcessClient', () => {
  it('spawns qwen ACP with the CLI-supported ACP channel and initializes SDK', async () => {
    const harness = createHarness({
      cwd: '/workspace',
      extraArgs: ['--model', 'qwen-plus'],
      env: { QWEN_TEST_FLAG: '1' },
    });

    await harness.client.connect();

    expect(harness.spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ['/tmp/qwen.js', '--acp', '--channel=ACP', '--model', 'qwen-plus'],
      expect.objectContaining({
        cwd: '/workspace',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    expect(harness.connection.initialize).toHaveBeenCalledWith({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
  });

  it('allows callers to override the CLI channel with another supported value', async () => {
    const harness = createHarness({ channel: 'VSCode' });

    await harness.client.connect();

    expect(harness.spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ['/tmp/qwen.js', '--acp', '--channel=VSCode'],
      expect.any(Object),
    );
  });

  it('forwards ACP client callbacks to desktop handlers', async () => {
    const harness = createHarness();
    const onSessionUpdate = vi.fn();
    const onPermissionRequest = vi
      .fn()
      .mockResolvedValue({ outcome: { outcome: 'cancelled' } });
    const onExtNotification = vi.fn();
    harness.client.onSessionUpdate = onSessionUpdate;
    harness.client.onPermissionRequest = onPermissionRequest;
    harness.client.onExtNotification = onExtNotification;

    await harness.client.connect();
    const acpClient = harness.capturedClients[0];
    const sessionUpdate = {
      sessionId: 'session-1',
      update: { sessionUpdate: 'agent_message_chunk' },
    } as unknown as SessionNotification;
    const permissionRequest = {
      sessionId: 'session-1',
      options: [],
    } as unknown as RequestPermissionRequest;

    await acpClient.sessionUpdate(sessionUpdate);
    await acpClient.requestPermission(permissionRequest);
    await acpClient.extNotification('authenticate/update', { ok: true });

    expect(onSessionUpdate).toHaveBeenCalledWith(sessionUpdate);
    expect(onPermissionRequest).toHaveBeenCalledWith(permissionRequest);
    expect(onExtNotification).toHaveBeenCalledWith('authenticate/update', {
      ok: true,
    });
  });

  it('wraps session and prompt ACP methods', async () => {
    const harness = createHarness();
    await harness.client.connect();

    await harness.client.newSession('/workspace');
    await harness.client.loadSession('session-1', '/workspace');
    await harness.client.listSessions({
      cwd: '/workspace',
      cursor: 4,
      size: 20,
    });
    await harness.client.prompt('session-1', 'hello');
    await harness.client.cancel('session-1');
    await harness.client.setMode('session-1', 'yolo');
    await harness.client.setModel('session-1', 'qwen-plus');

    expect(harness.connection.newSession).toHaveBeenCalledWith({
      cwd: '/workspace',
      mcpServers: [],
    });
    expect(harness.connection.loadSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cwd: '/workspace',
      mcpServers: [],
    });
    expect(harness.connection.unstable_listSessions).toHaveBeenCalledWith({
      cwd: '/workspace',
      cursor: '4',
      _meta: { size: 20 },
    });
    expect(harness.connection.prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'hello' }],
    });
    expect(harness.connection.cancel).toHaveBeenCalledWith({
      sessionId: 'session-1',
    });
    expect(harness.connection.setSessionMode).toHaveBeenCalledWith({
      sessionId: 'session-1',
      modeId: 'yolo',
    });
    expect(harness.connection.unstable_setSessionModel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      modelId: 'qwen-plus',
    });
  });

  it('clears connection state and kills the process on disconnect', async () => {
    const harness = createHarness();
    await harness.client.connect();

    harness.client.disconnect();

    expect(harness.child.kill).toHaveBeenCalledOnce();
    expect(harness.client.isConnected).toBe(false);
  });

  it('reports child process exits through onDisconnected', async () => {
    const harness = createHarness();
    const onDisconnected = vi.fn();
    harness.client.onDisconnected = onDisconnected;
    await harness.client.connect();

    harness.child.emit('exit', 143, 'SIGTERM');

    expect(onDisconnected).toHaveBeenCalledWith(143, 'SIGTERM');
    expect(harness.client.isConnected).toBe(false);
  });

  it('rejects connect when the ACP process exits before initialize completes', async () => {
    const harness = createHarness();
    vi.mocked(harness.connection.initialize).mockReturnValue(
      new Promise<InitializeResponse>(() => {}),
    );

    const connectPromise = harness.client.connect();
    harness.child.stderr?.emit('data', Buffer.from('startup failed'));
    harness.child.emit('exit', 1, null);

    await expect(connectPromise).rejects.toThrow(
      'Qwen ACP process exited unexpectedly',
    );
  });

  it('handles disconnect while connect is still in startup delay', async () => {
    const harness = createHarness({ startupDelayMs: 25 });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const connectPromise = harness.client.connect();

      harness.client.disconnect();
      harness.child.emit('exit', null, 'SIGTERM');

      await expect(connectPromise).rejects.toThrow(
        'Qwen ACP process startup was cancelled.',
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

function createHarness(
  options: Partial<AcpProcessClientOptions> = {},
): Harness {
  const child = createFakeChild();
  const connection = createFakeConnection();
  const capturedClients: Client[] = [];
  const spawnProcess = vi.fn(
    (_command: string, _args: string[], _options: SpawnOptions) => child,
  );
  const createConnection: AcpProcessClientOptions['createConnection'] = (
    clientFactory: (agent: Agent) => Client,
  ) => {
    capturedClients.push(clientFactory({} as Agent));
    return connection;
  };

  return {
    child,
    connection,
    capturedClients,
    spawnProcess,
    client: new AcpProcessClient({
      cliEntryPath: '/tmp/qwen.js',
      startupDelayMs: 0,
      validateCliPath: false,
      spawnProcess,
      createConnection,
      ...options,
    }),
  };
}

function createFakeConnection(): AcpSdkConnection {
  return {
    authenticate: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue(undefined),
    extMethod: vi.fn().mockResolvedValue({ success: true }),
    initialize: vi.fn().mockResolvedValue({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: 'qwen-code',
        title: 'Qwen Code',
        version: 'test',
      },
      agentCapabilities: {},
      authMethods: [],
    } satisfies InitializeResponse),
    loadSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    newSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    setSessionMode: vi.fn().mockResolvedValue({}),
    unstable_listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    unstable_setSessionModel: vi.fn().mockResolvedValue({}),
  } as unknown as AcpSdkConnection;
}

function createFakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    killed: false,
    exitCode: null,
    kill: vi.fn(() => {
      Object.assign(child, { killed: true, exitCode: 0 });
      return true;
    }),
  });

  return child;
}
