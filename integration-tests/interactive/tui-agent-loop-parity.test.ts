/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The TUI that `QWEN_E2E_RENDERER` selects, Ink or OpenTUI, runs each
 * scripted scenario twice, with
 * `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP` unset and set, and the two runs must
 * send the model the same requests and record the same session. The screen is
 * not compared: it repaints on timers, and what it shows comes from the same
 * events the session records.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
  /** The approval mode; YOLO by default. */
  approvalMode?: 'default';
  /** Answers each tool approval the prompt asks for, in order. */
  approvals?: Array<'allow' | 'deny'>;
  /** Presses Esc once this text is on screen. */
  cancelOn?: string;
  /** Disconnects the first response once this text is visible. */
  disconnectOn?: string;
  /** Submits `input` once `on` is on screen, while the turn runs. */
  queue?: { on: string; input: string };
  /** Presses Ctrl+Y this many times after the prompt, each after a turn. */
  retries?: number;
  /**
   * Wait for turns started by the session after the prompts, such as Goal
   * continuations, background notifications, cron fires and teammate reports.
   * These scenarios run only on Ink and wait until all `requests` are sent.
   */
  laterTurns?: boolean;
  /** Environment for the TUI, over the suite's. */
  env?: Record<string, string>;
  /**
   * The reply to a request that does not stream, such as a Goal check;
   * `undefined` leaves it to the suite's.
   */
  sideReply?: (body: JsonObject) => FakeOpenAIResponse | undefined;
  /** The requests that do not stream each run must send, when checked. */
  sideRequests?: number;
  /** What else differs per run in this scenario. */
  volatile?: Volatile;
  /**
   * For requests from more than one agent, whose order across agents varies
   * from run to run: which agent sent a request. Each agent's requests are
   * compared in the order it sent them.
   */
  agent?: (messages: JsonObject[]) => string;
  /** The model requests each run must send, retries included. */
  requests: number;
  /**
   * The model rounds the TUI sends; a retry or a Stop-hook continuation runs
   * inside its round.
   */
  rounds: number;
  /** The tool batches the TUI runs, one per round that calls tools. */
  batches: number;
  /**
   * Text both runs must show at the end, for a scenario that sends and
   * records nothing.
   */
  shows?: string;
  /** Text both runs' session records must contain. */
  recorded?: string;
  /** Text both runs' model requests must contain. */
  sent?: string;
  /**
   * The model's reply to a streaming request, from its message history;
   * `index` counts this run's streaming requests, retries included.
   */
  reply: (
    messages: JsonObject[],
    dir: string,
    index: number,
  ) => FakeOpenAIResponse | Promise<FakeOpenAIResponse>;
}

interface Volatile {
  /** Fields to leave out. */
  keys?: string[];
  /** Text to replace, applied to the JSON text. */
  text?: Array<[RegExp, string]>;
}

interface Run {
  requests: unknown[];
  /** The requests that do not stream, such as a Goal check. */
  sideRequests: unknown[];
  records: unknown[];
  /** The screen after the last prompt. */
  screen: string;
  /** How many model rounds the debug log says ran on the shared loop. */
  sharedRounds: number;
  /** How many tool batches the debug log says ran on the shared loop. */
  sharedBatches: number;
}

/**
 * The root config's `retry: 2` would rerun both TUI sessions after a stall,
 * tripling its cost in the required gate.
 */
const PARITY_CASE_OPTIONS = { retry: 0, timeout: 240_000 };

/** What the TUI logs for each model round it sends on the shared loop. */
const SHARED_ROUND_LOG = 'model round on the shared agent loop';
/** The first option of a tool approval. */
const APPROVAL_PROMPT = 'Yes, allow once';

/** What the TUI logs for each tool batch it runs on the shared loop. */
const SHARED_BATCH_LOG = 'tool batch on the shared agent loop';

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
  // When a write backed up the file it replaced.
  'backupTime',
  // A shell command's process.
  'pid',
]);

// Timings, such as the telemetry recorded with each response.
const TIMING_KEY = /(_ms|Ms)$/;

