/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  fakeServerHostOptions,
  IS_CONTAINER_SANDBOX,
  CONTAINER_SANDBOX_NO_PROXY,
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
  server = undefined;
  await rig?.cleanup();
  rig = undefined;
});

function messagesOf(body: JsonObject): JsonObject[] {
  const messages = body['messages'];
  return Array.isArray(messages)
    ? messages.filter(
        (message): message is JsonObject =>
          typeof message === 'object' && message !== null,
      )
    : [];
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part !== 'object' || part === null) return '';
      const text = (part as JsonObject)['text'];
      return typeof text === 'string' ? text : '';
    })
    .join('\n');
}

function allMessageText(body: JsonObject): string {
  return messagesOf(body)
    .map((message) => textFromContent(message['content']))
    .join('\n');
}

function toolNames(body: JsonObject): string[] {
  const tools = body['tools'];
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (typeof tool !== 'object' || tool === null) return [];
    const fn = (tool as JsonObject)['function'];
    if (typeof fn !== 'object' || fn === null) return [];
    const name = (fn as JsonObject)['name'];
    return typeof name === 'string' ? [name] : [];
  });
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
  vi.stubEnv('OPENAI_MODEL', 'request-model');
  vi.stubEnv('QWEN_MODEL', 'request-model');
  vi.stubEnv('NO_PROXY', noProxy);
  vi.stubEnv('no_proxy', noProxy);
  vi.stubEnv('HTTP_PROXY', '');
  vi.stubEnv('HTTPS_PROXY', '');
  vi.stubEnv('ALL_PROXY', '');
  vi.stubEnv('http_proxy', '');
  vi.stubEnv('https_proxy', '');
  vi.stubEnv('all_proxy', '');
}

async function setupRig(baseUrl: string): Promise<TestRig> {
  const nextRig = new TestRig();
  await nextRig.setup('advisor native tool smoke', {
    settings: {
      modelProviders: {
        openai: [
          {
            id: 'request-model',
            name: 'Request Model',
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

describe('advisor native tool', () => {
  it('returns a read-only Advisor review to the executor', async () => {
    let mainRequestIndex = 0;
    let evidenceFile = '';
    server = await startFakeOpenAIServer(({ body }) => {
      if (body['model'] === 'advisor-model') {
        return {
          content: JSON.stringify({
            verdict: 'The approach is sound.',
            risks: 'None found',
            missingEvidence: 'None found',
            recommendation: 'Continue the executor task.',
          }),
        };
      }
      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }
      mainRequestIndex += 1;
      if (mainRequestIndex === 1) {
        return {
          content: 'I will inspect the evidence first.',
          toolCalls: [
            fakeToolCall('read_file', { file_path: evidenceFile }, 'read-call'),
          ],
        };
      }
      if (mainRequestIndex === 2) {
        return {
          content: 'I found the evidence and will ask for a second opinion.',
          toolCalls: [fakeToolCall('advisor', {}, 'advisor-call')],
        };
      }
      return { content: 'Final answer after Advisor feedback.' };
    }, fakeServerHostOptions());

    rig = await setupRig(server.baseUrl);
    evidenceFile = rig.createFile('evidence.txt', 'wire-level evidence');
    const output = await rig.run(
      'Review the task and finish.',
      '--auth-type',
      'openai',
      '--model',
      'request-model',
      '--advisor',
      'advisor-model',
      '--openai-base-url',
      server.baseUrl,
      '--openai-api-key',
      'fake-key',
      '--output-format',
      'json',
    );

    expect(output).toContain('Final answer after Advisor feedback.');
    const mainRequests = server.requests
      .map((request) => request.body)
      .filter(
        (body) => body['stream'] === true && body['model'] === 'request-model',
      );
    const advisorRequests = server.requests
      .map((request) => request.body)
      .filter((body) => body['model'] === 'advisor-model');

    expect(mainRequests).toHaveLength(3);
    expect(advisorRequests).toHaveLength(1);
    expect(toolNames(mainRequests[0]!)).toContain('advisor');
    expect(toolNames(advisorRequests[0]!)).toEqual(['respond_in_schema']);
    const advisorText = allMessageText(advisorRequests[0]!);
    const evidence = JSON.parse(
      messagesOf(advisorRequests[0]!)
        .map((message) => textFromContent(message['content']))
        .find((text) => text.startsWith('{'))!,
    ) as JsonObject;
    expect(advisorText).toContain('independent, read-only senior advisor');
    expect(JSON.stringify(evidence['executorSystemInstruction'])).toContain(
      'You are Qwen Code',
    );
    expect(JSON.stringify(evidence['executorToolDeclarations'])).toContain(
      'read_file',
    );
    expect(JSON.stringify(evidence['transcript'])).toContain('read_file');
    expect(JSON.stringify(evidence['transcript'])).toContain(
      'wire-level evidence',
    );
    expect(JSON.stringify(evidence['transcript'])).toContain(
      'I found the evidence and will ask for a second opinion.',
    );
    expect(allMessageText(mainRequests[2]!)).toContain('<advisor_feedback>');
    expect(await rig.waitForToolCall('advisor')).toBe(true);
  });
});
