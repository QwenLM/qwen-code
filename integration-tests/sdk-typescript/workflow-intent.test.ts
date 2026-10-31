/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query, isSDKResultMessage, type SDKUserMessage } from '@qwen-code/sdk';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { fakeServerHostOptions } from '../test-helper.js';
import {
  SDKTestHelper,
  createResultWaiter,
  createSharedTestOptions,
} from './test-helper.js';

type WireMessage = {
  role: string;
  content?: string | Array<{ text?: string }>;
  tool_call_id?: string;
};

function currentUserText(body: Record<string, unknown>): string {
  const messages = body['messages'] as WireMessage[];
  const text = (message: WireMessage) =>
    typeof message.content === 'string'
      ? message.content
      : (message.content?.map((part) => part.text ?? '').join('\n') ?? '');
  const marker = messages.findLastIndex(
    (message) => message.role === 'user' && text(message).includes('DW03_'),
  );
  const start =
    marker >= 0
      ? marker
      : messages.findLastIndex((message) => message.role === 'user');
  return messages
    .slice(start)
    .filter((message) => message.role === 'user')
    .map(text)
    .join('\n');
}

function noticeCount(text: string): number {
  return (
    text.match(
      /The user's message includes the "(?:workflow|ultracode)" keyword/g,
    ) ?? []
  ).length;
}

