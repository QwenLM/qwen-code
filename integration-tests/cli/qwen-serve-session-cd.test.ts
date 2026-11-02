import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Storage, type ChatRecord } from '@qwen-code/qwen-code-core';
import {
  approveWorkspaceMcpServers,
  spawnDaemon,
  writeWorkspaceSettings,
  type SpawnedDaemon,
} from './_daemon-harness.js';

async function waitForCondition(
  check: () => boolean,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for: ${message}`);
}

async function verifySecondarySessionCd(rootKind: 'ordinary' | 'symlinked') {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-session-cd-'),
  );
  const root = await fs.realpath(directory);
  const primary = path.join(root, 'primary');
  const secondary = path.join(root, 'secondary');
  const home = path.join(root, 'home');
  const qwenHome = path.join(home, '.qwen');
  const runtime = path.join(root, 'runtime');
  const sessionDirectory = path.join(secondary, 'sessions', 'session-a');
  const neighborDirectory = path.join(secondary, 'sessions', 'session-b');
  for (const target of [
    primary,
    qwenHome,
    runtime,
    sessionDirectory,
    neighborDirectory,
  ]) {
    await fs.mkdir(target, { recursive: true });
  }
  const registrationPath =
    rootKind === 'symlinked' ? path.join(root, 'secondary-alias') : secondary;
  if (rootKind === 'symlinked') {
    await fs.symlink(
      secondary,
      registrationPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  await fs.writeFile(
    path.join(qwenHome, 'settings.json'),
    JSON.stringify({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: {
        openai: [
          {
            id: 'fake-model',
            baseUrl: 'http://127.0.0.1:9/v1',
            envKey: 'OPENAI_API_KEY',
          },
        ],
      },
    }),
  );
  const env = {
    HOME: home,
    QWEN_HOME: qwenHome,
    QWEN_RUNTIME_DIR: runtime,
    QWEN_SERVE_NO_PERSISTENT_REGISTRATION: '1',
    OPENAI_API_KEY: 'fake-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    OPENAI_MODEL: 'fake-model',
    QWEN_MODEL: 'fake-model',
  };
  let daemon: SpawnedDaemon | undefined;
  const start = async () => {
    daemon = await spawnDaemon({
      workspaceCwd: primary,
      env,
      bootTimeoutMs: 60_000,
      extraArgs: ['--enable-session-shell'],
    });
    const registered = await post('/workspaces', { cwd: registrationPath });
    expect(registered.status, await registered.text()).toBe(201);
  };
  const post = (route: string, body: unknown, clientId?: string) =>
    fetch(`${daemon!.base}${route}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${daemon!.token}`,
        'Content-Type': 'application/json',
        ...(clientId ? { 'X-Qwen-Client-Id': clientId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  const create = async (cwd: string) => {
    const response = await post('/session', { cwd, sessionScope: 'thread' });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.attached).toBe(false);
    return body as {
      sessionId: string;
      clientId: string;
      workspaceCwd: string;
    };
  };
  const shellCwd = async (session: { sessionId: string; clientId: string }) => {
    const response = await post(
      `/session/${session.sessionId}/shell`,
      { command: 'node -p "process.cwd()"' },
      session.clientId,
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.exitCode).toBe(0);
    return body.output.trim() as string;
  };
  try {
    await start();
    const session = await create(secondary);
    const neighbor = await create(secondary);
    const primarySession = await create(primary);
    for (const [target, targetDirectory] of [
      [session, sessionDirectory],
      [neighbor, neighborDirectory],
      [primarySession, primary],
    ] as const) {
      const response = await post(
        `/session/${target.sessionId}/cd`,
        {
          path:
            target === primarySession
              ? targetDirectory
              : path.join(
                  registrationPath,
                  path.relative(secondary, targetDirectory),
                ),
        },
        target.clientId,
      );
      expect(response.status, await response.text()).toBe(200);
      expect(await shellCwd(target)).toBe(targetDirectory);
    }
    const escaped = path.join(secondary, 'escaped');
    await fs.symlink(
      primary,
      escaped,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    for (const target of [primary, escaped]) {
      const response = await post(
        `/session/${session.sessionId}/cd`,
        { path: target },
        session.clientId,
      );
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(body.code).toBe('containment_violation');
    }
    expect(await shellCwd(session)).toBe(sessionDirectory);
    expect(await shellCwd(neighbor)).toBe(neighborDirectory);
    expect(session.workspaceCwd).toBe(secondary);

    await daemon!.dispose();
    const projectDir = Storage.runWithRuntimeBaseDir(runtime, secondary, () =>
      new Storage(secondary).getProjectDir(),
    );
    const chats = path.join(projectDir, 'chats');
    await fs.mkdir(chats, { recursive: true });
    const userUuid = randomUUID();
    const records: ChatRecord[] = [
      {
        type: 'user',
        uuid: userUuid,
        parentUuid: null,
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        cwd: secondary,
        version: '1.0.0',
        message: {
          role: 'user',
          parts: [{ text: 'Fixture persisted by the embedding caller.' }],
        },
      },
      {
        type: 'assistant',
        uuid: randomUUID(),
        parentUuid: userUuid,
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        cwd: secondary,
        version: '1.0.0',
        message: { role: 'model', parts: [{ text: 'Ready.' }] },
      },
    ];
    await fs.writeFile(
      path.join(chats, `${session.sessionId}.jsonl`),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    await start();
    const restoredResponse = await post(`/session/${session.sessionId}/load`, {
      cwd: secondary,
    });
    const restored = await restoredResponse.json();
    expect(restoredResponse.status, JSON.stringify(restored)).toBe(200);
    const relocated = await post(
      `/session/${session.sessionId}/cd`,
      { path: sessionDirectory },
      restored.clientId,
    );
    expect(relocated.status, await relocated.text()).toBe(200);
    expect(
      await shellCwd({
        sessionId: session.sessionId,
        clientId: restored.clientId,
      }),
    ).toBe(sessionDirectory);
    const neighborStatus = await fetch(
      `${daemon!.base}/session/${neighbor.sessionId}/status`,
      {
        headers: { Authorization: `Bearer ${daemon!.token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    expect(neighborStatus.status).toBe(404);
  } finally {
    await daemon?.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function verifyGatedMcpApprovalCarry() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-session-cd-mcp-'),
  );
  const root = await fs.realpath(directory);
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const qwenHome = path.join(home, '.qwen');
  const runtime = path.join(root, 'runtime');
  const sharedChild = path.join(workspace, 'sessions', 'shared');
  const foreignChild = path.join(workspace, 'sessions', 'foreign');
  for (const target of [
    workspace,
    qwenHome,
    runtime,
    sharedChild,
    foreignChild,
  ]) {
    await fs.mkdir(target, { recursive: true });
  }
  // The shared child reaches the workspace configuration through a symlink;
  // the foreign child carries its own settings file (a different source).
  if (process.platform === 'win32') {
    await fs.symlink(
      path.resolve(sharedChild, '..', '..', '.qwen'),
      path.join(sharedChild, '.qwen'),
      'junction',
    );
  } else {
    await fs.symlink(
      path.join('..', '..', '.qwen'),
      path.join(sharedChild, '.qwen'),
      'dir',
    );
  }
  const serverPath = fileURLToPath(
    new URL('../fixtures/idle-mcp/server.mjs', import.meta.url),
  );
  const serverConfig = { command: process.execPath, args: [serverPath] };
  writeWorkspaceSettings(workspace, { mcpServers: { idle: serverConfig } });
  await fs.mkdir(path.join(foreignChild, '.qwen'), { recursive: true });
  await fs.writeFile(
    path.join(foreignChild, '.qwen', 'settings.json'),
    JSON.stringify({ mcpServers: { idle: serverConfig } }),
  );
  const approvalsEnv = approveWorkspaceMcpServers(workspace, {
    idle: serverConfig,
  });

  await fs.writeFile(
    path.join(qwenHome, 'settings.json'),
    JSON.stringify({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: {
        openai: [
          {
            id: 'fake-model',
            baseUrl: 'http://127.0.0.1:9/v1',
            envKey: 'OPENAI_API_KEY',
          },
        ],
      },
    }),
  );
  const env = {
    HOME: home,
    QWEN_HOME: qwenHome,
    QWEN_RUNTIME_DIR: runtime,
    QWEN_SERVE_NO_PERSISTENT_REGISTRATION: '1',
    OPENAI_API_KEY: 'fake-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    OPENAI_MODEL: 'fake-model',
    QWEN_MODEL: 'fake-model',
    ...approvalsEnv,
  };

  let daemon: SpawnedDaemon | undefined;
  const start = async () => {
    daemon = await spawnDaemon({
      workspaceCwd: workspace,
      env,
      bootTimeoutMs: 60_000,
      extraArgs: ['--enable-session-shell'],
    });
    // The boot workspace is already registered; the call stays idempotent so
    // the restart path exercises the same code.
    const registered = await post('/workspaces', { cwd: workspace });
    expect([201, 409], await registered.text()).toContain(registered.status);
  };
  const post = (route: string, body: unknown, clientId?: string) =>
    fetch(`${daemon!.base}${route}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${daemon!.token}`,
        'Content-Type': 'application/json',
        ...(clientId ? { 'X-Qwen-Client-Id': clientId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  const create = async (cwd: string) => {
    const response = await post('/session', { cwd, sessionScope: 'thread' });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body as { sessionId: string; clientId: string };
  };
  const cd = async (
    session: { sessionId: string; clientId: string },
    target: string,
  ) => {
    const response = await post(
      `/session/${session.sessionId}/cd`,
      { path: target },
      session.clientId,
    );
    const body = await response.text();
    expect(response.status, body).toBe(200);
  };
  const stderrSince = (mark: number) => daemon!.stderrBuf.value.slice(mark);

  try {
    await start();
    const session = await create(workspace);

    // Positive: the child shares the workspace configuration, so the approved
    // decision follows the session and the carry is logged with its id.
    let mark = daemon!.stderrBuf.value.length;
    await cd(session, sharedChild);
    await waitForCondition(
      () => stderrSince(mark).includes('carried=[idle:approved]'),
      'carry of idle:approved after cd into the shared child',
    );
    const carriedLog = stderrSince(mark);
    expect(carriedLog).toContain(`session=${session.sessionId}`);
    expect(carriedLog).toContain('carried=[idle:approved]');

    // Negative: a child with its own configuration file is a different source,
    // so the decision must stay behind.
    mark = daemon!.stderrBuf.value.length;
    await cd(session, foreignChild);
    await waitForCondition(
      () => stderrSince(mark).includes('skipped=[idle:config-source-changed]'),
      'skip with config-source-changed after cd into the foreign child',
    );
    expect(stderrSince(mark)).not.toContain('carried=[idle:approved]');

    // After a daemon restart the loaded session still carries the decision to
    // the shared child, which is the original symptom's regression guard.
    // `load` needs a persisted transcript for the session.
    await daemon!.dispose();
    const projectDir = Storage.runWithRuntimeBaseDir(runtime, workspace, () =>
      new Storage(workspace).getProjectDir(),
    );
    const chats = path.join(projectDir, 'chats');
    await fs.mkdir(chats, { recursive: true });
    const userUuid = randomUUID();
    const records: ChatRecord[] = [
      {
        type: 'user',
        uuid: userUuid,
        parentUuid: null,
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        cwd: workspace,
        version: '1.0.0',
        message: { role: 'user', parts: [{ text: 'MCP carry fixture.' }] },
      },
      {
        type: 'assistant',
        uuid: randomUUID(),
        parentUuid: userUuid,
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        cwd: workspace,
        version: '1.0.0',
        message: { role: 'model', parts: [{ text: 'Ready.' }] },
      },
    ];
    await fs.writeFile(
      path.join(chats, `${session.sessionId}.jsonl`),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    await start();
    const restoredResponse = await post(`/session/${session.sessionId}/load`, {
      cwd: workspace,
    });
    const restored = (await restoredResponse.json()) as {
      sessionId?: string;
      clientId: string;
    };
    expect(restoredResponse.status, JSON.stringify(restored)).toBe(200);
    const restoredSession = {
      sessionId: restored.sessionId ?? session.sessionId,
      clientId: restored.clientId,
    };
    mark = daemon!.stderrBuf.value.length;
    await cd(restoredSession, sharedChild);
    await waitForCondition(
      () => stderrSince(mark).includes('carried=[idle:approved]'),
      'carry of idle:approved after restart and reload',
    );
    expect(stderrSince(mark)).toContain(`session=${restoredSession.sessionId}`);
  } finally {
    await daemon?.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

it(
  'carries gated MCP approvals across a symlinked cd and after a restart',
  verifyGatedMcpApprovalCarry,
  240_000,
);

it.each(['ordinary', 'symlinked'] as const)(
  'relocates secondary sessions independently and reapplies cd after restart without Git (%s root)',
  verifySecondarySessionCd,
  180_000,
);
