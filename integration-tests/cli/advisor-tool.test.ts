/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  CONTAINER_SANDBOX_NO_PROXY,
  fakeServerHostOptions,
  IS_CONTAINER_SANDBOX,
  TestRig,
} from '../test-helper.js';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

type JsonObject = Record<string, unknown>;

let rig: TestRig | undefined;
let server: FakeOpenAIServer | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await server?.close();
  await rig?.cleanup();
  server = undefined;
  rig = undefined;
});

function messages(body: JsonObject): JsonObject[] {
  return Array.isArray(body['messages'])
    ? body['messages'].filter(
        (value): value is JsonObject =>
          typeof value === 'object' && value !== null,
      )
    : [];
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'object' &&
      part !== null &&
      typeof (part as JsonObject)['text'] === 'string'
        ? String((part as JsonObject)['text'])
        : '',
    )
    .join('\n');
}

function requestText(body: JsonObject): string {
  return messages(body)
    .map((message) => contentText(message['content']))
    .join('\n');
}

function toolNames(body: JsonObject): string[] {
  return Array.isArray(body['tools'])
    ? body['tools'].flatMap((tool) => {
        if (typeof tool !== 'object' || tool === null) return [];
        const fn = (tool as JsonObject)['function'];
        if (typeof fn !== 'object' || fn === null) return [];
        const name = (fn as JsonObject)['name'];
        return typeof name === 'string' ? [name] : [];
      })
    : [];
}

function configureEnv(testDir: string, baseUrl: string): void {
  const noProxy = IS_CONTAINER_SANDBOX
    ? CONTAINER_SANDBOX_NO_PROXY
    : '127.0.0.1,localhost';
  vi.stubEnv('HOME', testDir);
  vi.stubEnv('QWEN_HOME', join(testDir, '.qwen'));
  vi.stubEnv('QWEN_RUNTIME_DIR', join(testDir, '.qwen'));
  vi.stubEnv('OPENAI_API_KEY', 'fake-key');
  vi.stubEnv('OPENAI_BASE_URL', baseUrl);
  vi.stubEnv('OPENAI_MODEL', 'executor-model');
  vi.stubEnv('QWEN_MODEL', 'executor-model');
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('NO_PROXY', noProxy);
  vi.stubEnv('no_proxy', noProxy);
}

async function setupRig(baseUrl: string): Promise<TestRig> {
  const nextRig = new TestRig();
  await nextRig.setup('native advisor tool', {
    settings: {
      modelProviders: {
        openai: [
          {
            id: 'executor-model',
            name: 'Executor Model',
            baseUrl,
            envKey: 'OPENAI_API_KEY',
          },
          {
            id: 'advisor-model',
            name: 'Advisor Model',
            baseUrl,
            envKey: 'OPENAI_API_KEY',
          },
        ],
      },
      security: { auth: { selectedType: 'openai' } },
      advisorModel: 'advisor-model',
      ui: { enableFollowupSuggestions: false },
    },
  });
  configureEnv(nextRig.testDir!, baseUrl);
  return nextRig;
}

async function runPrompt(prompt: string, advisor = 'advisor-model') {
  const sessionId = crypto.randomUUID();
  const input = [
    {
      type: 'control_request',
      request_id: 'initialize-advisor-test',
      request: { subtype: 'initialize' },
    },
    {
      type: 'user',
      session_id: sessionId,
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
    },
  ]
    .map((message) => JSON.stringify(message))
    .join('\n');
  return rig!.run(
    { stdin: input },
    '--auth-type',
    'openai',
    '--model',
    'executor-model',
    '--advisor',
    advisor,
    '--openai-base-url',
    server!.baseUrl,
    '--openai-api-key',
    'fake-key',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  );
}