const DATE_REMINDER =
  /^<system-reminder>\n(?:Today's date is |The date has changed since earlier in this conversation\. )/;

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
  DATE_REMINDER.test((part as JsonObject)['text'] as string);

/**
 * `dir` is the workspace; `scratch`, which holds it, is the run's home;
 * `volatile`, what else differs per run in the scenario.
 */
function normalize(
  value: unknown,
  dir: string,
  scratch: string,
  volatile: Volatile = {},
): unknown {
  const replaced = JSON.parse(
    (volatile.text ?? []).reduce(
      (text, [pattern, replacement]) => text.replace(pattern, replacement),
      JSON.stringify(value ?? null)
        .split(dir)
        .join('<DIR>')
        .split(scratch)
        .join('<SCRATCH>')
        .replace(RANDOM_ID, '<ID>')
        // A shell command's result names its process group.
        .replace(/Process Group PGID: \d+/g, 'Process Group PGID: <PGID>'),
    ),
  );
  const keys = new Set(volatile.keys);
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as JsonObject)
          .filter(
            ([key]) =>
              !VOLATILE_KEYS.has(key) &&
              !keys.has(key) &&
              !TIMING_KEY.test(key),
          )
          .map(([key, child]) => [key, strip(child)]),
      );
    }
    return node;
  };
  return strip(replaced);
}

/**
 * Each request body as the client sent it, without the date reminder: every
 * message field, `reasoning_content` included, the tools offered and the
 * sampling options. `stream` picks the model's rounds or the side requests,
 * such as a Goal check.
 */
function modelRequests(
  server: FakeOpenAIServer,
  dir: string,
  scratch: string,
  scenario: Scenario,
  stream = true,
): unknown[] {
  const sent = server.requests.filter(
    (request) => (request.body['stream'] === true) === stream,
  );
  const agentOf = (request: (typeof sent)[number]) =>
    scenario.agent?.((request.body['messages'] ?? []) as JsonObject[]) ?? '';
  const agents = [...new Set(sent.map(agentOf))].sort();
  return agents
    .flatMap((name) => sent.filter((request) => agentOf(request) === name))
    .map((request) =>
      normalize(
        {
          ...request.body,
          messages: ((request.body['messages'] ?? []) as JsonObject[])
            .map((message) => ({
              ...message,
              content: Array.isArray(message['content'])
                ? message['content'].filter((part) => !isDateReminder(part))
                : message['content'],
            }))
            .filter(
              (message) =>
                !Array.isArray(message.content) || message.content.length > 0,
            ),
        },
        dir,
        scratch,
        scenario.volatile,
      ),
    );
}

/** The session's chat records: what was said, run and reported, in order. */
function sessionRecords(
  runtimeDir: string,
  dir: string,
  scratch: string,
  volatile?: Volatile,
): unknown[] {
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
          usageMetadata: record['usageMetadata'],
          model: record['model'],
          contextWindowSize: record['contextWindowSize'],
        },
        dir,
        scratch,
        volatile,
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

const renderer = pickE2eRenderer();
const describeTui = IS_CONTAINER_SANDBOX ? describe.skip : describe;
const SUITE = `${renderer === 'ink' ? 'Ink' : 'OpenTUI'} TUI agent loop parity (experimental.unifiedAgentLoop)`;
/** Ink runs its tool batches on the shared loop; OpenTUI does not yet. */
const sharesToolBatches = renderer === 'ink';

