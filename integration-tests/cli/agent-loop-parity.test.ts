/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Headless runs each scripted scenario twice, with
 * `experimental.unifiedAgentLoop` off and on, and the two runs must send the
 * model the same requests and print the same stream-json frames. Differences
 * the shared loop makes on purpose are asserted separately below.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTAINER_SANDBOX_NO_PROXY,
  fakeServerHostOptions,
  IS_CONTAINER_SANDBOX,
  TestRig,
} from '../test-helper.js';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIResponse,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

type JsonObject = Record<string, unknown>;

interface Scenario {
  name: string;
  prompt?: string;
  /** stream-json user messages, each sent after the previous result. */
  messages?: string[];
  args?: string[];
  prepare?: (rig: TestRig) => void;
  settings?: JsonObject;
  /**
   * Run in the default approval mode, which asks for every edit, and allow
   * every stream-json `can_use_tool` request.
   */
  approve?: boolean;
  /** The exit code both runs must end with; defaults to 0. */
  exitCode?: number;
  /** The model's reply to a streaming request, from its message history. */
  reply: (messages: JsonObject[], dir: string) => FakeOpenAIResponse;
}

interface Run {
  exitCode: number | null;
  requests: unknown[];
  frames: unknown[];
  stderr: string;
  /** The `tool_use_id` of each `can_use_tool` request, in order. */
  approvals: string[];
}

const toolResults = (messages: JsonObject[]) =>
  messages.filter((message) => message['role'] === 'tool').length;

const userTurns = (messages: JsonObject[]) =>
  messages.filter((message) => message['role'] === 'user').length;

function normalize(value: unknown, dir: string): unknown {
  return JSON.parse(
    JSON.stringify(value ?? null)
      .split(dir)
      .join('<DIR>'),
  );
}

function modelRequests(server: FakeOpenAIServer, dir: string): unknown[] {
  return server.requests
    .filter((request) => request.body['stream'] === true)
    .map((request) =>
      ((request.body['messages'] ?? []) as JsonObject[])
        .filter((message) => message['role'] !== 'system')
        .map((message) =>
          normalize(
            {
              role: message['role'],
              content: message['content'],
              tool_calls: message['tool_calls'],
              tool_call_id: message['tool_call_id'],
            },
            dir,
          ),
        ),
    );
}

function block(item: JsonObject): JsonObject {
  switch (item['type']) {
    case 'text':
      return { type: 'text', text: item['text'] };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: item['id'],
        name: item['name'],
        input: item['input'],
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: item['tool_use_id'],
        is_error: item['is_error'],
        content: item['content'],
      };
    default:
      return { type: item['type'] };
  }
}

function streamFrames(stdout: string, dir: string): unknown[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as JsonObject)
    .map((frame) => {
      const message = frame['message'] as { content?: JsonObject[] };
      switch (frame['type']) {
        case 'assistant':
        case 'user':
          return normalize(
            {
              type: frame['type'],
              content: (message?.content ?? []).map(block),
            },
            dir,
          );
        case 'result':
          return normalize(
            {
              type: 'result',
              subtype: frame['subtype'],
              is_error: frame['is_error'],
              result: frame['result'],
              num_turns: frame['num_turns'],
            },
            dir,
          );
        default:
          return { type: frame['type'], subtype: frame['subtype'] };
      }
    });
}

