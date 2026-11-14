/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The TUI that `QWEN_E2E_RENDERER` selects, Ink or OpenTUI, runs each
 * scripted scenario twice, with `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP` forced
 * to `0` and to `1` per arm, and the two runs must send the model the same
 * requests and record the same session. Each scenario runs a third time with
 * `QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP` set as well, which must match the
 * run on the shared loop. Every arm pins the switches explicitly because the
 * nightly legs export them and InteractiveSession forwards them into the
 * isolated child env. Scenarios with an expected screen message check for it
 * in each run. Full screens repaint on timers and are not compared.
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
  approvals?: Array<{
    answer: 'allow' | 'deny';
    /**
     * Evidence the answer took effect, in place of watching the dialog
     * close: a renderer that paints the close and the next approval's
     * entrance in one frame never shows the gap between them.
     */
    settled?: (workspace: string) => boolean;
  }>;
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
  /** The tool batches its subagents run. */
  subagentBatches?: number;
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
   * An intended difference on OpenTUI, listed in the design doc: text only
   * the run with the setting on sends, in place of comparing the runs.
   */
  openTuiSends?: string;
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
  /** How many subagent tool batches the debug log says ran on it. */
  sharedSubagentBatches: number;
  /** How many model rounds the debug log says ran on the event-bus kernel. */
  kernelRounds: number;
}

/**
 * The root config's `retry: 2` would rerun both TUI sessions after a stall,
 * tripling its cost in the required gate.
 */
const PARITY_CASE_OPTIONS = { retry: 0, timeout: 240_000 };

/** What the TUI logs for each model round it sends on the shared loop. */
const SHARED_ROUND_LOG = 'model round on the shared agent loop';
/**
 * Match the adapter's execution marker against the prompt IDs of the TUI's
 * own rounds; a subagent logs its rounds without "model round".
 */
function countKernelRounds(debugLog: string): number {
  const promptIds = new Set(
    Array.from(
      debugLog.matchAll(
        /model round on the shared agent loop \(prompt ([^)]+)\)/g,
      ),
      ([, promptId]) => promptId,
    ),
  );
  return Array.from(
    debugLog.matchAll(
      /\[EVENT_BUS\][^\n]* runAgentLoopOnBus started \S+ \(prompt ([^)]+)\)/g,
    ),
  ).filter(([, promptId]) => promptIds.has(promptId)).length;
}
/** The first option of a tool approval. */
const APPROVAL_PROMPT = 'Yes, allow once';

/** What the TUI logs for each tool batch it runs on the shared loop. */
const SHARED_BATCH_LOG = 'tool batch on the shared agent loop';
/** What a subagent logs for each tool batch it runs on the shared loop. */
const SHARED_SUBAGENT_BATCH_LOG =
  /subagent \S+ round \d+ tool batch on the shared loop/g;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function until(
  check: () => boolean | Promise<boolean>,
  reason: string,
  timeout = 30_000,
  context?: () => Promise<string>,
) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error(context ? `${reason}\n${await context()}` : reason);
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

// The startup context's date, in `formatDateForContext`'s format. Runs that
// straddle midnight render it a day apart.
const CONTEXT_DATE =
  /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b/g;

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

