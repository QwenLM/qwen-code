import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { Storage, type ChatRecord } from '@qwen-code/qwen-code-core';
import { spawnDaemon, type SpawnedDaemon } from './_daemon-harness.js';

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

it.each(['ordinary', 'symlinked'] as const)(
  'relocates secondary sessions independently and reapplies cd after restart without Git (%s root)',
  verifySecondarySessionCd,
  180_000,
);
