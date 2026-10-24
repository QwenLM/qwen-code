/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query, isSDKResultMessage, type SDKUserMessage } from '@qwen-code/sdk';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { fakeServerHostOptions } from '../test-helper.js';
import {
  SDKTestHelper,
  createResultWaiter,
  createSharedTestOptions,
} from './test-helper.js';

type WireMessage = { role: string; content?: unknown };
function currentText(body: Record<string, unknown>, marker: string): string {
  const messages = body['messages'] as WireMessage[];
  const index = messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      JSON.stringify(message.content).includes(marker),
  );
  expect(index).toBeGreaterThanOrEqual(0);
  return messages
    .slice(index)
    .filter((message) => message.role === 'user')
    .map((message) => JSON.stringify(message.content))
    .join('\n');
}

describe.each([
  { loop: 'legacy', shared: false },
  { loop: 'shared', shared: true },
])('DW04: native SDK session Workflow mode ($loop)', ({ shared }) => {
  let helper: SDKTestHelper;
  let server: FakeOpenAIServer;
  let cwd: string;
  let home: string;
  beforeEach(async () => {
    helper = new SDKTestHelper();
    cwd = await helper.setup('dw04-sdk', { chatRecording: true });
    home = await helper.mkdir('isolated-home');
    await helper.createFile(
      'isolated-home/settings.json',
      JSON.stringify({
        security: { auth: { selectedType: 'openai' } },
        tools: { workflowsEnabled: true },
        experimental: { unifiedAgentLoop: shared },
        memory: {
          enableManagedAutoMemory: false,
          enableManagedAutoDream: false,
        },
        general: { enableAutoUpdate: false },
        telemetry: { enabled: false },
        model: { skipNextSpeakerCheck: true },
      }),
    );
    await helper.createFile('system.json', '{}');
    server = await startFakeOpenAIServer(
      () => ({ content: 'DW04_DONE' }),
      fakeServerHostOptions(),
    );
  });
  afterEach(async () => {
    await server?.close();
    await helper?.cleanup();
  });
  const options = () => ({
    ...createSharedTestOptions(),
    cwd,
    permissionMode: 'yolo' as const,
    authType: 'openai' as const,
    model: 'fake-model',
    env: {
      HOME: home,
      USERPROFILE: home,
      QWEN_HOME: home,
      QWEN_RUNTIME_DIR: join(home, 'runtime'),
      QWEN_CODE_SYSTEM_SETTINGS_PATH: join(cwd, 'system.json'),
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: join(cwd, 'system.json'),
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

  it('keeps mode across unknown-origin turns and effort changes, refreshes at 1/11, then exits', async () => {
    const waiter = createResultWaiter(12);
    async function* input(): AsyncIterable<SDKUserMessage> {
      await Promise.resolve();
      const session_id = crypto.randomUUID();
      for (let index = 0; index < 12; index++) {
        if (index === 2) {
          await session.setEffort('low');
          expect(await session.getWorkflowMode()).toMatchObject({
            requested: true,
            available: true,
            effective: true,
          });
        }
        if (index === 11) {
          expect(await session.setWorkflowMode(false)).toMatchObject({
            requested: false,
            effective: false,
          });
        }
        yield {
          type: 'user',
          session_id,
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: `DW04_SDK_${index}_MARK ordinary task`,
          },
        };
        await waiter.waitForResult(index);
      }
    }
    const session = query({
      prompt: input(),
      options: { ...options(), workflowMode: true },
    });
    let results = 0;
    try {
      for await (const message of session) {
        if (isSDKResultMessage(message)) {
          expect(message.subtype).toBe('success');
          results++;
          waiter.notifyResult();
        }
      }
    } finally {
      await session.close();
    }
    expect(results).toBe(12);
    const requests = server.requests.filter(
      ({ body }) => body['stream'] === true,
    );
    expect(requests).toHaveLength(12);
    const current = requests.map(({ body }, index) =>
      currentText(body, `DW04_SDK_${index}_MARK`),
    );
    expect(current[0]).toContain('Workflow mode is enabled for this session.');
    expect(
      current.slice(1, 10).every((text) => !text.includes('Workflow mode')),
    ).toBe(true);
    expect(current[10]).toContain('Workflow mode');
    expect(current[11]).toContain('Workflow mode is off for this session.');
    expect(
      current.every(
        (text) => !text.includes("The user's message includes the"),
      ),
    ).toBe(true);
  }, 120_000);

  it('honors explicit initial false over saved on and preserves it on the next resume', async () => {
    const sessionId = crypto.randomUUID();
    for (const [index, setup] of [
      { sessionId, workflowMode: true },
      { resume: sessionId, workflowMode: false },
      { resume: sessionId },
    ].entries()) {
      const session = query({
        prompt: `DW04_RESUME_${index}_MARK ordinary input`,
        options: { ...options(), ...setup },
      });
      let completed = 0;
      try {
        for await (const message of session) {
          if (isSDKResultMessage(message)) {
            expect(message.subtype).toBe('success');
            completed++;
          }
        }
      } finally {
        await session.close();
      }
      expect(completed).toBe(1);
    }
    const requests = server.requests.filter(
      ({ body }) => body['stream'] === true,
    );
    expect(requests).toHaveLength(3);
    expect(currentText(requests[0].body, 'DW04_RESUME_0_MARK')).toContain(
      'Workflow mode is enabled for this session.',
    );
    for (const index of [1, 2])
      expect(
        currentText(requests[index].body, `DW04_RESUME_${index}_MARK`),
      ).toContain('Workflow mode is off for this session.');
  }, 100_000);

  it('fails staged on before dispatch when Workflow is unavailable', async () => {
    const opts = options();
    const session = query({
      prompt: 'DW04_UNAVAILABLE_MARK ordinary input',
      options: {
        ...opts,
        workflowMode: true,
        env: { ...opts.env, QWEN_CODE_DISABLE_WORKFLOWS: '1' },
      },
    });
    try {
      await expect(session.getWorkflowMode()).rejects.toThrow(/unavailable/i);
      expect(server.requests).toHaveLength(0);
    } finally {
      await session.close();
    }
  }, 45_000);
});