describeTui(SUITE, () => {
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
    scratch = mkdtempSync(join(tmpdir(), 'qwen-tui-agent-loop-parity-'));
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

    const { disconnectOn } = scenario;
    const firstChunkRead = deferred();
    let streamingIndex = 0;
    server = await startFakeOpenAIServer(async ({ body }) => {
      if (body['stream'] !== true) {
        return (
          scenario.sideReply?.(body) ?? {
            content: '{"selected_memories":[]}',
          }
        );
      }
      const index = streamingIndex++;
      const response = await scenario.reply(
        (body['messages'] ?? []) as JsonObject[],
        workspace,
        index,
      );
      if (index === 0 && disconnectOn) {
        return {
          ...response,
          holdAfterChunks: 1,
          holdUntil: firstChunkRead.promise,
          disconnectAfterContentChunks: 2,
        };
      }
      return response;
    });
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
        QWEN_DEBUG_LOG_FILE: '1',
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1',
        ...scenario.env,
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
        scenario.approvalMode ?? 'yolo',
      ],
    });
    await until(
      async () => !(await session!.viewport()).includes('Initializing...'),
      'initialization completes',
    );
    await session.idle(300, 5_000);

    // A turn is over once the spinner stops and no request is in flight.
    const turnEnds = async () => {
      await sleep(500);
      await session!.idle(2_000, 90_000);
      await until(
        () =>
          server!.requests.every(
            (request) => request.transport.closedAt !== undefined,
          ),
        'model requests complete',
      );
      await session!.idle(1_000, 30_000);
    };

    for (const [index, prompt] of scenario.prompts.entries()) {
      await session.send(prompt);
      if (index === 0 && disconnectOn) {
        try {
          await until(
            async () => (await session!.viewport()).includes(disconnectOn),
            'the first response chunk is visible',
          );
        } finally {
          firstChunkRead.resolve();
        }
      }
      for (const answer of scenario.approvals ?? []) {
        // The viewport, not the whole output, which still holds the
        // previous approval.
        await until(
          async () => (await session!.viewport()).includes(APPROVAL_PROMPT),
          'the approval opens',
        );
        await session.idle(500, 10_000);
        session.pressKey(answer === 'allow' ? '\r' : '\x1b');
        await until(
          async () => !(await session!.viewport()).includes(APPROVAL_PROMPT),
          'the approval closes',
        );
      }
      if (scenario.cancelOn) {
        await until(
          async () => (await session!.viewport()).includes(scenario.cancelOn!),
          'the tool starts',
        );
        // Let the tool start before Esc reaches it.
        await sleep(1_500);
        session.pressKey('\x1b');
      }
      if (scenario.queue) {
        await until(
          async () => (await session!.viewport()).includes(scenario.queue!.on),
          'the tool starts',
        );
        await sleep(1_000);
        await session.send(scenario.queue.input);
      }
      await turnEnds();
      for (let retry = 0; retry < (scenario.retries ?? 0); retry++) {
        session.pressKey('\x19');
        await turnEnds();
      }
    }
    if (scenario.laterTurns) {
      await until(
        () =>
          server!.requests.filter((request) => request.body['stream'] === true)
            .length >= scenario.requests,
        'the session starts its later turns',
        90_000,
      );
      await turnEnds();
    }

    const screen = await session.screen();
    await session.send('/quit');
    await until(
      () => session!.exitResult() !== undefined,
      '/quit exits the TUI',
    );
    const debugDir = join(runtimeDir, 'debug');
    const debugLog = existsSync(debugDir)
      ? files(debugDir)
          // `latest` points at the session's own log.
          .filter((file) => basename(file) !== 'latest')
          .map((file) => readFileSync(file, 'utf8'))
          .join('')
      : '';
    return {
      requests: modelRequests(server, workspace, scratch, scenario),
      sideRequests: modelRequests(server, workspace, scratch, scenario, false),
      records: sessionRecords(
        runtimeDir,
        workspace,
        scratch,
        scenario.volatile,
      ),
      screen,
      sharedRounds: debugLog.split(SHARED_ROUND_LOG).length - 1,
      sharedBatches: debugLog.split(SHARED_BATCH_LOG).length - 1,
    };
  }

  const read = (file: string, id: string) =>
    fakeToolCall('read_file', { file_path: file }, id);
  const write = (file: string, content: string, id: string) =>
    fakeToolCall('write_file', { file_path: file, content }, id);

  // The teammate scenario's helper, told apart by its task, which only the
  // helper's user messages carry; the leader's carry it inside its tool call.
  const HELPER_TASK = 'HELPER TASK:';
  const isHelper = (messages: JsonObject[]) =>
    messages.some(
      (message) =>
        message['role'] === 'user' &&
        JSON.stringify(message['content']).includes(HELPER_TASK),
    );
  // The Goal scenario's check, told apart by its system prompt.
  const isGoalCheck = (body: JsonObject) =>
    JSON.stringify(
      ((body['messages'] ?? []) as JsonObject[])[0]?.['content'],
    ).includes('Goal Verifier');
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  };
  let leaderWaiting = deferred();
  const retryPrefix = 'A clockwork fox ';

  const allScenarios: Scenario[] = [
    {
      name: 'plain text',
      requests: 1,
      rounds: 1,
      batches: 0,
      prompts: ['Say hello.'],
      reply: () => ({ content: 'Hello there.' }),
    },
    {
      name: 'streamed text and a thought',
      requests: 1,
      rounds: 1,
      batches: 0,
      prompts: ['Think, then answer.'],
      reply: () => ({
        reasoningChunks: ['Weighing ', 'the options.'],
        contentChunks: ['Hel', 'lo ', 'there.'],
        usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 },
      }),
      recorded: '"totalTokenCount":49',
    },
    {
      // The second request replays the assistant turn that carried the
      // reasoning, so its `reasoning_content` is compared.
      name: 'a thought before a tool',
      requests: 2,
      rounds: 2,
      batches: 1,
      prompts: ['Think, then read the readme.'],
      files: { 'readme.txt': 'readme body\n' },
      sent: '"reasoning_content":"Deciding to read."',
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? {
              reasoningChunks: ['Deciding ', 'to read.'],
              toolCalls: [read(join(dir, 'readme.txt'), 'call_think_read')],
            }
          : { content: 'It says readme body.' },
    },
    {
      name: 'one tool',
      requests: 2,
      rounds: 2,
      batches: 1,
      prompts: ['Read the readme.'],
      files: { 'readme.txt': 'readme body\n' },
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? { toolCalls: [read(join(dir, 'readme.txt'), 'call_read')] }
          : { content: 'It says readme body.' },
    },
    {
      name: 'two reads in one response',
      requests: 2,
      rounds: 2,
      batches: 1,
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
      // The second response repeats the first call's provider id and
      // arguments next to a fresh call, so the batch answers the replay.
      name: 'a replayed call next to a fresh one',
      requests: 3,
      rounds: 3,
      batches: 2,
      prompts: ['Read a, then b.'],
      files: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' },
      reply: (messages, dir) => {
        const done = toolResults(messages);
        if (done === 0)
          return { toolCalls: [read(join(dir, 'a.txt'), 'call_replayed')] };
        if (done === 1)
          return {
            toolCalls: [
              read(join(dir, 'a.txt'), 'call_replayed'),
              read(join(dir, 'b.txt'), 'call_fresh'),
            ],
          };
        return { content: 'Both read.' };
      },
    },
    {
      // Declining the second approval cancels its call and ends the turn.
      name: 'an approved write, then a declined one',
      requests: 2,
      rounds: 2,
      batches: 2,
      approvalMode: 'default',
      approvals: ['allow', 'deny'],
      prompts: ['Write a, then b.'],
      recorded: 'a body',
      reply: (messages, dir) =>
        toolResults(messages) === 0
          ? { toolCalls: [write(join(dir, 'a.txt'), 'a body\n', 'call_a')] }
          : toolResults(messages) === 1
            ? {
                toolCalls: [write(join(dir, 'b.txt'), 'b body\n', 'call_b')],
              }
            : { content: 'Should not be asked.' },
    },
    {
      // Esc while the command runs cancels it and ends the turn.
      name: 'a shell command cancelled while it runs',
      requests: 1,
      rounds: 1,
      batches: 1,
      cancelOn: 'waiting-for-esc',
      prompts: ['Run the slow command.'],
      reply: () => ({
        toolCalls: [
          fakeToolCall(
            'run_shell_command',
            {
              command:
                'echo waiting-for-esc && node -e "setTimeout(() => {}, 60000)"',
              is_background: false,
            },
            'call_slow',
          ),
        ],
      }),
    },
    {
      name: 'an edit cut off by the output limit',
      // The client asks again for the cut-off call inside its round.
      requests: 3,
      rounds: 2,
      batches: 1,
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
      sent: 'The connection dropped mid-response.',
      requests: 2,
      rounds: 1,
      batches: 0,
      prompts: ['Tell me a story.'],
      disconnectOn: retryPrefix.trimEnd(),
      reply: (_messages, _dir, index) =>
        index === 0
          ? { contentChunks: [retryPrefix, ''] }
          : { contentChunks: [retryPrefix, 'followed the moon.'] },
    },
    {
      name: 'two prompts in one session',
      requests: 2,
      rounds: 2,
      batches: 0,
      prompts: ['First question.', 'Second question.'],
      reply: (messages) => ({ content: `Answer ${userTurns(messages)}.` }),
    },
    {
      name: 'a model error',
      requests: 1,
      rounds: 1,
      batches: 0,
      prompts: ['Fail please.'],
      reply: () => ({ errorContent: 'upstream exploded' }),
    },
    {
      name: 'a retry after a model error',
      requests: 2,
      rounds: 2,
      batches: 0,
      prompts: ['Fail once.'],
      retries: 1,
      recorded: 'Recovered.',
      reply: (_messages, _dir, index) =>
        index === 0
          ? { errorContent: 'upstream exploded' }
          : { content: 'Recovered.' },
    },
    {
      name: 'a retry that fails again',
      requests: 3,
      rounds: 3,
      batches: 0,
      prompts: ['Fail twice.'],
      retries: 2,
      recorded: 'Recovered.',
      reply: (_messages, _dir, index) =>
        index < 2
          ? { errorContent: 'upstream exploded' }
          : { content: 'Recovered.' },
    },
    {
      // The retried tool-result round calls another tool, whose batch the
      // retry's turn runs and continues.
      name: 'a retried tool-result round that calls a tool',
      requests: 4,
      rounds: 4,
      batches: 2,
      prompts: ['Read both files.'],
      files: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' },
      retries: 1,
      recorded: 'Both read.',
      reply: (_messages, dir, index) =>
        index === 0
          ? { toolCalls: [read(join(dir, 'a.txt'), 'call_a')] }
          : index === 1
            ? { errorContent: 'upstream exploded' }
            : index === 2
              ? { toolCalls: [read(join(dir, 'b.txt'), 'call_b')] }
              : { content: 'Both read.' },
    },
    {
      // Input submitted while a tool runs goes out with its result.
      name: 'input queued while a tool runs',
      requests: 2,
      rounds: 2,
      batches: 1,
      prompts: ['Run the slow command.'],
      queue: { on: 'queue-now', input: 'Also mention the weather.' },
      sent: 'Also mention the weather.',
      reply: (messages) =>
        toolResults(messages) === 0
          ? {
              toolCalls: [
                fakeToolCall(
                  'run_shell_command',
                  {
                    command:
                      'echo queue-now && node -e "setTimeout(() => {}, 5000)"',
                    is_background: false,
                  },
                  'call_slow',
                ),
              ],
            }
          : { content: 'Done, and it is sunny.' },
    },
    {
      // The first continuation stops on its own; the second reads the
      // forecast and then proposes that the Goal is complete, which the
      // check accepts.
      name: 'a Goal its second continuation completes',
      recorded: 'verifier_accept',
      requests: 3,
      rounds: 3,
      batches: 2,
      prompts: ['/goal Report the weather.'],
      files: { 'forecast.txt': 'sunny\n' },
      laterTurns: true,
      reply: (_messages, dir, index) =>
        index === 0
          ? { content: 'Checking the forecast.' }
          : index === 1
            ? { toolCalls: [read(join(dir, 'forecast.txt'), 'call_read')] }
            : {
                toolCalls: [
                  fakeToolCall(
                    'update_goal',
                    { status: 'complete', reason: 'The forecast is sunny.' },
                    'call_goal',
                  ),
                ],
              },
      sideRequests: 1,
      sideReply: (body) =>
        isGoalCheck(body)
          ? {
              content:
                '{"decision":"accept","reason":"The forecast was given."}',
            }
          : undefined,
      // When the Goal was set and last changed.
      volatile: { keys: ['createdAt', 'updatedAt'] },
    },
    {
      // The job outlasts the prompt, so its result starts a turn of its own,
      // which reads the job's log.
      name: 'a background shell whose result starts a notification turn',
      sent: '<task-notification>',
      requests: 4,
      rounds: 4,
      batches: 2,
      prompts: ['Run the job in the background.'],
      files: { 'job.log': 'job log\n' },
      laterTurns: true,
      recorded: 'The job is done.',
      // The job's task id, its process and the project's runtime directory,
      // named by a hash of the workspace path.
      volatile: {
        text: [
          [/\bbg_[0-9a-f]{8}\b/g, 'bg_<ID>'],
          [/(pid: |pid |<pid>)\d+/g, '$1<PID>'],
          [/\/tmp\/[0-9a-f]{64}\//g, '/tmp/<HASH>/'],
        ],
      },
      reply: (_messages, dir, index) =>
        index === 0
          ? {
              toolCalls: [
                fakeToolCall(
                  'run_shell_command',
                  {
                    command: 'sleep 3; echo job done',
                    description: 'Run the job',
                    is_background: true,
                  },
                  'call_job',
                ),
              ],
            }
          : index === 1
            ? { content: 'The job is running.' }
            : index === 2
              ? { toolCalls: [read(join(dir, 'job.log'), 'call_log')] }
              : { content: 'The job is done.' },
    },
    {
      // The job fires once, soon after the prompt, and its turn reads a file.
      // A fire during the prompt's turn waits for it to end, as any
      // notification does.
      name: 'a cron job whose turn reads a file',
      // The fired prompt as a user message; the model's own call carries it
      // only as escaped arguments.
      sent: '"text":"Read the readme."',
      requests: 4,
      rounds: 4,
      batches: 2,
      prompts: ['Remind me to read the readme.'],
      files: { 'readme.txt': 'readme body\n' },
      env: {
        QWEN_CODE_DISABLE_CRON: '0',
        QWEN_CODE_TEST_CRON_FAST: '1',
        QWEN_CODE_TEST_CRON_DELAY_MS: '1000',
      },
      laterTurns: true,
      recorded: 'It says readme body.',
      // The job's id.
      volatile: {
        text: [
          [/(Scheduled (?:one-shot task )?)[0-9a-z]{8}(?= \()/g, '$1<CRON>'],
        ],
      },
      reply: (_messages, dir, index) =>
        index === 0
          ? {
              toolCalls: [
                fakeToolCall(
                  'cron_create',
                  {
                    cron: '0 0 1 1 *',
                    prompt: 'Read the readme.',
                    recurring: false,
                  },
                  'call_cron',
                ),
              ],
            }
          : index === 1
            ? { content: 'Scheduled.' }
            : index === 2
              ? { toolCalls: [read(join(dir, 'readme.txt'), 'call_read')] }
              : { content: 'It says readme body.' },
    },
    {
      // A teammate's final answer reaches the leader once its turn ended,
      // and starts a teammate turn, which reads a file.
      name: 'a teammate report that starts a teammate turn',
      sent: '<teammate_message',
      requests: 6,
      rounds: 5,
      batches: 3,
      prompts: ['Ask a helper to check the weather.'],
      files: { 'weather.txt': 'sunny\n' },
      env: { QWEN_CODE_ENABLE_AGENT_TEAM: '1' },
      laterTurns: true,
      agent: (messages) => (isHelper(messages) ? 'helper' : 'leader'),
      recorded: 'The helper says it is sunny.',
      reply: (messages, dir) => {
        if (isHelper(messages)) {
          // The helper answers once the leader sent its last round, past the
          // tool boundary that would take the report: that round calls no
          // tool, so the report waits for the leader's turn to end and starts
          // a turn of its own on both runs.
          return leaderWaiting.promise.then(() => ({
            content: 'HELPER REPORT: it is sunny.',
          }));
        }
        if (JSON.stringify(messages).includes('HELPER REPORT'))
          return toolResults(messages) === 2
            ? { toolCalls: [read(join(dir, 'weather.txt'), 'call_read')] }
            : { content: 'The helper says it is sunny.' };
        switch (toolResults(messages)) {
          case 0:
            leaderWaiting = deferred();
            return {
              toolCalls: [
                fakeToolCall('team_create', { team_name: 'crew' }, 'call_team'),
              ],
            };
          case 1:
            return {
              toolCalls: [
                fakeToolCall(
                  'agent',
                  {
                    name: 'helper',
                    subagent_type: 'general-purpose',
                    description: 'Check the weather',
                    prompt: `${HELPER_TASK} Check the weather.`,
                  },
                  'call_helper',
                ),
              ],
            };
          default:
            leaderWaiting.resolve();
            return { content: 'Waiting for the helper.' };
        }
      },
    },
    {
      name: 'a UserPromptSubmit hook that blocks',
      requests: 0,
      rounds: 1,
      batches: 0,
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
      requests: 2,
      rounds: 1,
      batches: 0,
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

  // OpenTUI does not start turns of its own yet: no Goal continuation,
  // background notification, cron or teammate turn.
  const scenarios = allScenarios.filter(
    (scenario) => renderer === 'ink' || !scenario.laterTurns,
  );

  it.each(scenarios)('$name', PARITY_CASE_OPTIONS, async (scenario) => {
    const current = await run(scenario, false);
    const shared = await run(scenario, true);
    // Only the run with the setting on sends its rounds on the shared loop.
    expect(current.sharedRounds).toBe(0);
    expect(shared.sharedRounds).toBe(scenario.rounds);
    expect(current.sharedBatches).toBe(0);
    expect(shared.sharedBatches).toBe(sharesToolBatches ? scenario.batches : 0);
    for (const run of [current, shared]) {
      expect(run.requests).toHaveLength(scenario.requests);
      if (scenario.sideRequests !== undefined)
        expect(run.sideRequests).toHaveLength(scenario.sideRequests);
      if (scenario.shows) expect(run.screen).toContain(scenario.shows);
      else expect(run.records.length).toBeGreaterThan(0);
      if (scenario.recorded)
        expect(JSON.stringify(run.records)).toContain(scenario.recorded);
      if (scenario.sent)
        expect(JSON.stringify(run.requests)).toContain(scenario.sent);
    }
    expect(shared.requests).toEqual(current.requests);
    expect(shared.sideRequests).toEqual(current.sideRequests);
    expect(shared.records).toEqual(current.records);
  });
});