describe('DW03: public SDK workflow intent', () => {
  let helper: SDKTestHelper;
  let server: FakeOpenAIServer | undefined;
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    helper = new SDKTestHelper();
    cwd = await helper.setup('dw03-sdk');
    home = await helper.mkdir('isolated-home');
    await helper.createFile(
      'isolated-home/settings.json',
      JSON.stringify({
        security: { auth: { selectedType: 'openai' } },
        tools: { workflowsEnabled: true },
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
    await helper.createFile('sample.txt', 'fixture content');
    await helper.createFile('sample-2.txt', 'fixture content second');
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await helper.cleanup();
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
      QWEN_CODE_DISABLE_CRON: '1',
      OPENAI_API_KEY: 'fake-key',
      OPENAI_BASE_URL: server!.baseUrl,
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

  it('only activates the human message in one unknown → human → unknown process, through tool continuations', async () => {
    server = await startFakeOpenAIServer(({ body }) => {
      const messages = body['messages'] as WireMessage[];
      if (currentUserText(body).includes('DW03_HUMAN')) {
        for (const id of ['dw03-read-1', 'dw03-read-2']) {
          if (!messages.some((message) => message.tool_call_id === id)) {
            return {
              toolCalls: [
                fakeToolCall(
                  'read_file',
                  {
                    file_path: join(
                      cwd,
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
      return { content: 'DW03_DONE' };
    }, fakeServerHostOptions());

    const waiter = createResultWaiter(3);
    async function* input(): AsyncIterable<SDKUserMessage> {
      const session_id = crypto.randomUUID();
      for (const [index, marker] of [
        'DW03_UNKNOWN_A',
        'DW03_HUMAN',
        'DW03_UNKNOWN_B',
      ].entries()) {
        yield {
          type: 'user',
          session_id,
          parent_tool_use_id: null,
          ...(index === 1 ? { origin: { kind: 'human' as const } } : {}),
          message: {
            role: 'user',
            content: `${marker} workflow ultracode: inspect sample.txt`,
          },
        };
        await waiter.waitForResult(index);
      }
    }
    const session = query({ prompt: input(), options: options() });
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
    expect(results).toBe(3);
    const requests = server.requests.filter(
      ({ body }) => body['stream'] === true,
    );
    expect(requests).toHaveLength(5);
    expect(
      requests.map(({ body }) => noticeCount(currentUserText(body))),
    ).toEqual([0, 1, 1, 1, 0]);
    expect(currentUserText(requests[1].body)).toContain('"ultracode" keyword');
    const toolResults = (requests[3].body['messages'] as WireMessage[]).filter(
      (message) => message.role === 'tool',
    );
    expect(toolResults).toHaveLength(2);
    for (const toolResult of toolResults) {
      expect(JSON.stringify(toolResult.content)).toContain('fixture content');
    }
  }, 90_000);

  it('does not stamp the string convenience prompt as human', async () => {
    server = await startFakeOpenAIServer(
      () => ({ content: 'DW03_DONE' }),
      fakeServerHostOptions(),
    );
    const session = query({
      prompt: 'workflow ultracode: inspect',
      options: options(),
    });
    try {
      for await (const message of session) {
        if (isSDKResultMessage(message))
          expect(message.subtype).toBe('success');
      }
    } finally {
      await session.close();
    }
    expect(server.requests.length).toBeGreaterThan(0);
    expect(
      server.requests.map(({ body }) => noticeCount(currentUserText(body))),
    ).toEqual(server.requests.map(() => 0));
  }, 45_000);

  it.each([
    ['keyword opt-out', { ui: { disableWorkflowKeywordTrigger: true } }, 0],
    ['workflows disabled', { tools: { workflowsEnabled: false } }, 0],
    [
      'named workflows only',
      { tools: { workflowsEnabled: true, workflowNameOnly: true } },
      1,
    ],
  ] as const)(
    'uses the actual user setting for %s',
    async (_label, setting, expected) => {
      const settings = JSON.parse(
        await helper.readFile('isolated-home/settings.json'),
      ) as Record<string, unknown>;
      await helper.createFile(
        'isolated-home/settings.json',
        JSON.stringify({ ...settings, ...setting }),
      );
      server = await startFakeOpenAIServer(
        () => ({ content: 'DW03_DONE' }),
        fakeServerHostOptions(),
      );
      const waiter = createResultWaiter(1);
      async function* input(): AsyncIterable<SDKUserMessage> {
        yield {
          type: 'user',
          session_id: crypto.randomUUID(),
          parent_tool_use_id: null,
          origin: { kind: 'human' },
          message: { role: 'user', content: 'ultracode: inspect' },
        };
        await waiter.waitForResult(0);
      }
      const session = query({ prompt: input(), options: options() });
      try {
        for await (const message of session) {
          if (isSDKResultMessage(message)) {
            expect(message.subtype).toBe('success');
            waiter.notifyResult();
          }
        }
      } finally {
        await session.close();
      }
      const requests = server.requests.filter(
        ({ body }) => body['stream'] === true,
      );
      expect(requests).toHaveLength(1);
      const text = currentUserText(requests[0].body);
      expect(noticeCount(text)).toBe(expected);
      if (expected === 1) {
        expect(text).toContain('{ name, args }');
        expect(text).not.toContain('author a script');
        expect(text).not.toContain('load the `workflow-authoring`');
      }
    },
    45_000,
  );

  it('does not call any model when UserPromptSubmit blocks a human keyword', async () => {
    server = await startFakeOpenAIServer(
      () => ({ content: 'SHOULD_NOT_RUN' }),
      fakeServerHostOptions(),
    );
    await helper.createFile(
      'isolated-home/settings.json',
      JSON.stringify({
        security: { auth: { selectedType: 'openai' } },
        tools: { workflowsEnabled: true },
        memory: {
          enableManagedAutoMemory: false,
          enableManagedAutoDream: false,
        },
        general: { enableAutoUpdate: false },
        telemetry: { enabled: false },
        model: { skipNextSpeakerCheck: true },
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'node block.mjs' }] },
          ],
        },
      }),
    );
    await helper.createFile(
      'block.mjs',
      `import { writeFileSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
writeFileSync('dw03-block-input.json', input);
process.stdout.write(JSON.stringify({decision:'block',reason:'DW03_BLOCKED'}));`,
    );
    const waiter = createResultWaiter(1);
    async function* input(): AsyncIterable<SDKUserMessage> {
      yield {
        type: 'user',
        session_id: crypto.randomUUID(),
        parent_tool_use_id: null,
        origin: { kind: 'human' },
        message: { role: 'user', content: 'ultracode: inspect sample.txt' },
      };
      await waiter.waitForResult(0);
    }
    const session = query({ prompt: input(), options: options() });
    let completed = false;
    try {
      for await (const message of session) {
        if (isSDKResultMessage(message)) {
          completed = true;
          waiter.notifyResult();
        }
      }
    } finally {
      await session.close();
    }
    expect(completed).toBe(true);
    expect(
      JSON.parse(await helper.readFile('dw03-block-input.json')),
    ).toMatchObject({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'ultracode: inspect sample.txt',
    });
    expect(server.requests).toHaveLength(0);
  }, 45_000);

  it('does not treat expanded file content as the human keyword source', async () => {
    await helper.createFile(
      'context.txt',
      'DW03_EXPANDED_ONLY workflow ultracode',
    );
    server = await startFakeOpenAIServer(
      () => ({ content: 'DW03_DONE' }),
      fakeServerHostOptions(),
    );
    const waiter = createResultWaiter(1);
    async function* input(): AsyncIterable<SDKUserMessage> {
      yield {
        type: 'user',
        session_id: crypto.randomUUID(),
        parent_tool_use_id: null,
        origin: { kind: 'human' },
        message: { role: 'user', content: '@context.txt inspect this context' },
      };
      await waiter.waitForResult(0);
    }
    const session = query({ prompt: input(), options: options() });
    try {
      for await (const message of session) {
        if (isSDKResultMessage(message)) {
          expect(message.subtype).toBe('success');
          waiter.notifyResult();
        }
      }
    } finally {
      await session.close();
    }
    const requests = server.requests.filter(
      ({ body }) => body['stream'] === true,
    );
    expect(requests).toHaveLength(1);
    const text = currentUserText(requests[0].body);
    expect(text).toContain('DW03_EXPANDED_ONLY workflow ultracode');
    expect(noticeCount(text)).toBe(0);
  }, 45_000);

  it('reloads the keyword opt-out in one live SDK process', async () => {
    server = await startFakeOpenAIServer(
      () => ({ content: 'DW03_DONE' }),
      fakeServerHostOptions(),
    );
    const waiter = createResultWaiter(3);
    const settings = JSON.parse(
      await helper.readFile('isolated-home/settings.json'),
    ) as Record<string, unknown>;
    async function* input(): AsyncIterable<SDKUserMessage> {
      const session_id = crypto.randomUUID();
      for (let index = 0; index < 3; index++) {
        if (index > 0) {
          await helper.createFile(
            'isolated-home/settings.json',
            JSON.stringify({
              ...settings,
              ui: { disableWorkflowKeywordTrigger: index === 1 },
            }),
          );
          // The production watcher debounces file events for 300 ms.
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        }
        yield {
          type: 'user',
          session_id,
          parent_tool_use_id: null,
          origin: { kind: 'human' },
          message: {
            role: 'user',
            content: `DW03_LIVE_${index} ultracode: inspect`,
          },
        };
        await waiter.waitForResult(index);
      }
    }
    const session = query({ prompt: input(), options: options() });
    let completed = 0;
    try {
      for await (const message of session) {
        if (isSDKResultMessage(message)) {
          expect(message.subtype).toBe('success');
          completed++;
          waiter.notifyResult();
        }
      }
    } finally {
      await session.close();
    }
    expect(completed).toBe(3);
    const requests = server.requests.filter(
      ({ body }) => body['stream'] === true,
    );
    expect(
      requests.map(({ body }) => noticeCount(currentUserText(body))),
    ).toEqual([1, 0, 1]);
  }, 60_000);
});