describe('agent loop parity (experimental.unifiedAgentLoop)', () => {
  let rig: TestRig;
  let server: FakeOpenAIServer | undefined;

  beforeEach(() => {
    const noProxy = IS_CONTAINER_SANDBOX
      ? CONTAINER_SANDBOX_NO_PROXY
      : '127.0.0.1,localhost';
    vi.stubEnv('NO_PROXY', noProxy);
    vi.stubEnv('no_proxy', noProxy);
    vi.stubEnv('QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP', undefined);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.unstubAllEnvs();
    await rig?.cleanup();
  });

  async function run(scenario: Scenario, shared: boolean): Promise<Run> {
    await server?.close();
    rig = new TestRig();
    await rig.setup(`agent-loop-parity ${scenario.name}`, {
      settings: {
        ...scenario.settings,
        experimental: { unifiedAgentLoop: shared },
      },
    });
    const dir = rig.testDir!;
    scenario.prepare?.(rig);
    server = await startFakeOpenAIServer(
      ({ body }) =>
        body['stream'] === true
          ? scenario.reply((body['messages'] ?? []) as JsonObject[], dir)
          : { content: '{"selected_memories":[]}' },
      fakeServerHostOptions(),
    );
    const args = [
      rig.bundlePath,
      '--no-chat-recording',
      ...(scenario.approve ? ['--approval-mode', 'default'] : ['--yolo']),
      ...(scenario.prompt !== undefined ? ['--prompt', scenario.prompt] : []),
      '--output-format',
      'stream-json',
      '--auth-type',
      'openai',
      '--model',
      'fake-model',
      '--openai-base-url',
      server.baseUrl,
      '--openai-api-key',
      'fake-key',
      ...(scenario.args ?? []),
    ];
    const child = spawn('node', args, {
      cwd: dir,
      stdio: 'pipe',
      env: process.env,
    });
    const messages = [...(scenario.messages ?? [])];
    const sendNext = () => {
      const next = messages.shift();
      if (next !== undefined) child.stdin.write(`${next}\n`);
      else if (!child.stdin.writableEnded) child.stdin.end();
    };
    let stdout = '';
    let lines = 0;
    const approvals: string[] = [];
    child.stdout.on('data', (data: Buffer) => {
      stdout += data;
      const complete = stdout.split('\n').slice(0, -1);
      for (; lines < complete.length; lines++) {
        if (!complete[lines].startsWith('{')) continue;
        const frame = JSON.parse(complete[lines]) as JsonObject;
        if (frame['type'] === 'result') sendNext();
        const request = frame['request'] as JsonObject | undefined;
        if (
          frame['type'] === 'control_request' &&
          request?.['subtype'] === 'can_use_tool'
        ) {
          approvals.push(String(request['tool_use_id']));
          child.stdin.write(
            `${JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: frame['request_id'],
                response: { behavior: 'allow' },
              },
            })}\n`,
          );
        }
      }
    });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => (stderr += data));
    // A session whose first message is a user message runs without the
    // control channel, so it would never send `can_use_tool`.
    if (scenario.approve) {
      child.stdin.write(
        `${JSON.stringify({
          type: 'control_request',
          request_id: 'initialize-parity',
          request: { subtype: 'initialize' },
        })}\n`,
      );
    }
    sendNext();
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on('close', resolve),
    );
    return {
      exitCode,
      requests: modelRequests(server, dir),
      frames: streamFrames(stdout, dir),
      stderr,
      approvals,
    };
  }

  async function both(scenario: Scenario) {
    const current = await run(scenario, false);
    const shared = await run(scenario, true);
    return { current, shared };
  }

  const read = (file: string, id: string) =>
    fakeToolCall('read_file', { file_path: file }, id);

  const message = (text: string) =>
    JSON.stringify({
      type: 'user',
      session_id: 'parity-session',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });

  const scenarios: Scenario[] = [
    {
      name: 'plain text',
      prompt: 'Say hello.',
      reply: () => ({ content: 'Hello there.' }),
    },
    {
      name: 'one tool',
      prompt: 'Read the readme.',
      prepare: (r) => r.createFile('readme.txt', 'readme body\n'),
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? { toolCalls: [read(join(dir, 'readme.txt'), 'call_read')] }
          : { content: 'It says readme body.' },
    },
    {
      name: 'parallel read-only batch',
      prompt: 'Read both files.',
      prepare: (r) => {
        r.createFile('a.txt', 'alpha\n');
        r.createFile('b.txt', 'beta\n');
      },
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? {
              toolCalls: [
                read(join(dir, 'a.txt'), 'call_a'),
                read(join(dir, 'b.txt'), 'call_b'),
              ],
            }
          : { content: 'Both read.' },
    },
    {
      name: 'mixed safe and unsafe calls',
      prompt: 'Read, write, read.',
      prepare: (r) => r.createFile('in.txt', 'input\n'),
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? {
              toolCalls: [
                read(join(dir, 'in.txt'), 'call_in'),
                fakeToolCall(
                  'write_file',
                  { file_path: join(dir, 'out.txt'), content: 'written\n' },
                  'call_write',
                ),
                read(join(dir, 'out.txt'), 'call_out'),
              ],
            }
          : { content: 'Done.' },
    },
    {
      name: 'Code Mode exec with a nested call',
      prompt: 'Read the readme through exec.',
      settings: { tools: { codeModeOnly: true } },
      prepare: (r) => r.createFile('readme.txt', 'readme body\n'),
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? {
              toolCalls: [
                fakeToolCall(
                  'exec',
                  {
                    source: `const r = await tools.read_file({ file_path: ${JSON.stringify(join(dir, 'readme.txt'))} }); text(r.output);`,
                  },
                  'call_exec',
                ),
              ],
            }
          : { content: 'It says readme body.' },
    },
    {
      name: 'cut-off edit',
      prompt: 'Write the notes.',
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? {
              toolCalls: [
                {
                  id: 'call_cut',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: `{"file_path":${JSON.stringify(join(dir, 'notes.txt'))},"content":"line one\\nline thr`,
                  },
                },
              ],
              finishReason: 'length',
            }
          : { content: 'Understood.' },
    },
    {
      name: 'tool budget edge',
      prompt: 'Read both files.',
      args: ['--max-tool-calls', '1'],
      exitCode: 55,
      prepare: (r) => {
        r.createFile('a.txt', 'alpha\n');
        r.createFile('b.txt', 'beta\n');
      },
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? {
              toolCalls: [
                read(join(dir, 'a.txt'), 'call_a'),
                read(join(dir, 'b.txt'), 'call_b'),
              ],
            }
          : { content: 'Both read.' },
    },
    {
      name: 'tool budget edge in a sequential batch',
      prompt: 'Write both files.',
      args: ['--max-tool-calls', '1'],
      exitCode: 55,
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? {
              toolCalls: [
                fakeToolCall(
                  'write_file',
                  { file_path: join(dir, 'one.txt'), content: 'one\n' },
                  'call_one',
                ),
                fakeToolCall(
                  'write_file',
                  { file_path: join(dir, 'two.txt'), content: 'two\n' },
                  'call_two',
                ),
              ],
            }
          : { content: 'Both written.' },
    },
    {
      name: 'tool budget counts a rejected call',
      prompt: 'Read, then write.',
      args: ['--max-tool-calls', '1'],
      exitCode: 55,
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? {
              toolCalls: [
                fakeToolCall('read_file', {}, 'call_invalid'),
                fakeToolCall(
                  'write_file',
                  { file_path: join(dir, 'out.txt'), content: 'out\n' },
                  'call_write',
                ),
              ],
            }
          : { content: 'Done.' },
    },
    {
      name: 'structured output with a sibling call',
      prompt: 'Answer in the schema.',
      args: [
        '--json-schema',
        JSON.stringify({
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        }),
      ],
      prepare: (r) => r.createFile('a.txt', 'alpha\n'),
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? {
              toolCalls: [
                read(join(dir, 'a.txt'), 'call_a'),
                fakeToolCall(
                  'structured_output',
                  { answer: '42' },
                  'call_structured',
                ),
              ],
            }
          : { content: 'Done.' },
    },
  ];

  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    '%s: same requests and output',
    async (_name, scenario) => {
      const { current, shared } = await both(scenario);

      expect(current.exitCode).toBe(scenario.exitCode ?? 0);
      expect(shared.exitCode).toBe(current.exitCode);
      expect(shared.requests).toEqual(current.requests);
      expect(shared.frames).toEqual(current.frames);
    },
    120_000,
  );

  it('ends a stream-json message past --max-session-turns at the limit (#15325)', async () => {
    const scenario: Scenario = {
      name: 'session turn cap',
      messages: [message('first question'), message('second question')],
      args: ['--input-format', 'stream-json', '--max-session-turns', '1'],
      reply: (messages) => ({ content: `answer ${userTurns(messages)}` }),
    };

    const { current, shared } = await both(scenario);
    const results = (frames: unknown[]) =>
      frames.filter((frame) => (frame as JsonObject)['type'] === 'result');

    // The current loop reports the second message as a success that repeats
    // the first answer, without asking the model.
    expect(current.exitCode).toBe(0);
    expect(current.requests).toHaveLength(1);
    expect(results(current.frames)).toMatchObject([
      { is_error: false, result: 'answer 1' },
      { is_error: false, result: 'answer 1' },
    ]);
    // The shared loop ends the run at the limit the way headless reports its
    // own limit: the error on stderr and exit code 53.
    expect(shared.exitCode).toBe(53);
    expect(shared.requests).toHaveLength(1);
    expect(results(shared.frames)).toMatchObject([
      { is_error: false, result: 'answer 1' },
    ]);
    expect(shared.stderr).toContain('Reached max session turns');
  }, 120_000);

  it('asks for approval of a whole batch before the tool budget stops it', async () => {
    const scenario: Scenario = {
      name: 'approvals at the tool budget edge',
      messages: [message('Write both files.')],
      args: ['--input-format', 'stream-json', '--max-tool-calls', '1'],
      approve: true,
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? {
              toolCalls: [
                fakeToolCall(
                  'write_file',
                  { file_path: join(dir, 'one.txt'), content: 'one\n' },
                  'call_one',
                ),
                fakeToolCall(
                  'write_file',
                  { file_path: join(dir, 'two.txt'), content: 'two\n' },
                  'call_two',
                ),
              ],
            }
          : { content: 'Both written.' },
    };

    const { current, shared } = await both(scenario);
    const output = (frames: unknown[]) =>
      frames.filter(
        (frame) => (frame as JsonObject)['type'] !== 'control_request',
      );

    expect(current.exitCode).toBe(55);
    expect(shared.exitCode).toBe(55);
    expect(shared.requests).toEqual(current.requests);
    expect(output(shared.frames)).toEqual(output(current.frames));
    // The current loop asks for each call right before it runs, so the call
    // past the budget is never asked. The shared loop asks for the whole batch
    // first, and the budget then stops the second call before it runs.
    expect(current.approvals).toEqual(['call_one']);
    expect(shared.approvals).toEqual(['call_one', 'call_two']);
  }, 120_000);
});
