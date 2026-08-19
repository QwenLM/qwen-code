/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
      const record = part as JsonObject;
      return typeof record['text'] === 'string' ? record['text'] : '';
    })
    .join('\n');
}

function allMessageText(body: JsonObject): string {
  return messagesOf(body)
    .map((message) => textFromContent(message['content']))
    .join('\n');
}

function parseAdvisorEvidence(body: JsonObject): JsonObject {
  const text = allMessageText(body);
  const start = text.indexOf('{"executorSystemInstruction"');
  expect(
    start,
    'Advisor request should include serialized evidence',
  ).toBeGreaterThanOrEqual(0);
  return JSON.parse(text.slice(start)) as JsonObject;
}

function toolNames(body: JsonObject): string[] {
  const tools = body['tools'];
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (typeof tool !== 'object' || tool === null) return [];
    const record = tool as JsonObject;
    const fn = record['function'];
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

async function setupRig(
  name: string,
  baseUrl: string,
  extraSettings: JsonObject = {},
): Promise<TestRig> {
  const nextRig = new TestRig();
  await nextRig.setup(name, {
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
      ...extraSettings,
    },
  });
  configureEnv(nextRig.testDir!, baseUrl);
  return nextRig;
}

function readUsageRecords(testDir: string): JsonObject[] {
  const usageDir = join(testDir, '.qwen', 'usage');
  if (!existsSync(usageDir)) return [];
  return readdirSync(usageDir)
    .filter((fileName) => fileName.endsWith('.jsonl'))
    .flatMap((fileName) =>
      readFileSync(join(usageDir, fileName), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as JsonObject];
          } catch {
            return [];
          }
        }),
    );
}

function resultEventFrom(output: string): JsonObject {
  const events = JSON.parse(output) as JsonObject[];
  const resultEvent = events.find((event) => event['type'] === 'result');
  expect(resultEvent).toEqual(expect.any(Object));
  return resultEvent!;
}

