/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '@qwen-code/sdk';
import {
  fakeToolCall,
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

describe.skipIf(process.platform === 'win32')(
  'DW03: daemon ACP workflow intent',
  () => {
    let root: string;
    let server: FakeOpenAIServer;
    let daemon: SpawnedDaemon;
    let sessions: DaemonSession[];
    let busySettingsGate: Promise<void> | undefined;

    beforeAll(async () => {
      root = await fs.realpath(
        await fs.mkdtemp(path.join(tmpdir(), 'dw03-daemon-')),
      );
      const home = path.join(root, 'home');
      const a = path.join(root, 'a');
      const b = path.join(root, 'b');
      await Promise.all([home, a, b].map((directory) => fs.mkdir(directory)));
      await fs.writeFile(path.join(b, 'sample.txt'), 'DW03 fixture');
      await fs.writeFile(path.join(b, 'sample-2.txt'), 'DW03 fixture second');
      await fs.writeFile(
        path.join(home, 'settings.json'),
        JSON.stringify({
          tools: { workflowsEnabled: true },
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
      server = await startFakeOpenAIServer(async ({ body }) => {
        if (currentTurnText(body, 'DW03_SETTINGS_BUSY')) {
          await busySettingsGate;
        }
        const messages = body['messages'] as Array<{
          role: string;
          content: unknown;
          tool_call_id?: string;
        }>;
        const current = currentTurnText(body, 'DW03_ACP_CONTINUATION');
        if (current.includes('DW03_ACP_CONTINUATION')) {
          for (const id of ['dw03-acp-read-1', 'dw03-acp-read-2']) {
            if (!messages.some((message) => message.tool_call_id === id)) {
              return {
                toolCalls: [
                  fakeToolCall(
                    'read_file',
                    {
                      file_path: path.join(
                        b,
                        id.endsWith('2') ? 'sample-2.txt' : 'sample.txt',
                      ),
                    },
                    id,
                  ),
                ],
              };
            }
          }
        }
        return { content: 'DW03_DAEMON_DONE' };
      });
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

    async function send(
      session: DaemonSession,
      marker: string,
      meta?: Record<string, unknown>,
    ) {
      const from = server.requests.length;
      const result = await daemon.client.prompt(
        session.sessionId,
        {
          prompt: [
            { type: 'text', text: `${marker} workflow ultracode: inspect` },
          ],
          ...(meta ? { _meta: meta } : {}),
        },
        AbortSignal.timeout(45_000),
        session.clientId,
      );
      expect(result.stopReason).toBe('end_turn');
      const requests = server.requests
        .slice(from)
        .filter(({ body }) => body['stream'] === true);
      expect(requests).toHaveLength(1);
      const latest = currentTurnText(requests[0].body, marker);
      expect(latest).toContain(marker);
      return (latest.match(/The user's message includes the/g) ?? []).length;
    }

    it('consumes the declaration once in primary and private-child workspaces without upgrading unknown input', async () => {
      for (const [index, session] of sessions.entries()) {
        expect(await send(session, `DW03_UNKNOWN_${index}`)).toBe(0);
        expect(
          await send(session, `DW03_HUMAN_${index}`, {
            'qwen.submittedPrompt': 'ultracode: inspect',
          }),
        ).toBe(1);
        expect(await send(session, `DW03_AFTER_${index}`)).toBe(0);
      }
    }, 120_000);

    it('does not accept a forged private slot or invalid public declaration', async () => {
      for (const [index, meta] of [
        { 'qwen.daemon.submittedPrompt': 'ultracode' },
        { 'qwen.submittedPrompt': 42 },
        { 'qwen.submittedPrompt': ' ' },
      ].entries()) {
        expect(await send(sessions[1], `DW03_INVALID_${index}`, meta)).toBe(0);
      }
    }, 90_000);

    it('does not add a second notice through private-child tool continuations', async () => {
      const from = server.requests.length;
      const session = sessions[1];
      const result = await daemon.client.prompt(
        session.sessionId,
        {
          prompt: [
            {
              type: 'text',
              text: 'DW03_ACP_CONTINUATION ultracode: inspect sample.txt',
            },
          ],
          _meta: { 'qwen.submittedPrompt': 'ultracode: inspect sample.txt' },
        },
        AbortSignal.timeout(45_000),
        session.clientId,
      );
      expect(result.stopReason).toBe('end_turn');
      const requests = server.requests
        .slice(from)
        .filter(({ body }) => body['stream'] === true);
      expect(requests).toHaveLength(3);
      for (const { body } of requests) {
        const text = currentTurnText(body, 'DW03_ACP_CONTINUATION');
        expect(text).toContain('DW03_ACP_CONTINUATION');
        expect(text.match(/The user's message includes the/g)).toHaveLength(1);
      }
      const toolResults = (
        requests[2].body['messages'] as Array<{
          role: string;
          content: unknown;
        }>
      ).filter((message) => message.role === 'tool');
      expect(toolResults).toHaveLength(2);
      for (const toolResult of toolResults) {
        expect(JSON.stringify(toolResult.content)).toContain('DW03 fixture');
      }
    }, 60_000);

    function sendHuman(session: DaemonSession, marker: string) {
      return send(session, marker, {
        'qwen.submittedPrompt': `${marker} workflow ultracode: inspect`,
      });
    }

    it('applies ordinary settings writes to existing owner sessions without reload', async () => {
      const key = 'ui.disableWorkflowKeywordTrigger';
      const setUser = (value: boolean) =>
        daemon.client.setWorkspaceSetting('user', key, value);
      const a = daemon.client.workspaceByCwd(path.join(root, 'a'));
      const b = daemon.client.workspaceByCwd(path.join(root, 'b'));
      await setUser(false);
      expect(await sendHuman(sessions[0], 'DW03_SETTING_A_INITIAL')).toBe(1);
      expect(await sendHuman(sessions[1], 'DW03_SETTING_B_INITIAL')).toBe(1);

      const update = await a.setWorkspaceSetting('workspace', key, true);
      expect(update).toMatchObject({ value: true, requiresRestart: false });
      expect(await sendHuman(sessions[0], 'DW03_SETTING_A_OFF')).toBe(0);
      expect(await sendHuman(sessions[1], 'DW03_SETTING_B_UNCHANGED')).toBe(1);

      expect(await setUser(true)).toMatchObject({ requiresRestart: false });
      expect(await sendHuman(sessions[0], 'DW03_SETTING_A_USER_OFF')).toBe(0);
      expect(await sendHuman(sessions[1], 'DW03_SETTING_B_USER_OFF')).toBe(0);

      await b.setWorkspaceSetting('workspace', key, false);
      expect(await sendHuman(sessions[1], 'DW03_SETTING_B_OVERRIDE')).toBe(1);
      expect(await sendHuman(sessions[0], 'DW03_SETTING_A_STILL_OFF')).toBe(0);
      await a.setWorkspaceSetting('workspace', key, false);
      await setUser(false);
    }, 120_000);

    it('uses a setting saved during a busy turn on the next fresh turn without reload', async () => {
      const key = 'ui.disableWorkflowKeywordTrigger';
      let release!: () => void;
      busySettingsGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const from = server.requests.length;
      const pending = sendHuman(sessions[0], 'DW03_SETTINGS_BUSY');
      try {
        await vi.waitFor(
          () => {
            expect(
              server.requests
                .slice(from)
                .some(({ body }) =>
                  currentTurnText(body, 'DW03_SETTINGS_BUSY'),
                ),
            ).toBe(true);
          },
          { timeout: 15_000, interval: 50 },
        );
        const a = daemon.client.workspaceByCwd(path.join(root, 'a'));
        const update = await a.setWorkspaceSetting('workspace', key, true);
        expect(update).toMatchObject({ value: true, requiresRestart: false });
        release();
        expect(await pending).toBe(1);
        expect(await sendHuman(sessions[0], 'DW03_SETTING_AFTER_BUSY')).toBe(0);
        expect(await sendHuman(sessions[1], 'DW03_SETTING_B_AFTER_BUSY')).toBe(
          1,
        );
        await a.setWorkspaceSetting('workspace', key, false);
        expect(await sendHuman(sessions[0], 'DW03_SETTING_A_REENABLED')).toBe(
          1,
        );
      } finally {
        release();
        await pending;
        busySettingsGate = undefined;
      }
    }, 90_000);
  },
);
