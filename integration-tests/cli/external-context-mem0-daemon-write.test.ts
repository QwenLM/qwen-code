/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonEvent, DaemonClient } from '@qwen-code/sdk';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import {
  approveWorkspaceMcpServers,
  spawnDaemon,
  writeWorkspaceSettings,
  type SpawnedDaemon,
} from './_daemon-harness.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const serverName = 'external-context-mem0-write';
const toolName = `mcp__${serverName}__context_remember`;
type Session = Awaited<ReturnType<DaemonClient['createOrAttachSession']>>;
type Permission = {
  requestId: string;
  toolCall: { rawInput: unknown };
  options: Array<{ optionId: string; kind: string }>;
};
type Attempt = {
  session: Session;
  events: DaemonEvent[];
  controller: AbortController;
  subscription: Promise<void>;
  task: Promise<unknown>;
};

const skip =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] && process.env['QWEN_SANDBOX'] !== 'false',
  );

describe.skipIf(skip)('daemon explicit external memory writes', () => {
  it('binds permissions and provider writes to the owning workspace and reloads only that writer', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'mem0-daemon-write-e2e-')),
    );
    const home = join(root, 'home');
    const qwenHome = join(home, '.qwen');
    mkdirSync(qwenHome, { recursive: true });
    const workspaces = ['A', 'B'].map((name) => join(root, name));
    workspaces.forEach((cwd) => mkdirSync(cwd));
    const requests: Array<{
      body: unknown;
      authorization: string | undefined;
    }> = [];
    const provider = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [{ id: `memory-${requests.length}`, event: 'ADD' }],
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', resolve);
    });
    const address = provider.address();
    if (!address || typeof address === 'string')
      throw new Error('No provider port');
    const writeJson = (path: string, value: unknown) =>
      writeFileSync(path, JSON.stringify(value));
    const dialectPath = join(root, 'write-dialect.json');
    writeJson(dialectPath, {
      writeDialectVersion: 1,
      id: 'synthetic-write-v1',
      auth: 'authorization-token',
      create: {
        path: '/memories',
        userIdLocation: 'json',
        agentIdLocation: 'omit',
        appIdLocation: 'omit',
      },
      response: { completion: 'records', collection: 'results', idField: 'id' },
    });
    const configs = workspaces.map((cwd, index) => ({
      schemaVersion: 4,
      repositoryRoot: cwd,
      dialectPath,
      endpoint: {
        origin: `http://127.0.0.1:${address.port}`,
        basePath: '',
        allowInsecureHttp: true,
      },
      credentialEnv: 'SYNTHETIC_WRITE_TOKEN',
      scope: { userId: `scope-${index}` },
      timeoutMs: 5000,
    }));
    const configPaths = configs.map((config, index) => {
      const path = join(root, `write-${index}.json`);
      writeJson(path, config);
      return path;
    });
    const approvals: Record<string, unknown> = {};
    workspaces.forEach((cwd, index) => {
      const servers = {
        [serverName]: {
          command: process.execPath,
          args: [
            resolve(
              repo,
              'integrations/external-context-mem0/dist/write-main.js',
            ),
          ],
          cwd,
          env: {
            QWEN_EXTERNAL_CONTEXT_MEM0_WRITE_CONFIG: configPaths[index]!,
            SYNTHETIC_WRITE_TOKEN: `synthetic-${index}`,
          },
          includeTools: ['context_remember'],
          trust: false,
          alwaysLoadTools: true,
        },
      };
      writeWorkspaceSettings(cwd, {
        tools: { approvalMode: 'default' },
        permissions: { ask: [toolName] },
        mcpServers: servers,
      });
      const env = approveWorkspaceMcpServers(cwd, servers);
      Object.assign(
        approvals,
        JSON.parse(readFileSync(env['QWEN_CODE_MCP_APPROVALS_PATH']!, 'utf8')),
      );
    });
    const approvalsPath = join(root, 'approved-mcp.json');
    const trustPath = join(root, 'trusted-folders.json');
    writeJson(approvalsPath, approvals);
    writeJson(
      trustPath,
      Object.fromEntries(workspaces.map((cwd) => [cwd, 'TRUST_FOLDER'])),
    );
    writeJson(join(qwenHome, 'settings.json'), {
      security: { folderTrust: { enabled: true } },
    });
    const fakeModel = await startFakeOpenAIServer(({ body }) => {
      const messages = body['messages'] as Array<Record<string, unknown>>;
      const index = messages.findLastIndex(
        (message) => message['role'] === 'user',
      );
      const parts = messages[index]?.['content'];
      const prompt =
        typeof parts === 'string'
          ? parts
          : Array.isArray(parts)
            ? parts.map((part: { text?: string }) => part.text ?? '').join('\n')
            : '';
      const match = prompt.match(/WRITE_E2E=(\{[^\n]*\})/u);
      if (
        match &&
        !messages.slice(index + 1).some((message) => message['role'] === 'tool')
      ) {
        const args = JSON.parse(match[1]!) as { content: string };
        return { toolCalls: [fakeToolCall(toolName, args)] };
      }
      return { content: 'WRITE_E2E_DONE' };
    });
    let daemon: SpawnedDaemon | undefined;
    const attempts: Attempt[] = [];

    async function session(workspaceCwd: string): Promise<Session> {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try {
          const created = await daemon!.client.createOrAttachSession({
            workspaceCwd,
            sessionScope: 'thread',
          });
          expect(created.workspaceCwd).toBe(workspaceCwd);
          return created;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes('daemon_runtime_starting')
          )
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Workspace runtime did not finish starting');
    }

    async function start(session: Session, content: string): Promise<Attempt> {
      const run: Attempt = {
        session,
        events: [],
        controller: new AbortController(),
        subscription: Promise.resolve(),
        task: Promise.resolve(),
      };
      attempts.push(run);
      let notifyReady: (() => void) | undefined;
      let notifyError: ((error: unknown) => void) | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        notifyReady = resolve;
        notifyError = reject;
      });
      run.subscription = (async () => {
        try {
          for await (const event of daemon!.client.subscribeEvents(
            session.sessionId,
            {
              clientId: session.clientId,
              signal: run.controller.signal,
              onSseStreamAccepted: () => notifyReady?.(),
            },
          ))
            run.events.push(event);
        } catch (error) {
          notifyError?.(error);
          if (!run.controller.signal.aborted) throw error;
        }
      })();
      void run.subscription.catch(() => undefined);
      await ready;
      run.task = daemon!.client.prompt(
        session.sessionId,
        {
          prompt: [
            { type: 'text', text: `WRITE_E2E=${JSON.stringify({ content })}` },
          ],
        },
        undefined,
        session.clientId,
      );
      void run.task.catch(() => undefined);
      return run;
    }

    async function permission(run: Attempt): Promise<Permission> {
      await vi.waitFor(
        () =>
          expect(
            run.events.some((event) => event.type === 'permission_request'),
          ).toBe(true),
        { timeout: 30000 },
      );
      return run.events.find((event) => event.type === 'permission_request')!
        .data as Permission;
    }

    async function vote(
      run: Attempt,
      permission: Permission,
      kind = 'allow_once',
    ) {
      const option = permission.options.find((option) => option.kind === kind);
      expect(option).toBeDefined();
      return daemon!.client.respondToSessionPermission(
        run.session.sessionId,
        permission.requestId,
        { outcome: { outcome: 'selected', optionId: option!.optionId } },
        run.session.clientId,
      );
    }

    try {
      daemon = await spawnDaemon({
        workspaceCwd: workspaces[0],
        bootTimeoutMs: 30000,
        env: {
          HOME: home,
          QWEN_HOME: qwenHome,
          QWEN_RUNTIME_DIR: join(root, 'runtime'),
          QWEN_CODE_TRUSTED_FOLDERS_PATH: trustPath,
          QWEN_CODE_MCP_APPROVALS_PATH: approvalsPath,
          QWEN_SANDBOX: 'false',
          QWEN_CODE_NO_RELAUNCH: 'true',
          QWEN_CODE_LEGACY_MCP_BLOCKING: '1',
          OPENAI_API_KEY: 'fake-key',
          OPENAI_BASE_URL: fakeModel.baseUrl,
          OPENAI_MODEL: 'fake-model',
          QWEN_MODEL: 'fake-model',
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
        },
      });
      const a = await session(workspaces[0]!);
      const workspaceB = await daemon.client.addWorkspace(workspaces[1]!);
      expect(workspaceB.trusted).toBe(true);
      const b = await session(workspaces[1]!);
      const content = '  exact\n中文 😀 "quoted"\t FINAL  ';
      const runA = await start(a, content);
      const pA = await permission(runA);
      const runB = await start(b, content);
      const pB = await permission(runB);
      expect(pA.toolCall.rawInput).toEqual({ content });
      expect(pB.toolCall.rawInput).toEqual({ content });
      expect(requests).toHaveLength(0);
      expect(await vote(runA, pB)).toBe(false);
      expect(requests).toHaveLength(0);
      expect(await vote(runA, pA, 'reject_once')).toBe(true);
      await runA.task;
      expect(requests).toHaveLength(0);
      expect(await vote(runB, pB)).toBe(true);
      await runB.task;
      expect(requests).toEqual([
        {
          body: {
            messages: [{ role: 'user', content }],
            infer: false,
            user_id: 'scope-1',
          },
          authorization: 'Token synthetic-1',
        },
      ]);
      expect(await vote(runB, pB)).toBe(false);

      for (let index = 0; index < 2; index++) {
        const run = await start(a, content);
        const pending = await permission(run);
        expect(requests).toHaveLength(index + 1);
        expect(await vote(run, pending)).toBe(true);
        await run.task;
        expect(requests[index + 1]).toEqual({
          body: {
            messages: [{ role: 'user', content }],
            infer: false,
            user_id: 'scope-0',
          },
          authorization: 'Token synthetic-0',
        });
      }

      configs[1]!.scope.userId = 'scope-B-reloaded';
      writeJson(configPaths[1]!, configs[1]);
      const restarted = await daemon.client
        .workspaceById(workspaceB.id)
        .restartMcpServer(serverName, {
          clientId: b.clientId,
          entryIndex: '*',
          timeoutMs: 30000,
        });
      expect(restarted).toMatchObject({
        serverName,
        entries: [{ restarted: true }],
      });
      const reloaded = await start(b, content);
      expect(await vote(reloaded, await permission(reloaded))).toBe(true);
      await reloaded.task;
      expect(requests.at(-1)).toMatchObject({
        body: { user_id: 'scope-B-reloaded' },
        authorization: 'Token synthetic-1',
      });
      const cancelled = await start(a, 'must not be submitted');
      const stale = await permission(cancelled);
      await daemon.client.cancel(a.sessionId, a.clientId);
      await cancelled.task.catch(() => undefined);
      expect(await vote(cancelled, stale)).toBe(false);
      expect(requests).toHaveLength(4);
    } finally {
      for (const run of attempts) {
        await daemon?.client
          .cancel(run.session.sessionId, run.session.clientId)
          .catch(() => undefined);
        run.controller.abort();
        await run.subscription.catch(() => undefined);
        await run.task.catch(() => undefined);
      }
      await daemon?.dispose();
      await fakeModel.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
