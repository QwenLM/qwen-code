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
const serverName = 'external-context-mem0-delete';
const toolName = `mcp__${serverName}__context_forget`;
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

describe.skipIf(skip)('daemon explicit external memory deletion', () => {
  it('deletes only verified records in the owning workspace after approval', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'mem0-daemon-delete-e2e-')),
    );
    const home = join(root, 'home');
    const qwenHome = join(home, '.qwen');
    mkdirSync(qwenHome, { recursive: true });
    const workspaces = ['A', 'B'].map((name) => join(root, name));
    workspaces.forEach((cwd) => mkdirSync(cwd));
    const content = '  exact\n中文 😀 "quoted"\t FINAL  ';
    const memories = new Map([
      ['record-A', { id: 'record-A', memory: content, user_id: 'scope-0' }],
      ['record-B', { id: 'record-B', memory: content, user_id: 'scope-1' }],
      ['control', { id: 'control', memory: 'keep me', user_id: 'scope-0' }],
      [
        'reloaded',
        { id: 'reloaded', memory: content, user_id: 'scope-B-reloaded' },
      ],
    ]);
    const requests: Array<{
      method?: string;
      path?: string;
      authorization?: string;
    }> = [];
    const provider = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      requests.push({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
      });
      const match = req.url?.match(/^\/memories\/([A-Za-z0-9-]+)$/u);
      if (!match || body !== '') {
        res.writeHead(500);
        res.end('Unexpected request');
        return;
      }
      const id = match[1]!;
      if (req.method === 'DELETE') {
        memories.delete(id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Memory deleted successfully!' }));
        return;
      }
      const record = memories.get(id);
      res.writeHead(record ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(record ?? { detail: 'not found' }));
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
    const dialectPath = join(root, 'delete-dialect.json');
    writeJson(dialectPath, {
      deleteDialectVersion: 1,
      id: 'synthetic-delete-v1',
      auth: 'authorization-token',
      record: {
        pathPrefix: '/memories/',
        pathSuffix: '',
        idField: 'id',
        contentField: 'memory',
        notFound: 'http-404',
      },
    });
    const configs = workspaces.map((cwd, index) => ({
      schemaVersion: 5,
      repositoryRoot: cwd,
      dialectPath,
      endpoint: {
        origin: `http://127.0.0.1:${address.port}`,
        basePath: '',
        allowInsecureHttp: true,
      },
      credentialEnv: 'SYNTHETIC_DELETE_TOKEN',
      scope: { userId: `scope-${index}` },
      timeoutMs: 5000,
    }));
    const configPaths = configs.map((config, index) => {
      const path = join(root, `delete-${index}.json`);
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
              'integrations/external-context-mem0/dist/delete-main.js',
            ),
          ],
          cwd,
          env: {
            QWEN_EXTERNAL_CONTEXT_MEM0_DELETE_CONFIG: configPaths[index]!,
            SYNTHETIC_DELETE_TOKEN: `synthetic-${index}`,
          },
          includeTools: ['context_get', 'context_forget'],
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
      const match = prompt.match(/DELETE_E2E=(\{[^\n]*\})/u);
      if (
        match &&
        !messages.slice(index + 1).some((message) => message['role'] === 'tool')
      ) {
        const args = JSON.parse(match[1]!) as {
          memoryId: string;
          expectedContent: string;
        };
        return { toolCalls: [fakeToolCall(toolName, args)] };
      }
      return { content: 'DELETE_E2E_DONE' };
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

    async function start(
      session: Session,
      memoryId: string,
      expectedContent = content,
    ): Promise<Attempt> {
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
            {
              type: 'text',
              text: `DELETE_E2E=${JSON.stringify({ memoryId, expectedContent })}`,
            },
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
      const runA = await start(a, 'record-A');
      const pA = await permission(runA);
      const runB = await start(b, 'record-B');
      const pB = await permission(runB);
      expect(pA.toolCall.rawInput).toEqual({
        memoryId: 'record-A',
        expectedContent: content,
      });
      expect(pB.toolCall.rawInput).toEqual({
        memoryId: 'record-B',
        expectedContent: content,
      });
      expect(requests).toHaveLength(0);
      expect(await vote(runA, pB)).toBe(false);
      expect(await vote(runA, pA, 'reject_once')).toBe(true);
      await runA.task;
      expect(requests).toHaveLength(0);
      expect(memories.has('record-A')).toBe(true);
      expect(await vote(runB, pB)).toBe(true);
      await runB.task;
      expect(requests).toEqual(
        ['GET', 'DELETE', 'GET'].map((method) => ({
          method,
          path: '/memories/record-B',
          authorization: 'Token synthetic-1',
        })),
      );
      expect(memories.has('record-B')).toBe(false);
      expect(await vote(runB, pB)).toBe(false);

      const foreign = await start(b, 'record-A');
      expect(await vote(foreign, await permission(foreign))).toBe(true);
      await foreign.task;
      expect(requests.at(-1)).toEqual({
        method: 'GET',
        path: '/memories/record-A',
        authorization: 'Token synthetic-1',
      });
      expect(memories.has('record-A')).toBe(true);
      expect(requests).toHaveLength(4);

      const changed = await start(a, 'record-A');
      const beforeChange = await permission(changed);
      memories.get('record-A')!.memory = 'changed during approval';
      expect(await vote(changed, beforeChange)).toBe(true);
      await changed.task;
      expect(requests).toHaveLength(5);
      expect(memories.has('record-A')).toBe(true);
      const verified = await start(a, 'record-A', 'changed during approval');
      expect(await vote(verified, await permission(verified))).toBe(true);
      await verified.task;
      expect(memories.has('record-A')).toBe(false);
      expect(requests.slice(-3)).toEqual(
        ['GET', 'DELETE', 'GET'].map((method) => ({
          method,
          path: '/memories/record-A',
          authorization: 'Token synthetic-0',
        })),
      );
      const repeated = await start(a, 'record-A', 'changed during approval');
      expect(await vote(repeated, await permission(repeated))).toBe(true);
      await repeated.task;
      expect(requests).toHaveLength(9);
      expect(requests.at(-1)?.method).toBe('GET');

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
      const reloaded = await start(b, 'reloaded');
      expect(await vote(reloaded, await permission(reloaded))).toBe(true);
      await reloaded.task;
      expect(memories.has('reloaded')).toBe(false);
      expect(requests.slice(-3)).toEqual(
        ['GET', 'DELETE', 'GET'].map((method) => ({
          method,
          path: '/memories/reloaded',
          authorization: 'Token synthetic-1',
        })),
      );
      const cancelled = await start(a, 'control', 'keep me');
      const stale = await permission(cancelled);
      await daemon.client.cancel(a.sessionId, a.clientId);
      await cancelled.task.catch(() => undefined);
      expect(await vote(cancelled, stale)).toBe(false);
      expect(requests).toHaveLength(12);
      expect([...memories.keys()]).toEqual(['control']);
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
