/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core';
import {
  DEFAULT_CLI_BIN,
  spawnDaemon,
  type SpawnedDaemon,
} from './_daemon-harness.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
const token = 'conversations-root-e2e-token';
const sandboxed = Boolean(
  process.env['QWEN_SANDBOX'] &&
    process.env['QWEN_SANDBOX']!.toLowerCase() !== 'false',
);

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllEnvs();
});

async function fixture() {
  vi.stubEnv('QWEN_CONVERSATIONS_DIR', undefined);
  vi.stubEnv('QWEN_CODE_CLI', undefined);
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'qwen-conversations-root-e2e-')),
  );
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const runtime = path.join(root, 'runtime');
  const workspace = path.join(root, 'workspace');
  const selected = path.join(root, 'chosen-root');
  await Promise.all(
    [home, config, runtime, workspace].map((dir) =>
      fs.mkdir(dir, { mode: 0o700 }),
    ),
  );
  await fs.writeFile(
    path.join(config, 'settings.json'),
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
  const env: Record<string, string> = {
    HOME: home,
    QWEN_HOME: config,
    QWEN_RUNTIME_DIR: runtime,
    QWEN_CLI_ENTRY: DEFAULT_CLI_BIN,
    QWEN_SERVE_NO_PERSISTENT_REGISTRATION: '1',
    QWEN_CODE_MODELS_DEV: 'off',
    OPENAI_API_KEY: 'fake-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    OPENAI_MODEL: 'fake-model',
    QWEN_MODEL: 'fake-model',
  };
  const start = async (extraArgs: string[] = []) => {
    const daemon = await spawnDaemon({
      workspaceCwd: workspace,
      token,
      env,
      bootTimeoutMs: 60_000,
      extraArgs: ['--no-web', '--enable-session-shell', ...extraArgs],
    });
    cleanup.push(() => daemon.dispose());
    return daemon;
  };
  const command = (args: string[]) =>
    execFileAsync(process.execPath, [DEFAULT_CLI_BIN, ...args], {
      cwd: workspace,
      env: { ...process.env, ...env },
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    });
  return {
    root,
    config,
    runtime,
    workspace,
    selected,
    defaultRoot: path.join(home, 'Documents', 'Qwen Code', 'Conversations'),
    env,
    start,
    command,
  };
}

