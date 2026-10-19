/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent, DaemonSession } from '@qwen-code/sdk';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  DEFAULT_CLI_BIN,
  spawnDaemon,
  type SpawnedDaemon,
} from './_daemon-harness.js';

const sandboxed = Boolean(
  process.env['QWEN_SANDBOX'] &&
    process.env['QWEN_SANDBOX']!.toLowerCase() !== 'false',
);

describe.skipIf(process.platform === 'win32' || sandboxed)(
  'daemon workflow ancestor trust',
  () => {
    let root: string;
    let home: string;
    let runtime: string;
    let trustPath: string;
    let server: FakeOpenAIServer | undefined;
    let daemon: SpawnedDaemon | undefined;
    const workspaces: Array<{
      repo: string;
      target: string;
      marker: string;
      session?: DaemonSession;
    }> = [];

    const writeJson = async (file: string, value: unknown) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = file + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(value));
      await fs.rename(temporary, file);
    };

    const writeWorkflow = async (
      directory: string,
      name: string,
      marker: string,
      agent = false,
    ) => {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, name + '.js'),
        'export const meta = ' +
          JSON.stringify({ name, description: marker }) +
          ';\n' +
          (agent
            ? "const child = await agent('DW02_CHILD report ready');\n"
            : '') +
          'return ' +
          (agent
            ? '{ marker: ' + JSON.stringify(marker) + ', child }'
            : JSON.stringify(marker)) +
          ';\n',
      );
    };

    const rules = () =>
      Object.fromEntries(workspaces.map(({ repo }) => [repo, 'TRUST_FOLDER']));

    beforeAll(async () => {
      root = await fs.realpath(
        await fs.mkdtemp(path.join(tmpdir(), 'daemon-workflow-trust-')),
      );
      home = path.join(root, 'home');
      runtime = path.join(root, 'runtime');
      trustPath = path.join(home, 'trustedFolders.json');
      for (const marker of ['A', 'B', 'C']) {
        const repo = path.join(root, marker);
        const target = path.join(repo, 'packages', 'app');
        await fs.mkdir(target, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: repo });
        await writeWorkflow(
          path.join(repo, '.qwen', 'workflows'),
          'audit',
          marker,
          marker === 'A',
        );
        await writeWorkflow(
          path.join(repo, '.qwen', 'workflows'),
          'ancestor-only',
          marker,
        );
        await writeWorkflow(
          path.join(target, '.qwen', 'workflows'),
          'own',
          'target-' + marker,
        );
        workspaces.push({ repo, target, marker });
      }
      await writeWorkflow(path.join(home, 'workflows'), 'audit', 'user-audit');
      await writeWorkflow(
        path.join(home, 'workflows'),
        'user-only',
        'user-only',
      );
      await writeJson(path.join(home, 'settings.json'), {
        tools: { workflowsEnabled: true },
        general: { enableAutoUpdate: false },
        telemetry: { enabled: false },
        security: {
          folderTrust: { enabled: true },
          auth: { selectedType: 'openai' },
        },
        memory: {
          enableManagedAutoMemory: false,
          enableManagedAutoDream: false,
        },
      });
      await writeJson(trustPath, rules());
      await writeJson(path.join(root, 'system.json'), {});
      server = await startFakeOpenAIServer(({ body }) => ({
        content: body['stream'] === true ? 'DW02_AGENT_DONE' : '{}',
      }));
      daemon = await spawnDaemon({
        workspaceCwd: workspaces[0]!.target,
        extraArgs: ['--workspace', workspaces[1]!.target],
        bootTimeoutMs: 60_000,
        env: {
          HOME: home,
          USERPROFILE: home,
          QWEN_HOME: home,
          QWEN_RUNTIME_DIR: runtime,
          QWEN_CLI_ENTRY: DEFAULT_CLI_BIN,
          QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, 'system.json'),
          QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(root, 'system.json'),
          QWEN_CODE_TRUSTED_FOLDERS_PATH: trustPath,
          QWEN_CODE_DISABLE_CRON: '1',
          QWEN_CODE_DISABLE_WORKFLOWS: '0',
          OPENAI_API_KEY: 'fake-key',
          OPENAI_BASE_URL: server.baseUrl,
          OPENAI_MODEL: 'fake-model',
          QWEN_MODEL: 'fake-model',
          NO_PROXY: '127.0.0.1,localhost',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          http_proxy: '',
          https_proxy: '',
        },
      });
      await vi.waitFor(
        async () => {
          const response = await fetch(
            daemon!.base + '/workspace/trust?statusVersion=2',
            { headers: { Authorization: 'Bearer ' + daemon!.token } },
          );
          expect(response.status).toBe(200);
        },
        { timeout: 60_000, interval: 100 },
      );
      await daemon.client.addWorkspace(workspaces[2]!.target);
      for (const workspace of workspaces) {
        workspace.session = await daemon.client.createOrAttachSession({
          workspaceCwd: workspace.target,
          approvalMode: 'yolo',
          sessionScope: 'thread',
        });
      }
    }, 120_000);

    afterAll(async () => {
      await daemon?.dispose();
      await server?.close();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    async function snapshot(runId: string) {
      const entries = await fs.readdir(runtime, { recursive: true });
      const file = entries.find(
        (entry) => path.basename(entry) === runId + '.json',
      );
      if (!file) return undefined;
      return JSON.parse(
        await fs.readFile(path.join(runtime, file), 'utf8'),
      ) as {
        status: string;
        result: unknown;
      };
    }

    it('uses the correct source in primary, startup secondary, and dynamic runtimes', async () => {
      for (const workspace of workspaces) {
        const { sessionId, clientId } = workspace.session!;
        const commands = await daemon!.client.sessionSupportedCommands(
          sessionId,
          clientId,
        );
        expect(commands.savedWorkflows?.map((entry) => entry.name)).toEqual(
          expect.arrayContaining([
            'audit',
            'ancestor-only',
            'own',
            'user-only',
          ]),
        );
        const detail = await daemon!.client.sessionSavedWorkflow(
          sessionId,
          'audit',
          clientId,
        );
        expect(detail.workflow?.scriptPath).toBe(
          path.join(workspace.repo, '.qwen', 'workflows', 'audit.js'),
        );
        expect(detail.workflow?.script).toContain(workspace.marker);
        const started = await daemon!.client.sessionWorkflowTaskAction(
          sessionId,
          'audit',
          'run-saved',
          clientId,
        );
        expect(started.changed).toBe(true);
        expect(started.taskId).toBeTypeOf('string');
        await expect
          .poll(() => snapshot(started.taskId!), { timeout: 60_000 })
          .toMatchObject({
            status: 'completed',
            result:
              workspace.marker === 'A'
                ? {
                    marker: 'A',
                    child: 'DW02_AGENT_DONE',
                  }
                : workspace.marker,
          });
      }
      expect(server!.requests.some(({ body }) => body['stream'] === true)).toBe(
        true,
      );
    }, 120_000);

    it('preserves ancestor sources after clear rotates the recording id', async () => {
      const workspace = workspaces[1]!;
      const { sessionId, clientId } =
        await daemon!.client.createOrAttachSession({
          workspaceCwd: workspace.target,
          approvalMode: 'yolo',
          sessionScope: 'thread',
        });
      const before = await daemon!.client.sessionSupportedCommands(
        sessionId,
        clientId,
      );
      expect(before.savedWorkflows?.map((entry) => entry.name)).toContain(
        'ancestor-only',
      );
      const trustBefore = await daemon!.client.workspaceTrust({
        statusVersion: 2,
      });
      const signal = AbortSignal.timeout(30_000);
      const accepted = await daemon!.client.promptNonBlocking(
        sessionId,
        { prompt: [{ type: 'text', text: '/clear' }] },
        signal,
        clientId,
      );
      if (
        typeof accepted.promptId !== 'string' ||
        typeof accepted.lastEventId !== 'number'
      ) {
        throw new Error('Expected a nonblocking /clear turn receipt');
      }
      const events: DaemonEvent[] = [];
      for await (const event of daemon!.client.subscribeEvents(sessionId, {
        lastEventId: accepted.lastEventId,
        epoch:
          typeof accepted.eventEpoch === 'string'
            ? accepted.eventEpoch
            : undefined,
        signal,
        clientId,
      })) {
        events.push(event);
        if (
          event.type === 'turn_complete' &&
          (event.data as { promptId?: string }).promptId === accepted.promptId
        ) {
          break;
        }
      }
      expect(events.at(-1)).toMatchObject({
        type: 'turn_complete',
        data: { promptId: accepted.promptId, stopReason: 'end_turn' },
      });
      expect(JSON.stringify(events)).toContain(
        'Context cleared. Previous messages are no longer in context.',
      );
      const commands = await daemon!.client.sessionSupportedCommands(
        sessionId,
        clientId,
      );
      expect(commands.savedWorkflows?.map((entry) => entry.name)).toEqual(
        expect.arrayContaining(['ancestor-only', 'audit', 'own', 'user-only']),
      );
      for (const [name, expectedPath] of [
        ['ancestor-only', path.join(workspace.repo, '.qwen', 'workflows')],
        ['audit', path.join(workspace.repo, '.qwen', 'workflows')],
        ['own', path.join(workspace.target, '.qwen', 'workflows')],
        ['user-only', path.join(home, 'workflows')],
      ] as const) {
        const detail = await daemon!.client.sessionSavedWorkflow(
          sessionId,
          name,
          clientId,
        );
        expect(detail.workflow?.scriptPath).toBe(
          path.join(expectedPath, name + '.js'),
        );
      }
      expect(await daemon!.client.workspaceTrust({ statusVersion: 2 })).toEqual(
        trustBefore,
      );
    }, 60_000);

    it('revokes an ancestor without rebuilding its still-trusted target, then regrants', async () => {
      const primary = workspaces[0]!;
      const { sessionId, clientId } = primary.session!;
      const before = await daemon!.client
        .workspaceByCwd(primary.target)
        .runtimeStatus();
      await writeJson(trustPath, {
        ...Object.fromEntries(
          workspaces.slice(1).map(({ repo }) => [repo, 'TRUST_FOLDER']),
        ),
        [primary.target]: 'TRUST_FOLDER',
      });
      await expect
        .poll(
          async () =>
            (
              await daemon!.client.sessionSavedWorkflow(
                sessionId,
                'ancestor-only',
                clientId,
              )
            ).workflow,
          { timeout: 15_000 },
        )
        .toBeNull();
      const commands = await daemon!.client.sessionSupportedCommands(
        sessionId,
        clientId,
      );
      expect(commands.savedWorkflows?.map((entry) => entry.name)).not.toContain(
        'ancestor-only',
      );
      expect(
        (await daemon!.client.sessionSavedWorkflow(sessionId, 'own', clientId))
          .workflow,
      ).not.toBeNull();
      expect(
        (
          await daemon!.client.sessionSavedWorkflow(
            sessionId,
            'audit',
            clientId,
          )
        ).workflow?.scriptPath,
      ).toBe(path.join(home, 'workflows', 'audit.js'));
      expect(
        await daemon!.client.sessionWorkflowTaskAction(
          sessionId,
          'ancestor-only',
          'run-saved',
          clientId,
        ),
      ).toMatchObject({ changed: false });
      expect(
        (await daemon!.client.workspaceByCwd(primary.target).runtimeStatus())
          .runtimeEpoch,
      ).toBe(before.runtimeEpoch);
      for (const peer of workspaces.slice(1)) {
        expect(
          (
            await daemon!.client.sessionSavedWorkflow(
              peer.session!.sessionId,
              'audit',
              peer.session!.clientId,
            )
          ).workflow?.scriptPath,
        ).toBe(path.join(peer.repo, '.qwen', 'workflows', 'audit.js'));
      }
      await writeJson(trustPath, rules());
      await expect
        .poll(
          async () =>
            (
              await daemon!.client.sessionSavedWorkflow(
                sessionId,
                'ancestor-only',
                clientId,
              )
            ).workflow?.scriptPath,
          { timeout: 15_000 },
        )
        .toBe(
          path.join(primary.repo, '.qwen', 'workflows', 'ancestor-only.js'),
        );
    }, 60_000);
  },
);