describe('native Advisor tool', () => {
  it('forwards the transcript to a no-tools model and reinjects its review', async () => {
    let evidenceFile = '';
    server = await startFakeOpenAIServer(({ body }) => {
      if (body['model'] === 'advisor-model') {
        return {
          content: JSON.stringify({
            verdict: 'The approach is sound.',
            risks: 'None found.',
            missingEvidence: 'None found.',
            recommendation: 'Finish the task.',
          }),
        };
      }
      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }
      const text = requestText(body);
      if (text.includes('The approach is sound.')) {
        return { content: 'Final answer after Advisor feedback.' };
      }
      if (text.includes('wire-level evidence')) {
        return {
          content: 'I found the evidence and will ask for a second opinion.',
          toolCalls: [fakeToolCall('advisor', {}, 'advisor-call')],
        };
      }
      if (text.includes('Review the task and finish.')) {
        return {
          content: 'I will inspect the evidence first.',
          toolCalls: [
            fakeToolCall('read_file', { file_path: evidenceFile }, 'read-call'),
          ],
        };
      }
      return { content: 'Prior answer with unique context.' };
    }, fakeServerHostOptions());

    rig = await setupRig(server.baseUrl);
    evidenceFile = rig.createFile('evidence.txt', 'wire-level evidence');
    const sessionId = crypto.randomUUID();
    const input = [
      {
        type: 'control_request',
        request_id: 'initialize-advisor-test',
        request: { subtype: 'initialize' },
      },
      {
        type: 'user',
        session_id: sessionId,
        message: { role: 'user', content: 'Remember this prior request.' },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        session_id: sessionId,
        message: { role: 'user', content: 'Review the task and finish.' },
        parent_tool_use_id: null,
      },
    ]
      .map((message) => JSON.stringify(message))
      .join('\n');

    const output = await rig.run(
      { stdin: input },
      '--auth-type',
      'openai',
      '--model',
      'executor-model',
      '--advisor',
      'advisor-model',
      '--openai-base-url',
      server.baseUrl,
      '--openai-api-key',
      'fake-key',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    );

    expect(output).toContain('Final answer after Advisor feedback.');
    const requests = server.requests.map((request) => request.body);
    const executorRequests = requests.filter(
      (body) => body['stream'] === true && body['model'] === 'executor-model',
    );
    const advisorRequests = requests.filter(
      (body) => body['model'] === 'advisor-model',
    );
    expect(
      executorRequests.some((request) =>
        toolNames(request).includes('advisor'),
      ),
    ).toBe(true);
    expect(advisorRequests).toHaveLength(1);
    expect(toolNames(advisorRequests[0]!)).toEqual(['respond_in_schema']);

    const advisorText = requestText(advisorRequests[0]!);
    const evidenceText = messages(advisorRequests[0]!)
      .map((message) => contentText(message['content']))
      .find((text) => text.startsWith('{'));
    expect(evidenceText).toBeDefined();
    const evidence = JSON.parse(evidenceText!) as JsonObject;
    expect(advisorText).toContain('independent senior advisor');
    expect(JSON.stringify(evidence['executorSystemInstruction'])).toContain(
      'You are Qwen Code',
    );
    expect(JSON.stringify(evidence['executorToolDeclarations'])).toContain(
      'read_file',
    );
    const transcript = JSON.stringify(evidence['transcript']);
    expect(transcript).toContain('Remember this prior request.');
    expect(transcript).toContain('Prior answer with unique context.');
    expect(transcript).toContain('wire-level evidence');
    expect(transcript).toContain('I will inspect the evidence first.');
    expect(transcript).toContain(
      'I found the evidence and will ask for a second opinion.',
    );
  });

  it('lets the executor continue after an Advisor failure', async () => {
    server = await startFakeOpenAIServer(({ body }) => {
      if (body['model'] === 'advisor-model') {
        return { content: 'invalid advisor output' };
      }
      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }
      const text = requestText(body);
      if (text.includes('Advisor returned invalid structured output.')) {
        return { content: 'Executor continued without Advisor.' };
      }
      return {
        content: 'I will ask Advisor.',
        toolCalls: [fakeToolCall('advisor', {}, 'advisor-failure-call')],
      };
    }, fakeServerHostOptions());
    rig = await setupRig(server.baseUrl);

    const output = await runPrompt('Test Advisor failure handling.');

    expect(output).toContain('Executor continued without Advisor.');
    expect(
      server.requests.filter(
        (request) => request.body['model'] === 'advisor-model',
      ),
    ).toHaveLength(1);
  });

  it('does not expose or request Advisor when the session override is off', async () => {
    server = await startFakeOpenAIServer(
      ({ body }) => ({
        content:
          body['stream'] === true
            ? 'Advisor is not available in this request.'
            : '{"selected_memories":[]}',
      }),
      fakeServerHostOptions(),
    );
    rig = await setupRig(server.baseUrl);

    const output = await runPrompt('Check the available tools.', 'off');

    expect(output).toContain('Advisor is not available in this request.');
    const executorRequests = server.requests.filter(
      (request) => request.body['model'] === 'executor-model',
    );
    expect(
      executorRequests.every(
        (request) => !toolNames(request.body).includes('advisor'),
      ),
    ).toBe(true);
    expect(
      server.requests.some(
        (request) => request.body['model'] === 'advisor-model',
      ),
    ).toBe(false);
  });
});
