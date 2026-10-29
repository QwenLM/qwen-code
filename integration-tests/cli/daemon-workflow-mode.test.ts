/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DaemonClient, type DaemonSession } from '@qwen-code/sdk';
import { AcpHttpTransport } from '@qwen-code/sdk/daemon/transports';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  DEFAULT_CLI_BIN,
  spawnDaemon,
  type SpawnedDaemon,
} from './_daemon-harness.js';

function currentTurnText(
  body: Record<string, unknown>,
  marker: string,
): string {
  const messages = body['messages'] as Array<{
    role: string;
    content: unknown;
  }>;
  const start = messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      JSON.stringify(message.content).includes(marker),
  );
  return start < 0
    ? ''
    : messages
        .slice(start)
        .filter((message) => message.role === 'user')
        .map((message) => JSON.stringify(message.content))
        .join('\n');
}

describe.skipIf(process.platform === 'win32').each([false, true])(
  'DW04: daemon owner Workflow mode (shared=%s)',
  (shared) => {
    let root: string;
    let server: FakeOpenAIServer;
    let daemon: SpawnedDaemon;
    let sessions: DaemonSession[];

    beforeAll(async () => {
      root = await fs.realpath(
        await fs.mkdtemp(path.join(tmpdir(), 'dw04-daemon-')),
      );
      const home = path.join(root, 'home');
      const a = path.join(root, 'a');
      const b = path.join(root, 'b');
      await Promise.all([home, a, b].map((directory) => fs.mkdir(directory)));
      await fs.writeFile(path.join(b, 'sample.txt'), 'DW04 fixture');
      await fs.writeFile(path.join(b, 'sample-2.txt'), 'DW04 fixture second');
      await fs.writeFile(
        path.join(home, 'settings.json'),
        JSON.stringify({
          tools: { workflowsEnabled: true },
          experimental: { unifiedAgentLoop: shared },
          security: {
            auth: { selectedType: 'openai' },
            folderTrust: { enabled: true },
          },
          memory: {
            enableManagedAutoMemory: false,
            enableManagedAutoDream: false,
          },
          general: { enableAutoUpdate: false },
          ui: { enableFollowupSuggestions: false },
          telemetry: { enabled: false },
          model: { skipNextSpeakerCheck: true },
        }),
      );
      await fs.writeFile(
        path.join(home, 'trustedFolders.json'),
        JSON.stringify({ [a]: 'TRUST_FOLDER', [b]: 'TRUST_FOLDER' }),
      );
      await fs.writeFile(path.join(root, 'system.json'), '{}');
      server = await startFakeOpenAIServer(() => ({
        content: 'DW04_DAEMON_DONE',
      }));
      daemon = await spawnDaemon({
        cliBin: DEFAULT_CLI_BIN,
        workspaceCwd: a,
        extraArgs: ['--workspace', b],
        bootTimeoutMs: 60_000,
        env: {
          HOME: home,
          USERPROFILE: home,
          QWEN_HOME: home,
          QWEN_RUNTIME_DIR: path.join(root, 'runtime'),
          QWEN_CLI_ENTRY: DEFAULT_CLI_BIN,
          // The docker E2E leg exports QWEN_SANDBOX=docker; inherited by the
          // daemon's `qwen --acp` children, it puts them in a container with
          // no host-loopback route to the fake model server.
          QWEN_SANDBOX: 'false',
          QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, 'system.json'),
          QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(root, 'system.json'),
          QWEN_CODE_TRUSTED_FOLDERS_PATH: path.join(
            home,
            'trustedFolders.json',
          ),
          QWEN_CODE_DISABLE_WORKFLOWS: '0',
          QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP: '0',
          QWEN_CODE_DISABLE_CRON: '1',
          OPENAI_API_KEY: 'fake-key',
          OPENAI_BASE_URL: server.baseUrl,
          OPENAI_MODEL: 'fake-model',
          QWEN_MODEL: 'fake-model',
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          http_proxy: '',
          https_proxy: '',
        },
      });
      await vi.waitFor(
        async () => {
          const capabilities = await daemon.client.capabilities();
          expect(
            capabilities.workspaces?.some((workspace) => workspace.cwd === b),
          ).toBe(true);
        },
        { timeout: 60_000, interval: 100 },
      );
      sessions = [];
      for (const workspaceCwd of [a, b]) {
        sessions.push(
          await daemon.client.createOrAttachSession({
            workspaceCwd,
            approvalMode: 'yolo',
            sessionScope: 'thread',
          }),
        );
      }
    }, 120_000);

    afterAll(async () => {
      await daemon?.dispose();
      await server?.close();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it('persists changes on the selected secondary owner and isolates the primary', async () => {
      const [primary, secondary] = sessions;
      const changed = await daemon.client.setSessionConfigOption(
        secondary.sessionId,
        'workflow_mode',
        'on',
        secondary.clientId,
      );
      expect(changed.configOptions).toContainEqual(
        expect.objectContaining({ id: 'workflow_mode', currentValue: 'on' }),
      );
      for (const [session, expected] of [
        [primary, 'off'],
        [secondary, 'on'],
      ] as const) {
        const context = await daemon.client.sessionContext(
          session.sessionId,
          session.clientId,
        );
        expect(context.state.configOptions).toContainEqual(
          expect.objectContaining({
            id: 'workflow_mode',
            currentValue: expected,
          }),
        );
        const from = server.requests.length;
        const marker = `DW04_OWNER_${expected}`;
        const result = await daemon.client.prompt(
          session.sessionId,
          { prompt: [{ type: 'text', text: marker }] },
          AbortSignal.timeout(45_000),
          session.clientId,
        );
        expect(result.stopReason).toBe('end_turn');
        const requests = server.requests
          .slice(from)
          .filter(({ body }) => body['stream'] === true);
        expect(requests).toHaveLength(1);
        const current = currentTurnText(requests[0].body, marker);
        expect(current).toContain(marker);
        expect(
          current.includes('Workflow mode is enabled for this session.'),
        ).toBe(expected === 'on');
        expect(current).not.toContain("The user's message includes the");
      }
      const capabilities = await daemon.client.capabilities();
      expect(capabilities.features).toContain('workspace_qualified_acp');
      const secondaryWorkspace = capabilities.workspaces?.find(
        (workspace) => workspace.cwd === path.join(root, 'b'),
      );
      expect(secondaryWorkspace).toBeDefined();
      const transport = new AcpHttpTransport(
        `${daemon.base}/workspaces/${encodeURIComponent(secondaryWorkspace!.id)}`,
        daemon.token,
        fetch,
      );
      const httpClient = new DaemonClient({
        baseUrl: daemon.base,
        token: daemon.token,
        transport,
      });
      try {
        // The ACP connection obtains its own live-owner attachment.
        await httpClient.resumeSession(secondary.sessionId, {
          workspaceCwd: path.join(root, 'b'),
        });
        const disabled = await httpClient.setSessionConfigOption(
          secondary.sessionId,
          'workflow_mode',
          'off',
        );
        expect(disabled.persisted).toBe(true);
        expect(disabled.configOptions).toContainEqual(
          expect.objectContaining({
            id: 'workflow_mode',
            currentValue: 'off',
            _meta: {
              'qwen.workflowMode': {
                available: true,
                effective: false,
              },
            },
          }),
        );
        await expect(
          httpClient.setSessionConfigOption(
            secondary.sessionId,
            'reasoning_effort',
            'high',
          ),
        ).rejects.toThrow('ConfigId not supported by this transport');
        const context = await daemon.client.sessionContext(
          secondary.sessionId,
          secondary.clientId,
        );
        expect(context.state.configOptions).toContainEqual(
          expect.objectContaining({ id: 'workflow_mode', currentValue: 'off' }),
        );
        const from = server.requests.length;
        const marker = 'DW04_HTTP_DISABLED';
        const result = await httpClient.prompt(
          secondary.sessionId,
          { prompt: [{ type: 'text', text: marker }] },
          AbortSignal.timeout(45_000),
        );
        expect(result.stopReason).toBe('end_turn');
        const requests = server.requests
          .slice(from)
          .filter(({ body }) => body['stream'] === true);
        expect(requests).toHaveLength(1);
        const current = currentTurnText(requests[0].body, marker);
        expect(current).toContain(marker);
        expect(current).toContain('Workflow mode is off for this session.');
        expect(current).not.toContain(
          'Workflow mode is enabled for this session.',
        );
      } finally {
        transport.dispose();
      }
    }, 120_000);
  },
);