function post(
  daemon: Pick<SpawnedDaemon, 'base' | 'token'>,
  route: string,
  body: unknown,
  clientId?: string,
) {
  return fetch(`${daemon.base}${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(clientId ? { 'X-Qwen-Client-Id': clientId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

async function shell(
  daemon: SpawnedDaemon,
  session: { sessionId: string; clientId?: string },
  command: string,
) {
  const response = await post(
    daemon,
    `/session/${session.sessionId}/shell`,
    { command },
    session.clientId,
  );
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.exitCode, body.output).toBe(0);
  return (body.output as string).trim();
}

describe.skipIf(process.platform === 'win32' || sandboxed)(
  'Conversations working-directory root',
  () => {
    it('keeps the omitted default lazy', async () => {
      const f = await fixture();
      const daemon = await f.start();
      const health = await fetch(`${daemon.base}/health`);
      expect(health.status).toBe(200);
      await expect(fs.lstat(f.defaultRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('uses the environment root for real shell files and same-root restore', async () => {
      const f = await fixture();
      f.env['QWEN_CONVERSATIONS_DIR'] = f.selected;
      let daemon = await f.start();
      await expect(fs.lstat(f.selected)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const session = await daemon.client.createStandaloneSession();
      const expectedChild = path.join(
        f.selected,
        `conversation-${createHash('sha256').update(session.sessionId).digest('hex')}`,
      );
      expect(session.projectlessOutputDirectory).toBe(expectedChild);
      expect(await shell(daemon, session, 'node -p "process.cwd()"')).toBe(
        expectedChild,
      );
      await shell(daemon, session, 'printf root-probe > root-probe.txt');
      for (const cwd of [f.selected, expectedChild]) {
        const reserved = await post(daemon, '/workspaces', { cwd });
        const body = await reserved.json();
        expect(reserved.status, JSON.stringify(body)).toBe(409);
        expect(body.code).toBe('conversation_workspace_reserved');
      }
      const ordinary = path.join(f.root, 'ordinary');
      await fs.mkdir(ordinary);
      const registered = await post(daemon, '/workspaces', { cwd: ordinary });
      expect(registered.status, await registered.text()).toBe(201);
      await daemon.dispose();

      const storage = new Storage(f.selected, f.runtime);
      await expect(
        fs.stat(
          path.join(
            storage.getProjectDir(),
            'chats',
            `${session.sessionId}.jsonl`,
          ),
        ),
      ).resolves.toBeDefined();
      await expect(fs.lstat(f.defaultRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      daemon = await f.start();
      const listed = await daemon.client.listStandaloneSessions();
      expect(listed.some((item) => item.sessionId === session.sessionId)).toBe(
        true,
      );
      const restored = await daemon.client.loadStandaloneSession(
        session.sessionId,
      );
      expect(restored.projectlessOutputDirectory).toBe(expectedChild);
      expect(await shell(daemon, restored, 'cat root-probe.txt')).toBe(
        'root-probe',
      );
      expect(await shell(daemon, restored, 'node -p "process.cwd()"')).toBe(
        expectedChild,
      );
    }, 180_000);

    it('lets the CLI override an invalid environment root', async () => {
      const f = await fixture();
      f.env['QWEN_CONVERSATIONS_DIR'] = 'relative-env-root';
      const daemon = await f.start(['--conversations-dir', f.selected]);
      const session = await daemon.client.createStandaloneSession();
      expect(path.dirname(session.projectlessOutputDirectory)).toBe(f.selected);
      await expect(fs.lstat(f.defaultRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }, 120_000);

    it('accepts user env configuration while rejecting project env and settings injection', async () => {
      const f = await fixture();
      const injected = path.join(f.root, 'project-injected');
      await fs.writeFile(
        path.join(f.config, '.env'),
        `QWEN_CONVERSATIONS_DIR=${f.selected}\n`,
      );
      await fs.writeFile(
        path.join(f.workspace, '.env'),
        `QWEN_CONVERSATIONS_DIR=${injected}\n`,
      );
      await fs.mkdir(path.join(f.workspace, '.qwen'));
      await fs.writeFile(
        path.join(f.workspace, '.qwen', 'settings.json'),
        JSON.stringify({ env: { QWEN_CONVERSATIONS_DIR: injected } }),
      );
      const daemon = await f.start();
      const session = await daemon.client.createStandaloneSession();
      expect(path.dirname(session.projectlessOutputDirectory)).toBe(f.selected);
      await expect(fs.lstat(injected)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.lstat(f.defaultRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }, 120_000);

    it.each([
      { source: 'environment', value: 'relative-root' },
      { source: 'CLI', value: '' },
      { source: 'CLI', value: '~/unexpanded-root' },
    ])(
      'rejects $source root "$value" before listening',
      async ({ source, value }) => {
        const f = await fixture();
        if (source === 'environment') f.env['QWEN_CONVERSATIONS_DIR'] = value;
        try {
          await f.command([
            'serve',
            '--hostname',
            '127.0.0.1',
            '--port',
            '0',
            '--no-web',
            ...(source === 'CLI' ? ['--conversations-dir', value] : []),
          ]);
          throw new Error('Invalid root unexpectedly started a daemon');
        } catch (error) {
          const result = error as Error & {
            code?: number;
            stdout?: string;
            stderr?: string;
            killed?: boolean;
          };
          expect(result.killed).not.toBe(true);
          expect(result.code).not.toBe(0);
          const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
          expect(output).toMatch(
            /conversations.*(absolute|fully qualified|nonempty|non-empty)/i,
          );
          expect(output).not.toMatch(/listening on/);
        }
        await expect(fs.lstat(f.defaultRoot)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      },
    );

    it('retains the selected root through daemon start and restart with a changed environment', async () => {
      const f = await fixture();
      delete f.env['QWEN_SERVE_NO_PERSISTENT_REGISTRATION'];
      f.env['QWEN_SERVER_TOKEN'] = token;
      f.env['QWEN_CONVERSATIONS_DIR'] = path.join(f.root, 'ignored-env');
      cleanup.push(async () => {
        await f.command(['daemon', 'stop', '--all', '--force']);
      });
      const started = await f.command([
        'daemon',
        'start',
        '--port',
        '0',
        '--hostname',
        '127.0.0.1',
        '--workspace',
        f.workspace,
        '--conversations-dir',
        f.selected,
        '--no-web',
        '--wait',
        '--json',
      ]);
      const summary = JSON.parse(started.stdout.trim()) as {
        port: number;
        pid: number;
        url: string;
      };
      const recordPath = path.join(
        f.runtime,
        'daemon',
        `daemon-${summary.port}.json`,
      );
      const first = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
        conversationsDir: string;
        pid: number;
      };
      expect(first.conversationsDir).toBe(f.selected);
      f.env['QWEN_CONVERSATIONS_DIR'] = path.join(f.root, 'changed-env');
      await f.command(['daemon', 'restart', '--port', String(summary.port)]);
      const second = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
        conversationsDir: string;
        pid: number;
      };
      expect(second.pid).not.toBe(first.pid);
      expect(second.conversationsDir).toBe(f.selected);
      const sessionId = '123e4567-e89b-42d3-a456-426614174000';
      const response = await post(
        { base: summary.url, token },
        '/standalone/sessions',
        { sessionId },
      );
      const session = await response.json();
      expect(response.status, JSON.stringify(session)).toBe(200);
      expect(path.dirname(session.projectlessOutputDirectory)).toBe(f.selected);
      await expect(
        fs.lstat(f.env['QWEN_CONVERSATIONS_DIR']),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }, 180_000);
  },
);
