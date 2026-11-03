/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Ink TUI runs each scripted scenario twice, with
 * `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP` unset and set, and the two runs must
 * send the model the same requests and record the same session. The screen is
 * not compared: it repaints on timers, and what it shows comes from the same
 * events the session records.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIResponse,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { pickE2eRenderer } from '../renderer-matrix.js';
import { IS_CONTAINER_SANDBOX } from '../test-helper.js';
import { InteractiveSession } from './interactive-session.js';

type JsonObject = Record<string, unknown>;

interface Scenario {
  name: string;
  prompts: string[];
  /** Files to create in the workspace, by relative path. */
  files?: Record<string, string>;
  settings?: JsonObject;
  /**
   * Text both runs must show at the end, for a scenario that sends and
   * records nothing.
   */
  shows?: string;
  /**
   * The model's reply to a streaming request, from its message history;
   * `index` counts this run's streaming requests, retries included.
   */
  reply: (
    messages: JsonObject[],
    dir: string,
    index: number,
  ) => FakeOpenAIResponse;
}

interface Run {
  requests: unknown[];
  records: unknown[];
  /** The screen after the last prompt. */
  screen: string;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function until(
  check: () => boolean | Promise<boolean>,
  reason: string,
  timeout = 30_000,
) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(reason);
    await sleep(100);
  }
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

const RANDOM_ID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// Fields that differ between two runs of the same scenario.
const VOLATILE_KEYS = new Set([
  'uuid',
  'parentUuid',
  'sessionId',
  'timestamp',
  'cwd',
  'version',
  'gitBranch',
  'durationMs',
  'duration_ms',
  'apiTimeMs',
  'startedAt',
  'endedAt',
  'event.timestamp',
]);

// Timings, such as the telemetry recorded with each response.
const TIMING_KEY = /(_ms|Ms)$/;

const DATE_REMINDER = '<system-reminder>\nThe current date is:';

const toolResults = (messages: JsonObject[]) =>
  messages.filter((message) => message['role'] === 'tool').length;

const userTurns = (messages: JsonObject[]) =>
  messages.filter(
    (message) =>
      message['role'] === 'user' &&
      !JSON.stringify(message['content']).includes('<system-reminder>'),
  ).length;

const isDateReminder = (part: unknown) =>
  typeof (part as JsonObject)?.['text'] === 'string' &&
  ((part as JsonObject)['text'] as string).startsWith(DATE_REMINDER);

function normalize(value: unknown, dir: string): unknown {
  const replaced = JSON.parse(
    JSON.stringify(value ?? null)
      .split(dir)
      .join('<DIR>')
      .replace(RANDOM_ID, '<ID>'),
  );
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as JsonObject)
          .filter(([key]) => !VOLATILE_KEYS.has(key) && !TIMING_KEY.test(key))
          .map(([key, child]) => [key, strip(child)]),
      );
    }
    return node;
  };
  return strip(replaced);
}

function modelRequests(server: FakeOpenAIServer, dir: string): unknown[] {
  return server.requests
    .filter((request) => request.body['stream'] === true)
    .map((request) =>
      ((request.body['messages'] ?? []) as JsonObject[])
        .filter((message) => message['role'] !== 'system')
        .map((message) => ({
          role: message['role'],
          content: Array.isArray(message['content'])
            ? message['content'].filter((part) => !isDateReminder(part))
            : message['content'],
          tool_calls: message['tool_calls'],
          tool_call_id: message['tool_call_id'],
        }))
        .filter(
          (message) =>
            !Array.isArray(message.content) || message.content.length > 0,
        )
        .map((message) => normalize(message, dir)),
    );
}

/** The session's chat records: what was said, run and reported, in order. */
function sessionRecords(runtimeDir: string, dir: string): unknown[] {
  return files(runtimeDir)
    .filter((file) => file.endsWith('.jsonl') && file.includes('chats'))
    .flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JsonObject),
    )
    .map((record) =>
      normalize(
        {
          type: record['type'],
          subtype: record['subtype'],
          message: record['message'],
          toolCallResult: record['toolCallResult'],
          systemPayload: record['systemPayload'],
        },
        dir,
      ),
    );
}

const hooks = (event: string, script: string) => ({
  [event]: [
    {
      matcher: '*',
      hooks: [{ type: 'command', command: `node ${script}` }],
    },
  ],
});

const describeInk =
  IS_CONTAINER_SANDBOX || pickE2eRenderer() !== 'ink'
    ? describe.skip
    : describe;

