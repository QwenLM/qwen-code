/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

describe('DW04: SDK initialization process cleanup', () => {
  let helper: SDKTestHelper;
  let cwd: string;
  beforeEach(async () => {
    helper = new SDKTestHelper();
    cwd = await helper.setup('dw04-sdk-init-cleanup');
  });
  afterEach(async () => {
    await helper?.cleanup();
  });

  it.each([undefined, true, false])(
    'exits without caller cleanup when an older CLI omits the capability (workflowMode=%s)',
    async (workflowMode) => {
      const requestsPath = await helper.createFile('requests.jsonl', '');
      const cliPath = await helper.createFile(
        'older-cli.mjs',
        `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(requestsPath)}, line + '\\n');
  if (message.type === 'control_request') {
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: message.request_id,
        response: { capabilities: {} } },
    }) + '\\n');
  } else if (message.type === 'user') {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', session_id: message.session_id,
      uuid: 'fixture-result', result: 'OK', is_error: false,
      duration_ms: 0, duration_api_ms: 0, num_turns: 1,
      usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [],
    }) + '\\n');
  }
});
`,
      );
      const sdkUrl = new URL(
        '../../packages/sdk-typescript/dist/index.mjs',
        import.meta.url,
      ).href;
      const hostPath = await helper.createFile(
        'sdk-host.mjs',
        `import { query } from ${JSON.stringify(sdkUrl)};
const session = query({
  prompt: 'ordinary prompt',
  options: ${JSON.stringify({ pathToQwenExecutable: cliPath, cwd, workflowMode })},
});
try {
  for await (const message of session) {
    if (message.type === 'result') console.log(JSON.stringify({ result: message.result }));
  }
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
      );
      // A leaked CLI keeps this host alive after its iterator has settled.
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [hostPath],
        {
          cwd,
          timeout: 10_000,
        },
      );
      expect(JSON.parse(stdout.trim())).toEqual(
        workflowMode === undefined
          ? { result: 'OK' }
          : { error: 'The CLI does not support session Workflow mode' },
      );
      const requests = (await helper.readFile('requests.jsonl'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string });
      expect(requests.map(({ type }) => type)).toEqual(
        workflowMode === undefined
          ? ['control_request', 'user']
          : ['control_request'],
      );
    },
  );
});