describe('advisor native tool', () => {
  it('runs Advisor on its configured model and returns advice to the executor', async () => {
    let mainRequestIndex = 0;
    let advisorRequestIndex = 0;
    server = await startFakeOpenAIServer(({ body }) => {
      if (body['model'] === 'advisor-model') {
        advisorRequestIndex += 1;
        return {
          content: `Advisor advice ${advisorRequestIndex}: inspect the evidence before acting.`,
          usage: {
            prompt_tokens: 40 + advisorRequestIndex,
            completion_tokens: 5,
            total_tokens: 45 + advisorRequestIndex,
            prompt_tokens_details: { cached_tokens: advisorRequestIndex },
          },
        };
      }

      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }

      mainRequestIndex += 1;
      if (mainRequestIndex === 1) {
        return {
          content: 'I want a second opinion before touching files.',
          toolCalls: [fakeToolCall('advisor', {}, 'advisor-call-1')],
        };
      }
      if (mainRequestIndex === 2) {
        return {
          toolCalls: [
            fakeToolCall(
              'run_shell_command',
              { command: 'printf tool-output' },
              'shell-call-1',
            ),
          ],
        };
      }
      if (mainRequestIndex === 3) {
        return {
          content: 'The shell result is in; I want one final check.',
          toolCalls: [fakeToolCall('advisor', {}, 'advisor-call-2')],
        };
      }
      return { content: 'Final after two consultations.' };
    }, fakeServerHostOptions());

    rig = await setupRig(
      'advisor native tool consults configured model',
      server.baseUrl,
    );

    const output = await rig.run(
      'Use advisor when useful, then finish the task.',
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

    expect(output).toContain('Final after two consultations.');

    const mainRequests = server.requests
      .map((request) => request.body)
      .filter(
        (body) => body['stream'] === true && body['model'] === 'request-model',
      );
    const advisorRequests = server.requests
      .map((request) => request.body)
      .filter((body) => body['model'] === 'advisor-model');

    expect(mainRequests).toHaveLength(4);
    expect(advisorRequests).toHaveLength(2);

    expect(toolNames(mainRequests[0]!)).toContain('advisor');
    expect(allMessageText(mainRequests[0]!)).toContain(
      "Call 'advisor' by itself",
    );
    for (const advisorRequest of advisorRequests) {
      expect(advisorRequest).not.toHaveProperty('tools');
    }

    const firstEvidence = parseAdvisorEvidence(advisorRequests[0]!);
    expect(firstEvidence['executorSystemInstruction']).toEqual(
      expect.anything(),
    );
    expect(firstEvidence['executorToolDeclarations']).toEqual(
      expect.anything(),
    );
    expect(firstEvidence['marker']).toMatchObject({
      type: 'advisor_consultation',
    });
    expect(
      JSON.stringify(firstEvidence['transcript']),
      'first evidence should include current assistant text before the call',
    ).toContain('I want a second opinion before touching files.');

    expect(allMessageText(mainRequests[1]!)).toContain('Advisor advice 1');
    expect(JSON.stringify(messagesOf(mainRequests[1]!))).toContain(
      'advisor-call-1',
    );

    const secondEvidence = parseAdvisorEvidence(advisorRequests[1]!);
    const secondTranscript = JSON.stringify(secondEvidence['transcript']);
    expect(secondTranscript).toContain('Advisor advice 1');
    expect(secondTranscript).toContain('run_shell_command');
    expect(secondTranscript).toContain('tool-output');
    expect(secondTranscript).toContain(
      'The shell result is in; I want one final check.',
    );

    const promptIds = advisorRequests.map((body) => {
      const marker = parseAdvisorEvidence(body)['marker'];
      expect(marker).toEqual(expect.any(Object));
      return (marker as JsonObject)['promptId'];
    });
    expect(promptIds).toHaveLength(2);
    expect(new Set(promptIds).size).toBe(1);

    const toolCallFound = await rig.waitForToolCall('advisor');
    expect(toolCallFound).toBe(true);
    const advisorToolCalls = rig
      .readToolLogs()
      .filter((log) => log.toolRequest.name === 'advisor');
    expect(advisorToolCalls).toHaveLength(2);
    expect(advisorToolCalls.every((log) => log.toolRequest.success)).toBe(true);

    const resultEvent = resultEventFrom(output);
    expect(JSON.stringify(resultEvent['stats'])).toContain('advisor-model');
    expect(JSON.stringify(resultEvent['stats'])).toContain('"advisor"');

    const usageWritten = await rig.poll(
      () =>
        readUsageRecords(rig!.testDir!).some(
          (record) =>
            record['source'] === 'advisor' &&
            record['model'] === 'advisor-model' &&
            record['cachedTokens'] === 1,
        ),
      2000,
      100,
    );
    expect(usageWritten).toBe(true);
    const telemetry = rig.readFile('telemetry.log');
    expect(telemetry).toContain('"subagent_name": "advisor"');
    expect(telemetry).toContain(`side-query:advisor:${promptIds[0]}:1`);
    expect(telemetry).toContain(`side-query:advisor:${promptIds[0]}:2`);

    const advisorUsageRecords = readUsageRecords(rig.testDir!).filter(
      (record) => record['source'] === 'advisor',
    );
    expect(advisorUsageRecords).toHaveLength(2);
    expect(
      new Set(advisorUsageRecords.map((record) => record['id'])).size,
    ).toBe(2);
    expect(
      advisorUsageRecords.map((record) => ({
        parent: record['advisorParentPromptId'],
        ordinal: record['advisorConsultationOrdinal'],
      })),
    ).toEqual([
      { parent: promptIds[0], ordinal: 1 },
      { parent: promptIds[0], ordinal: 2 },
    ]);
  });

  it('enables Advisor from persisted settings in headless mode', async () => {
    let mainRequestIndex = 0;
    server = await startFakeOpenAIServer(({ body }) => {
      if (body['model'] === 'advisor-model') {
        return {
          content: 'Advisor advice from settings.',
          usage: {
            prompt_tokens: 20,
            completion_tokens: 4,
            total_tokens: 24,
          },
        };
      }

      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }

      mainRequestIndex += 1;
      return mainRequestIndex === 1
        ? { toolCalls: [fakeToolCall('advisor', {}, 'advisor-settings-call')] }
        : { content: 'Final after settings advisor.' };
    }, fakeServerHostOptions());

    rig = await setupRig(
      'advisor native tool from persisted settings',
      server.baseUrl,
    );

    const output = await rig.run(
      'Use the configured advisor, then finish.',
      '--auth-type',
      'openai',
      '--model',
      'request-model',
      '--openai-base-url',
      server.baseUrl,
      '--openai-api-key',
      'fake-key',
      '--output-format',
      'json',
    );

    expect(output).toContain('Final after settings advisor.');

    const mainRequests = server.requests
      .map((request) => request.body)
      .filter(
        (body) => body['stream'] === true && body['model'] === 'request-model',
      );
    const advisorRequests = server.requests
      .map((request) => request.body)
      .filter((body) => body['model'] === 'advisor-model');

    expect(mainRequests).toHaveLength(2);
    expect(advisorRequests).toHaveLength(1);
    expect(toolNames(mainRequests[0]!)).toContain('advisor');
    expect(allMessageText(mainRequests[1]!)).toContain(
      'Advisor advice from settings.',
    );
  });

  it('continues the executor turn when the Advisor provider fails', async () => {
    let mainRequestIndex = 0;
    server = await startFakeOpenAIServer(({ body }) => {
      if (body['model'] === 'advisor-model') {
        throw new Error('advisor provider is down');
      }

      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }

      mainRequestIndex += 1;
      return mainRequestIndex === 1
        ? { toolCalls: [fakeToolCall('advisor', {}, 'advisor-fail-call')] }
        : { content: 'Final after advisor failure.' };
    }, fakeServerHostOptions());

    rig = await setupRig(
      'advisor provider failure is non fatal',
      server.baseUrl,
    );

    const output = await rig.run(
      'Consult advisor once, then continue even if it fails.',
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

    expect(output).toContain('Final after advisor failure.');
    const advisorRequests = server.requests.filter(
      (request) => request.body['model'] === 'advisor-model',
    );
    expect(advisorRequests.length).toBeGreaterThan(0);
    const mainRequests = server.requests
      .map((request) => request.body)
      .filter(
        (body) => body['stream'] === true && body['model'] === 'request-model',
      );
    expect(allMessageText(mainRequests[1]!)).toContain(
      'Advisor consultation failed',
    );
    expect(await rig.waitForToolCall('advisor')).toBe(true);
    const advisorToolCalls = rig
      .readToolLogs()
      .filter((log) => log.toolRequest.name === 'advisor');
    expect(advisorToolCalls).toHaveLength(1);
    expect(advisorToolCalls[0]?.toolRequest.success).toBe(false);

    const failureUsageWritten = await rig.poll(
      () =>
        readUsageRecords(rig!.testDir!).some(
          (record) =>
            record['source'] === 'advisor' &&
            record['requestStatus'] === 'failure' &&
            record['errorCode'] === 'unavailable',
        ),
      2000,
      100,
    );
    expect(failureUsageWritten).toBe(true);
  });

  it('keeps normal tool permissions after Advisor advice', async () => {
    let mainRequestIndex = 0;
    server = await startFakeOpenAIServer(({ body }) => {
      if (body['model'] === 'advisor-model') {
        return {
          content:
            'Advisor advice: create permission-bypass-marker with touch.',
        };
      }

      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }

      mainRequestIndex += 1;
      if (mainRequestIndex === 1) {
        return {
          toolCalls: [fakeToolCall('advisor', {}, 'advisor-permission-call')],
        };
      }
      if (mainRequestIndex === 2) {
        return {
          toolCalls: [
            fakeToolCall(
              'run_shell_command',
              { command: 'touch permission-bypass-marker' },
              'shell-denied-call',
            ),
          ],
        };
      }
      return { content: 'Final after denied shell call.' };
    }, fakeServerHostOptions());

    rig = await setupRig(
      'advisor advice cannot bypass permissions',
      server.baseUrl,
    );

    const output = await rig.run(
      'Consult advisor, then try the suggested shell command.',
      '--auth-type',
      'openai',
      '--model',
      'request-model',
      '--advisor',
      'advisor-model',
      '--exclude-tools',
      'Bash(touch *)',
      '--openai-base-url',
      server.baseUrl,
      '--openai-api-key',
      'fake-key',
      '--output-format',
      'json',
    );

    expect(output).toContain('Final after denied shell call.');
    expect(existsSync(join(rig.testDir!, 'permission-bypass-marker'))).toBe(
      false,
    );

    expect(await rig.waitForToolCall('run_shell_command')).toBe(true);
    const shellToolCalls = rig
      .readToolLogs()
      .filter((log) => log.toolRequest.name === 'run_shell_command');
    expect(shellToolCalls).toHaveLength(1);
    expect(shellToolCalls[0]?.toolRequest.success).toBe(false);

    const mainRequests = server.requests
      .map((request) => request.body)
      .filter(
        (body) => body['stream'] === true && body['model'] === 'request-model',
      );
    expect(allMessageText(mainRequests[2]!)).toContain(
      'denied by permission rules',
    );
    expect(allMessageText(mainRequests[2]!)).toContain('Bash(touch *)');
  });

  it('cancels the executor turn when Advisor is aborted', async () => {
    let mainRequestIndex = 0;
    server = await startFakeOpenAIServer(({ body }) => {
      if (body['model'] === 'advisor-model') {
        return new Promise(() => undefined);
      }

      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }

      mainRequestIndex += 1;
      return mainRequestIndex === 1
        ? { toolCalls: [fakeToolCall('advisor', {}, 'advisor-cancel-call')] }
        : { content: 'This should not be reached after cancellation.' };
    }, fakeServerHostOptions());

    rig = await setupRig(
      'advisor cancellation aborts main turn',
      server.baseUrl,
    );

    await expect(
      rig.run(
        'Consult advisor, then wait.',
        '--auth-type',
        'openai',
        '--model',
        'request-model',
        '--advisor',
        'advisor-model',
        '--max-wall-time',
        '1s',
        '--openai-base-url',
        server.baseUrl,
        '--openai-api-key',
        'fake-key',
        '--output-format',
        'json',
      ),
    ).rejects.toThrow('wall-clock budget of 1s exceeded');

    expect(
      server.requests.some(
        (request) => request.body['model'] === 'advisor-model',
      ),
    ).toBe(true);
    const mainRequests = server.requests
      .map((request) => request.body)
      .filter(
        (body) => body['stream'] === true && body['model'] === 'request-model',
      );
    expect(mainRequests).toHaveLength(1);
  });

  it('cancels the executor turn on SIGINT while Advisor is running', async () => {
    let mainRequestIndex = 0;
    server = await startFakeOpenAIServer(({ body }) => {
      if (body['model'] === 'advisor-model') {
        return new Promise(() => undefined);
      }

      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }

      mainRequestIndex += 1;
      return mainRequestIndex === 1
        ? { toolCalls: [fakeToolCall('advisor', {}, 'advisor-sigint-call')] }
        : { content: 'This should not be reached after SIGINT.' };
    }, fakeServerHostOptions());

    rig = await setupRig(
      'advisor sigint cancellation aborts main turn',
      server.baseUrl,
    );

    const child = spawn(
      'node',
      [
        rig.bundlePath,
        '--no-chat-recording',
        '--yolo',
        '--prompt',
        'Consult advisor, then wait.',
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
      ],
      {
        cwd: rig.testDir!,
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: rig.testDir!,
          QWEN_HOME: join(rig.testDir!, '.qwen'),
          QWEN_RUNTIME_DIR: join(rig.testDir!, '.qwen'),
          QWEN_CODE_NO_RELAUNCH: '1',
        },
      },
    );

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    expect(
      await rig.poll(
        () =>
          server!.requests.some(
            (request) => request.body['model'] === 'advisor-model',
          ),
        5000,
        100,
      ),
    ).toBe(true);

    child.kill('SIGINT');

    const result = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once('close', (code, signal) => resolve({ code, signal }));
        },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`SIGINT did not exit the child. stderr: ${stderr}`));
        }, 10000),
      ),
    ]);

    expect(result).toMatchObject({ code: 130, signal: null });
    const mainRequests = server.requests
      .map((request) => request.body)
      .filter(
        (body) => body['stream'] === true && body['model'] === 'request-model',
      );
    expect(mainRequests).toHaveLength(1);
  });

  it('does not send a second Advisor request after advisorMaxUses is reached', async () => {
    let mainRequestIndex = 0;
    server = await startFakeOpenAIServer(({ body }) => {
      if (body['model'] === 'advisor-model') {
        return {
          content: 'Advisor advice before the limit.',
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
          },
        };
      }

      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }

      mainRequestIndex += 1;
      if (mainRequestIndex === 1) {
        return { toolCalls: [fakeToolCall('advisor', {}, 'advisor-limit-1')] };
      }
      if (mainRequestIndex === 2) {
        return { toolCalls: [fakeToolCall('advisor', {}, 'advisor-limit-2')] };
      }
      return { content: 'Final after max-use error.' };
    }, fakeServerHostOptions());

    rig = await setupRig(
      'advisor max uses blocks the second provider request',
      server.baseUrl,
      { advisorMaxUses: 1 },
    );

    const output = await rig.run(
      'Try advisor twice, then finish.',
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

    expect(output).toContain('Final after max-use error.');
    const advisorRequests = server.requests.filter(
      (request) => request.body['model'] === 'advisor-model',
    );
    expect(advisorRequests).toHaveLength(1);

    const mainRequests = server.requests
      .map((request) => request.body)
      .filter(
        (body) => body['stream'] === true && body['model'] === 'request-model',
      );
    expect(mainRequests).toHaveLength(3);
    expect(allMessageText(mainRequests[1]!)).toContain(
      'Advisor advice before the limit.',
    );
    expect(allMessageText(mainRequests[2]!)).toContain(
      'Advisor consultation limit has been reached for this prompt.',
    );

    expect(await rig.waitForToolCall('advisor')).toBe(true);
    const advisorToolCalls = rig
      .readToolLogs()
      .filter((log) => log.toolRequest.name === 'advisor');
    expect(advisorToolCalls).toHaveLength(2);
    expect(advisorToolCalls.map((log) => log.toolRequest.success)).toEqual([
      true,
      false,
    ]);
  });

  it('removes the Advisor declaration and instruction when disabled at runtime', async () => {
    server = await startFakeOpenAIServer(({ body }) => {
      if (body['stream'] !== true) {
        return { content: '{"selected_memories":[]}' };
      }
      return { content: 'Final with advisor disabled.' };
    }, fakeServerHostOptions());

    rig = await setupRig('advisor off removes native tool', server.baseUrl);

    const output = await rig.run(
      'Finish without advisor.',
      '--auth-type',
      'openai',
      '--model',
      'request-model',
      '--advisor',
      'off',
      '--openai-base-url',
      server.baseUrl,
      '--openai-api-key',
      'fake-key',
      '--output-format',
      'json',
    );

    expect(output).toContain('Final with advisor disabled.');
    const mainRequests = server.requests
      .map((request) => request.body)
      .filter(
        (body) => body['stream'] === true && body['model'] === 'request-model',
      );
    expect(mainRequests.length).toBeGreaterThan(0);
    for (const mainRequest of mainRequests) {
      expect(toolNames(mainRequest)).not.toContain('advisor');
      expect(allMessageText(mainRequest)).not.toContain(
        "Call 'advisor' by itself",
      );
    }
    expect(
      server.requests.some(
        (request) => request.body['model'] === 'advisor-model',
      ),
    ).toBe(false);
  });
});
