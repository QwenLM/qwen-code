/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  type SessionConfigOption,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { TestRig, fakeServerHostOptions } from '../test-helper.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';

describe.each([false, true])(
  'DW04: direct ACP session Workflow mode (shared=%s)',
  (shared) => {
    it('isolates session owners, publishes committed state, and injects ordinary prompts', async () => {
      const rig = new TestRig();
      await rig.setup(`dw04-acp-${shared ? 'shared' : 'legacy'}`);
      rig.mkdir('home');
      rig.createFile(
        'home/settings.json',
        JSON.stringify({
          security: { auth: { selectedType: 'openai' } },
          tools: { workflowsEnabled: true },
          experimental: { unifiedAgentLoop: shared },
          general: { enableAutoUpdate: false },
          ui: { enableFollowupSuggestions: false },
          telemetry: { enabled: false },
          memory: {
            enableManagedAutoMemory: false,
            enableManagedAutoDream: false,
          },
          model: { skipNextSpeakerCheck: true },
        }),
      );
      const server = await startFakeOpenAIServer(
        () => ({ content: 'DW04_ACP_DONE' }),
        fakeServerHostOptions(),
      );
      const child = spawn(process.execPath, [rig.bundlePath, '--acp'], {
        cwd: rig.testDir!,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          QWEN_HOME: join(rig.testDir!, 'home'),
          QWEN_RUNTIME_DIR: join(rig.testDir!, 'runtime'),
          QWEN_CODE_DISABLE_WORKFLOWS: '0',
          QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP: '0',
          QWEN_CODE_DISABLE_CRON: '1',
          OPENAI_API_KEY: 'fake-key',
          OPENAI_BASE_URL: server.baseUrl,
          OPENAI_MODEL: 'fake-model',
          QWEN_MODEL: 'fake-model',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          http_proxy: '',
          https_proxy: '',
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
        },
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const updates: SessionNotification[] = [];
      const client = new ClientSideConnection(
        () => ({
          sessionUpdate: async (notification) => {
            updates.push(notification);
          },
          requestPermission: async () => ({
            outcome: { outcome: 'cancelled' },
          }),
        }),
        ndJsonStream(
          Writable.toWeb(child.stdin),
          Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        ),
      );
      const mode = (options: SessionConfigOption[] | null | undefined) =>
        options?.find((option) => option.id === 'workflow_mode');
      try {
        await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
        const first = await client.newSession({
          cwd: rig.testDir!,
          mcpServers: [],
        });
        const second = await client.newSession({
          cwd: rig.testDir!,
          mcpServers: [],
        });
        expect(first.sessionId).not.toBe(second.sessionId);
        expect(mode(first.configOptions)?.currentValue).toBe('off');
        expect(mode(second.configOptions)?.currentValue).toBe('off');
        const changed = await client.setSessionConfigOption({
          sessionId: first.sessionId,
          configId: 'workflow_mode',
          value: 'on',
        });
        expect(mode(changed.configOptions)).toMatchObject({
          currentValue: 'on',
          _meta: { 'qwen.workflowMode': { available: true, effective: true } },
        });
        await vi.waitFor(() => {
          expect(
            updates.filter(
              ({ sessionId, update }) =>
                sessionId === first.sessionId &&
                update.sessionUpdate === 'config_option_update',
            ),
          ).toHaveLength(1);
        });
        await expect(
          client.setSessionConfigOption({
            sessionId: first.sessionId,
            configId: 'workflow_mode',
            value: 'true',
          }),
        ).rejects.toThrow(/on.*off/i);
        expect(server.requests).toHaveLength(0);
        for (const [sessionId, marker] of [
          [first.sessionId, 'DW04_ACP_ON_MARK'],
          [second.sessionId, 'DW04_ACP_OTHER_MARK'],
        ]) {
          const response = await client.prompt({
            sessionId,
            prompt: [{ type: 'text', text: `${marker} ordinary task` }],
          });
          expect(response.stopReason, stderr).toBe('end_turn');
        }
        for (let turn = 2; turn <= 11; turn++) {
          const response = await client.prompt({
            sessionId: first.sessionId,
            prompt: [
              { type: 'text', text: `DW04_ACP_CADENCE_${turn} ordinary task` },
            ],
          });
          expect(response.stopReason, stderr).toBe('end_turn');
        }
        await client.setSessionConfigOption({
          sessionId: first.sessionId,
          configId: 'workflow_mode',
          value: 'off',
        });
        const response = await client.prompt({
          sessionId: first.sessionId,
          prompt: [{ type: 'text', text: 'DW04_ACP_OFF_MARK ordinary task' }],
        });
        expect(response.stopReason, stderr).toBe('end_turn');
        const requests = server.requests.filter(
          ({ body }) => body['stream'] === true,
        );
        expect(requests).toHaveLength(13);
        const current = requests.map(({ body }) => {
          const messages = body['messages'] as Array<{
            role: string;
            content: unknown;
          }>;
          return JSON.stringify(
            messages.filter(({ role }) => role === 'user').at(-1)?.content,
          );
        });
        expect(current[0]).toContain('DW04_ACP_ON_MARK');
        expect(current[0]).toContain(
          'Workflow mode is enabled for this session.',
        );
        expect(current[1]).toContain('DW04_ACP_OTHER_MARK');
        expect(current[1]).not.toContain('Workflow mode is');
        for (const text of current.slice(2, 11)) {
          expect(text).not.toContain('Workflow mode');
        }
        expect(current[11]).toContain('DW04_ACP_CADENCE_11');
        expect(current[11]).toContain(
          'Workflow mode remains enabled for this session.',
        );
        expect(current[12]).toContain('DW04_ACP_OFF_MARK');
        expect(current[12]).toContain('Workflow mode is off for this session.');
        expect(
          current.every(
            (text) => !text.includes("The user's message includes the"),
          ),
        ).toBe(true);
      } finally {
        rig.createFile(
          'provider-requests.json',
          JSON.stringify(server.requests, null, 2),
        );
        rig.createFile('stderr.txt', stderr);
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
            child.once('close', () => {
              clearTimeout(timeout);
              resolve();
            });
            child.stdin.end();
            child.kill('SIGTERM');
          });
        }
        await server.close();
        await rig.cleanup();
      }
    }, 90_000);
  },
);