// The background shell scenario's launch text names its task id, its process,
// the project's runtime directory, and the sizes of that text. The sizes are
// the one piece normalize() cannot recover from the normalized text: the
// kernel picks the process id's width, which sets them. The token estimates
// are ceilings of the same lengths, so they step with it too.
const BACKGROUND_SHELL_VOLATILE: Volatile = {
  keys: [
    'content_length',
    'raw_content_length',
    'processed_estimated_tokens',
    'raw_estimated_tokens',
  ],
  text: [
    [/\bbg_[0-9a-f]{8}\b/g, 'bg_<ID>'],
    [/(pid: |pid |<pid>)\d+/g, '$1<PID>'],
    [/\/tmp\/[0-9a-f]{64}\//g, '/tmp/<HASH>/'],
  ],
};

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
        .replace(CONTEXT_DATE, '<DATE>')
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

describe('normalize', () => {
  const startupContext = (today: string) => ({
    messages: [
      {
        role: 'user',
        content: [
          {
            text: `<system-reminder>\nThis is the Qwen Code. We are setting up the context for our chat.\nToday's date is ${today}.\n</system-reminder>`,
          },
        ],
      },
    ],
  });

  it('normalizes the date the startup context renders', () => {
    expect(
      normalize(
        startupContext('Wednesday, November 11, 2026'),
        '/workspace',
        '/scratch',
      ),
    ).toEqual(
      normalize(
        startupContext('Thursday, November 12, 2026'),
        '/workspace',
        '/scratch',
      ),
    );
  });

  // The background shell's launch text names its process, whose width the
  // kernel picks, so the telemetry record's byte and token counts of that text
  // differ between the two parity runs even after the pid text is normalized.
  // The recorded failure sat where both ceilings coincide; a pid one digit
  // wider diverges only when the shorter text's length is a multiple of four.
  it('normalizes a byte count derived from a process id', () => {
    const launchText = (pid: number) =>
      'Background shell started.\n' +
      'id: bg_0123abcd\n' +
      `pid: ${pid}\n` +
      'output file: /tmp/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/bg_0123abcd.output\n' +
      'status file: /tmp/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/bg_0123abcd.status\n' +
      'To inspect: /tasks';
    const record = (pid: number, output = 'The job is done.') => {
      const text = launchText(pid);
      return {
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'tool_call',
            call_id: 'call_job',
            content_length: text.length,
            raw_content_length: text.length,
            raw_estimated_tokens: Math.ceil(text.length / 4),
            processed_estimated_tokens: Math.ceil((text.length + 64) / 4),
          },
        },
        message: {
          role: 'user',
          content: [
            {
              text:
                `<task-notification>\nBackground shell bg_0123abcd (pid ${pid}) completed.\n` +
                `${output}\n</task-notification>`,
            },
          ],
        },
      };
    };
    const launchRecord = (pid: number) => ({
      type: 'tool_result',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_job',
              name: 'run_shell_command',
              response: { output: launchText(pid) },
            },
          },
        ],
      },
    });
    const normalized = (pid: number, output?: string) =>
      normalize(
        [record(pid, output), launchRecord(pid)],
        '/workspace',
        '/scratch',
        BACKGROUND_SHELL_VOLATILE,
      );

    // Both ceilings step only when the shorter text is a multiple of four.
    expect(launchText(99).length % 4).toBe(0);
    expect(normalized(99)).toEqual(normalized(100));
    // The notification and the answer the scenario asserts still compare.
    const [message] = normalized(99) as Array<{
      message: { content: Array<{ text: string }> };
    }>;
    expect(message.message.content[0].text).toContain(
      'Background shell bg_<ID> (pid <PID>) completed.\nThe job is done.',
    );
    // The runtime directory stays a directory in the launch text's paths.
    expect(JSON.stringify(normalized(99))).toContain(
      '/tmp/<HASH>/bg_<ID>.output',
    );
    // A real content difference still compares unequal.
    expect(normalized(99)).not.toEqual(normalized(100, 'The job failed.'));
    // The counts stay comparable outside this scenario, where no launch text
    // derives them from a pid.
    const plain = normalize(record(99), '/workspace', '/scratch') as {
      systemPayload: { uiEvent: JsonObject };
    };
    expect(plain.systemPayload.uiEvent['content_length']).toBe(
      launchText(99).length,
    );
    expect(plain.systemPayload.uiEvent['raw_content_length']).toBe(
      launchText(99).length,
    );
    expect(plain.systemPayload.uiEvent['raw_estimated_tokens']).toBe(
      Math.ceil(launchText(99).length / 4),
    );
    expect(plain.systemPayload.uiEvent['processed_estimated_tokens']).toBe(
      Math.ceil((launchText(99).length + 64) / 4),
    );
  });
});

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

  async function run(
    scenario: Scenario,
    shared: boolean,
    kernel = false,
  ): Promise<Run> {
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
        // Force every arm explicitly: the nightly legs export these switches
        // and InteractiveSession forwards them into the isolated env, so the
        // control arm must pin them off rather than rely on an empty env.
        QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP: shared ? '1' : '0',
        QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP: kernel ? '1' : '0',
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
    // Both renderers load slash commands and skills asynchronously after the
    // prompt renders; probing `/` ensures both CommandService and input focus
    // are ready before the first prompt is typed (#16787, #17131). The signal
    // is the completion list's own `(<n>/<total>)` counter, which cannot show
    // early: the command list starts empty and is filled only once
    // CommandService.create resolves, and the counter is printed only while
    // that list holds more than MAX_SUGGESTIONS_TO_SHOW entries. Suggestion
    // labels carry no leading `/` (they read `status (about)`), so a command
    // name cannot be awaited as a literal.
    session.pressKey('/');
    await until(
      async () =>
        (await session!.viewport())
          .split('\n')
          .some((line) => /^\(\d+\/\d+\)$/.test(line.trim())),
      'slash commands load',
      30_000,
      () => session!.viewport(),
    );
    session.pressKey('\x7f');
    await until(
      async () => (await session!.viewport()).includes('Type your message'),
      'input clears',
      30_000,
      () => session!.viewport(),
    );
    await session.idle(300, 5_000);

    const streamingCount = () =>
      server!.requests.filter((request) => request.body['stream'] === true)
        .length;
    const sideCount = () =>
      server!.requests.filter((request) => request.body['stream'] !== true)
        .length;

    // A turn is over once its expected requests have completed and the
    // spinner stops (#16787, #16947, #17131).
    const turnEnds = async (minStreamingRequests: number) => {
      await sleep(500);
      if (scenario.shows) {
        await until(
          async () => (await session!.screen()).includes(scenario.shows!),
          'expected screen text',
          30_000,
          () => session!.viewport(),
        );
      }
      await until(
        () =>
          streamingCount() >= minStreamingRequests &&
          server!.requests.every(
            (request) => request.transport.closedAt !== undefined,
          ),
        'model requests complete',
        90_000,
        () => session!.viewport(),
      );
      await session!.idle(2_000, 90_000);
      await until(
        () =>
          server!.requests.every(
            (request) => request.transport.closedAt !== undefined,
          ),
        'model requests settle',
        30_000,
        () => session!.viewport(),
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
      for (const { answer, settled } of scenario.approvals ?? []) {
        // The viewport, not the whole output, which still holds the
        // previous approval.
        await until(
          async () => (await session!.viewport()).includes(APPROVAL_PROMPT),
          'the approval opens',
          30_000,
          () => session!.viewport(),
        );
        await session.idle(500, 10_000);
        session.pressKey(answer === 'allow' ? '\r' : '\x1b');
        await until(
          settled
            ? () => settled(workspace)
            : async () =>
                !(await session!.viewport()).includes(APPROVAL_PROMPT),
          'the approval closes',
          30_000,
          () => session!.viewport(),
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
      const expectedAfterPrompt =
        scenario.requests === 0
          ? 0
          : scenario.laterTurns || scenario.retries
            ? index + 1
            : index === scenario.prompts.length - 1
              ? scenario.requests
              : index + 1;
      await turnEnds(expectedAfterPrompt);
      for (let retry = 0; retry < (scenario.retries ?? 0); retry++) {
        await until(
          async () =>
            (await session!.viewport()).includes('Press Ctrl+Y to retry'),
          'the failed turn is ready to retry',
          30_000,
          () => session!.viewport(),
        );
        const before = streamingCount();
        session.pressKey('\x19');
        const expectedAfterRetry =
          retry === (scenario.retries ?? 0) - 1
            ? scenario.requests
            : before + 1;
        await turnEnds(expectedAfterRetry);
      }
    }
    if (scenario.laterTurns) {
      await until(
        () =>
          streamingCount() >= scenario.requests &&
          (scenario.sideRequests === undefined ||
            sideCount() >= scenario.sideRequests),
        'the session starts its later turns',
        90_000,
        () => session!.viewport(),
      );
      await turnEnds(scenario.requests);
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
      sharedSubagentBatches:
        debugLog.match(SHARED_SUBAGENT_BATCH_LOG)?.length ?? 0,
      kernelRounds: countKernelRounds(debugLog),
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
      // OpenTUI's current path runs the replay again; the batch answers it.
      openTuiSends: 'was already handled',
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
      approvals: [
        {
          answer: 'allow',
          settled: (dir) =>
            existsSync(join(dir, 'a.txt')) &&
            readFileSync(join(dir, 'a.txt'), 'utf8') === 'a body\n',
        },
        { answer: 'deny' },
      ],
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
      // A foreground subagent's write waits for approval; the TUI answers it
      // from outside the subagent's frames, which the approval restores.
      name: "a subagent's write approved in the TUI",
      requests: 4,
      rounds: 2,
      batches: 1,
      subagentBatches: 1,
      approvalMode: 'default',
      approvals: [
        {
          answer: 'allow',
          settled: (dir) =>
            existsSync(join(dir, 'a.txt')) &&
            readFileSync(join(dir, 'a.txt'), 'utf8') === 'a body\n',
        },
      ],
      prompts: ['Have a helper write a.'],
      agent: (messages) => (isHelper(messages) ? 'helper' : 'leader'),
      recorded: 'The helper wrote a.',
      reply: (messages, dir) =>
        isHelper(messages)
          ? toolResults(messages) === 0
            ? { toolCalls: [write(join(dir, 'a.txt'), 'a body\n', 'call_a')] }
            : { content: 'Wrote a.' }
          : toolResults(messages) === 0
            ? {
                toolCalls: [
                  fakeToolCall(
                    'agent',
                    {
                      subagent_type: 'general-purpose',
                      description: 'Write a',
                      prompt: `${HELPER_TASK} Write a.`,
                      run_in_background: false,
                    },
                    'call_helper',
                  ),
                ],
              }
            : { content: 'The helper wrote a.' },
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
      // The job's task id, its process, the project's runtime directory and
      // the launch text's byte counts, which the process id's width sets.
      volatile: BACKGROUND_SHELL_VOLATILE,
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
          // Sending the leader's last request does not order the two replies.
          // Wait for its recorded answer before releasing the helper so the
          // strict transcript comparison has a deterministic causal order.
          return leaderWaiting.promise.then(async () => {
            await until(
              () =>
                files(join(dir, '..', 'runtime'))
                  .filter(
                    (file) => file.endsWith('.jsonl') && file.includes('chats'),
                  )
                  .some((file) =>
                    readFileSync(file, 'utf8').includes(
                      '"text":"Waiting for the helper."',
                    ),
                  ),
              'the leader records its waiting answer',
            );
            return { content: 'HELPER REPORT: it is sunny.' };
          });
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

  // The byte-count case pins the constant; this pins the scenario's use of
  // it, which the parity run alone only notices when the two pids differ in
  // width.
  it('uses the normalizer the byte-count case pins', () => {
    const scenario = allScenarios.find(
      (candidate) =>
        candidate.name ===
        'a background shell whose result starts a notification turn',
    );
    expect(scenario?.volatile).toBe(BACKGROUND_SHELL_VOLATILE);
  });

  it.each(scenarios)('$name', PARITY_CASE_OPTIONS, async (scenario) => {
    const current = await run(scenario, false);
    const shared = await run(scenario, true);
    const kernel = await run(scenario, true, true);
    // Only the run with the setting on sends its rounds on the shared loop.
    expect(current.sharedRounds).toBe(0);
    expect(shared.sharedRounds).toBe(scenario.rounds);
    expect(current.sharedBatches).toBe(0);
    expect(shared.sharedBatches).toBe(scenario.batches);
    expect(current.sharedSubagentBatches).toBe(0);
    expect(shared.sharedSubagentBatches).toBe(scenario.subagentBatches ?? 0);
    expect(current.kernelRounds).toBe(0);
    expect(shared.kernelRounds).toBe(0);
    // Each round also runs on the event-bus kernel, which must send and
    // record what the shared loop does.
    expect(kernel.kernelRounds).toBe(scenario.rounds);
    expect(kernel.sharedRounds).toBe(shared.sharedRounds);
    expect(kernel.sharedBatches).toBe(shared.sharedBatches);
    expect(kernel.requests).toEqual(shared.requests);
    expect(kernel.sideRequests).toEqual(shared.sideRequests);
    expect(kernel.records).toEqual(shared.records);
    for (const run of [current, shared, kernel]) {
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
    if (renderer === 'opentui' && scenario.openTuiSends) {
      expect(JSON.stringify(shared.requests)).toContain(scenario.openTuiSends);
      expect(JSON.stringify(current.requests)).not.toContain(
        scenario.openTuiSends,
      );
      return;
    }
    expect(shared.requests).toEqual(current.requests);
    expect(shared.sideRequests).toEqual(current.sideRequests);
    expect(shared.records).toEqual(current.records);
  });
});