describeInk('Ink TUI agent loop parity (experimental.unifiedAgentLoop)', () => {
  let server: FakeOpenAIServer | undefined;
  let session: InteractiveSession | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    await server?.close();
    server = undefined;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  async function run(scenario: Scenario, shared: boolean): Promise<Run> {
    await session?.close();
    await server?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = mkdtempSync(join(tmpdir(), 'qwen-ink-agent-loop-parity-'));
    const workspace = join(scratch, 'workspace');
    const home = join(scratch, 'home');
    const runtimeDir = join(scratch, 'runtime');
    for (const directory of [workspace, home, runtimeDir])
      mkdirSync(directory, { recursive: true });
    for (const [file, content] of Object.entries(scenario.files ?? {}))
      writeFileSync(join(workspace, file), content);
    const json = (file: string, value: unknown) =>
      writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
    json(join(home, 'settings.json'), {
      $version: 4,
      ...scenario.settings,
      security: {
        auth: { selectedType: 'openai' },
        folderTrust: { enabled: false },
      },
      general: {
        enableAutoUpdate: false,
        showSessionRecap: false,
        chatRecording: true,
      },
      ui: { enableFollowupSuggestions: false },
      memory: E2E_MEMORY_SETTINGS_DEFAULTS,
      experimental: { mods: false },
    });
    for (const file of ['system.json', 'defaults.json'])
      json(join(scratch, file), { $version: 4 });

    let streamingIndex = 0;
    server = await startFakeOpenAIServer(({ body }) =>
      body['stream'] === true
        ? scenario.reply(
            (body['messages'] ?? []) as JsonObject[],
            workspace,
            streamingIndex++,
          )
        : { content: '{"selected_memories":[]}' },
    );
    session = await InteractiveSession.start({
      cwd: workspace,
      cols: 100,
      rows: 50,
      inheritEnv: false,
      env: {
        PATH: process.env['PATH'],
        HOME: scratch,
        QWEN_HOME: home,
        QWEN_RUNTIME_DIR: runtimeDir,
        QWEN_CODE_SYSTEM_SETTINGS_PATH: join(scratch, 'system.json'),
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: join(scratch, 'defaults.json'),
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        QWEN_CODE_LANG: 'en',
        QWEN_SANDBOX: 'false',
        QWEN_CODE_DISABLE_CRON: '1',
        QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
        QWEN_CODE_MODELS_DEV_REFRESH: 'off',
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1',
        ...(shared ? { QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP: '1' } : {}),
      },
      args: [
        '--auth-type',
        'openai',
        '--openai-api-key',
        'fake-key',
        '--openai-base-url',
        server.baseUrl,
        '--model',
        'fake-model',
        '--approval-mode',
        'yolo',
      ],
    });
    await until(
      async () => !(await session!.viewport()).includes('Initializing...'),
      'initialization completes',
    );
    await session.idle(300, 5_000);

    for (const prompt of scenario.prompts) {
      await session.send(prompt);
      // A turn is over once the spinner stops and no request is in flight.
      await sleep(500);
      await session.idle(2_000, 90_000);
      await until(
        () =>
          server!.requests.every(
            (request) => request.transport.closedAt !== undefined,
          ),
        'model requests complete',
      );
      await session.idle(1_000, 30_000);
    }

    const screen = await session.screen();
    await session.send('/quit');
    await until(
      () => session!.exitResult() !== undefined,
      '/quit exits the TUI',
    );
    return {
      requests: modelRequests(server, workspace),
      records: sessionRecords(runtimeDir, workspace),
      screen,
    };
  }

  const read = (file: string, id: string) =>
    fakeToolCall('read_file', { file_path: file }, id);

  const scenarios: Scenario[] = [
    {
      name: 'plain text',
      prompts: ['Say hello.'],
      reply: () => ({ content: 'Hello there.' }),
    },
    {
      name: 'streamed text and a thought',
      prompts: ['Think, then answer.'],
      reply: () => ({
        reasoningChunks: ['Weighing ', 'the options.'],
        contentChunks: ['Hel', 'lo ', 'there.'],
        usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 },
      }),
    },
    {
      name: 'one tool',
      prompts: ['Read the readme.'],
      files: { 'readme.txt': 'readme body\n' },
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? { toolCalls: [read(join(dir, 'readme.txt'), 'call_read')] }
          : { content: 'It says readme body.' },
    },
    {
      name: 'two reads in one response',
      prompts: ['Read both files.'],
      files: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' },
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
      name: 'an edit cut off by the output limit',
      prompts: ['Write the notes.'],
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
      name: 'a stream that drops and is retried',
      prompts: ['Tell me a story.'],
      reply: (_messages, _dir, index) =>
        index === 0
          ? {
              contentChunks: ['Once ', 'upon'],
              disconnectAfterContentChunks: 1,
            }
          : { contentChunks: ['Once ', 'upon a time.'] },
    },
    {
      name: 'two prompts in one session',
      prompts: ['First question.', 'Second question.'],
      reply: (messages) => ({ content: `Answer ${userTurns(messages)}.` }),
    },
    {
      name: 'a model error',
      prompts: ['Fail please.'],
      reply: () => ({ errorContent: 'upstream exploded' }),
    },
    {
      name: 'a UserPromptSubmit hook that blocks',
      prompts: ['Do the blocked thing.'],
      settings: { hooks: hooks('UserPromptSubmit', 'block-prompt.mjs') },
      files: {
        'block-prompt.mjs':
          "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'not today' }));\n",
      },
      shows: 'not today',
      reply: () => ({ content: 'Should not be asked.' }),
    },
    {
      name: 'a Stop hook that blocks once',
      prompts: ['Answer, then keep going once.'],
      settings: { hooks: hooks('Stop', 'stop-once.mjs') },
      files: {
        'stop-once.mjs': [
          "import { existsSync, writeFileSync } from 'node:fs';",
          "const marker = 'stop-hook-fired';",
          'if (existsSync(marker)) process.stdout.write("{}");',
          'else {',
          "  writeFileSync(marker, '');",
          "  process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Add a closing line.' }));",
          '}',
          '',
        ].join('\n'),
      },
      reply: (messages) => ({ content: `Reply ${userTurns(messages)}.` }),
    },
  ];

  it.each(scenarios)(
    '$name',
    async (scenario) => {
      const current = await run(scenario, false);
      const shared = await run(scenario, true);
      if (scenario.shows) {
        expect(current.screen).toContain(scenario.shows);
        expect(shared.screen).toContain(scenario.shows);
      } else {
        expect(current.records.length).toBeGreaterThan(0);
      }
      expect(shared.requests).toEqual(current.requests);
      expect(shared.records).toEqual(current.records);
    },
    240_000,
  );
});
