/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An ACP session runs each scripted scenario twice, with
 * `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP` unset and set, and the two runs must
 * send the model the same requests, send the client the same
 * `session/update` notifications and end each prompt the same way.
 * Differences the shared loop makes on purpose are asserted separately below.
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
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
import { ACP_HOME_PREFIX, removeScratchDir } from '../scratch-dir.js';
import { approveProjectHooks } from '../project-hook-approval.js';

// The agent trusts a client that presents the capability it was started with.
const PRIVATE_ACP_CAPABILITY_ENV = 'QWEN_CODE_PRIVATE_ACP_CAPABILITY';
const PARENT_CAPABILITY = 'acp-agent-loop-parity-parent';

type JsonObject = Record<string, unknown>;

interface Scenario {
  name: string;
  prompts: string[];
  prepare?: (rig: TestRig) => void;
  settings?: JsonObject;
  /** Answers each `session/request_permission`; allows once by default. */
  permission?: (request: JsonObject) => JsonObject;
  /** The `_meta` each prompt is sent with, by index. */
  promptMeta?: Array<JsonObject | undefined>;
  /**
   * The client holds the private parent capability, as the channel bridges
   * do, so the agent keeps trusted prompt metadata such as a channel mark.
   */
  trustedParent?: boolean;
  /**
   * Records the session, which a Goal needs, and waits after the prompts for
   * this many Goal turns to end.
   */
  goalTurns?: number;
  /** Waits after the prompts for this many background-notification turns to end. */
  backgroundTurns?: number;
  /** The model's reply to a request that does not stream, such as a verifier's. */
  sideReply?: (body: JsonObject) => FakeOpenAIResponse;
  /** Sends `session/cancel` once this file exists in the test directory. */
  cancelOnFile?: string;
  /**
   * The calls run concurrently on the shared loop, so their updates are
   * compared per call.
   */
  concurrent?: boolean;
  /**
   * The client's loop guard stops the last response as it streams, so on
   * the shared loop that request ends interrupted and reports no usage.
   */
  cutByLoopGuard?: boolean;
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
  /** Streaming requests that carry the client's date reminder. */
  dateReminders: number;
  updates: unknown[];
  /** Each prompt's stop reason, or the error it failed with. */
  stopReasons: unknown[];
  permissions: unknown[];
  /** How many updates had arrived when each permission request did. */
  permissionsAt: number[];
  /** The stop reason of each Goal turn, in order. */
  goalTurnEnds: unknown[];
  /** The stop reason of each background-notification turn, in order. */
  backgroundTurnEnds: unknown[];
}

const PROMPT_TIMEOUT_MS = 60_000;

// A Goal's id and the record ids it cites are random in each run.
const RANDOM_ID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// A background task's id, its process and the run's own home directory.
const BACKGROUND_TASK_ID = /bg_[0-9a-f]{8}/g;
const PROCESS_ID = /(pid>|pid: |pid )\d+/g;
const RUN_HOME = new RegExp(`${ACP_HOME_PREFIX}[A-Za-z0-9]+`, 'g');

// Fields that differ between two runs of the same scenario.
const VOLATILE_KEYS = new Set([
  'sessionId',
  'timestamp',
  'durationMs',
  'duration_ms',
  'startedAt',
  'endedAt',
  'executionId',
  'executionDurationMs',
  'apiTimeMs',
  'createdAt',
  'updatedAt',
  'activeTimeMs',
  'setAt',
  // Holds only the plan's random id.
  'qwenTodoPlan',
]);

// The current loop runs a Stop-hook or Todo Stop Guard continuation under a
// prompt id of its own; the shared loop's client keeps the turn's.
const CONTINUATION_PROMPT_ID =
  /(########\d+)_(?:stop_hook|todo_stop_guard)_\d+/g;

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

/** Removes the date reminder the client adds when the date changed. */
function withoutDateReminder(content: unknown): unknown {
  return Array.isArray(content)
    ? content.filter((part) => !isDateReminder(part))
    : content;
}

function normalize(value: unknown, dir: string, sessionId = ''): unknown {
  let text = JSON.stringify(value ?? null)
    .split(dir)
    .join('<DIR>')
    .replace(CONTINUATION_PROMPT_ID, '$1');
  if (sessionId) text = text.split(sessionId).join('<SESSION>');
  const replaced = JSON.parse(
    text
      .replace(RANDOM_ID, '<ID>')
      .replace(BACKGROUND_TASK_ID, 'bg_<ID>')
      .replace(PROCESS_ID, '$1<PID>')
      .replace(RUN_HOME, '<HOME>'),
  );
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as JsonObject)
          .filter(([key]) => !VOLATILE_KEYS.has(key))
          .map(([key, child]) => [key, strip(child)]),
      );
    }
    return node;
  };
  return strip(replaced);
}

const streamingMessages = (server: FakeOpenAIServer) =>
  server.requests
    .filter((request) => request.body['stream'] === true)
    .map((request) => (request.body['messages'] ?? []) as JsonObject[]);

function modelRequests(server: FakeOpenAIServer, dir: string): unknown[] {
  return streamingMessages(server).map((messages) =>
    messages
      .filter((message) => message['role'] !== 'system')
      .map(
        (message): JsonObject => ({
          ...message,
          content: withoutDateReminder(message['content']),
        }),
      )
      .filter(
        (message) =>
          !Array.isArray(message['content']) || message['content'].length > 0,
      )
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

/** Leaves out `available_commands_update`, sent on its own schedule. */
const isPromptUpdate = (update: unknown) =>
  (update as JsonObject)?.['sessionUpdate'] !== 'available_commands_update';

/** The usage and the request end a finished response reports. */
const isResponseEnd = (update: unknown) => {
  const meta = (update as JsonObject)?.['_meta'] as JsonObject | undefined;
  return (
    meta?.['usage'] !== undefined ||
    (meta?.['executionLifecycle'] as JsonObject | undefined)?.['phase'] ===
      'ended'
  );
};

/** Each call's updates in order, and the updates of no call in order. */
function byToolCall(updates: unknown[]) {
  const calls: Record<string, unknown[]> = {};
  const others: unknown[] = [];
  for (const update of updates) {
    const id = (update as JsonObject)?.['toolCallId'];
    if (typeof id === 'string') (calls[id] ??= []).push(update);
    else others.push(update);
  }
  return { calls, others };
}

const allowOnce = () => ({
  outcome: { outcome: 'selected', optionId: 'proceed_once' },
});

(IS_CONTAINER_SANDBOX ? describe.skip : describe)(
  'ACP agent loop parity (experimental.unifiedAgentLoop)',
  () => {
    let rig: TestRig | undefined;
    let server: FakeOpenAIServer | undefined;

    afterEach(async () => {
      await server?.close();
      server = undefined;
      await rig?.cleanup();
      rig = undefined;
    });

    async function run(scenario: Scenario, shared: boolean): Promise<Run> {
      await server?.close();
      await rig?.cleanup();
      rig = new TestRig();
      await rig.setup(`acp-agent-loop-parity ${scenario.name}`, {
        // The follow-up suggestion request runs after the prompt returns and
        // may or may not land before the agent stops, so leave it out.
        settings: {
          ...scenario.settings,
          ui: { enableFollowupSuggestions: false },
        },
      });
      const dir = rig.testDir!;
      scenario.prepare?.(rig);
      // Snapshot the fixture's home writes before the child can touch it.
      const homeBefore = readdirSync(join(dir, '.qwen-home')).sort();
      let streamingIndex = 0;
      server = await startFakeOpenAIServer(
        ({ body }) =>
          body['stream'] === true
            ? scenario.reply(
                (body['messages'] ?? []) as JsonObject[],
                dir,
                streamingIndex++,
              )
            : (scenario.sideReply?.(body) ?? {
                content: '{"selected_memories":[]}',
              }),
        fakeServerHostOptions(),
      );
      const noProxy = IS_CONTAINER_SANDBOX
        ? CONTAINER_SANDBOX_NO_PROXY
        : '127.0.0.1,localhost';
      const qwenHome = mkdtempSync(join(tmpdir(), ACP_HOME_PREFIX));
      // Project hooks need both authorities available: enable the trust
      // feature (the inherited rig trust store grants the workspace; no
      // trust-store file here because the request snapshot encodes this
      // directory's tree) and record the approval an interactive user
      // would give for scenarios that declare hooks.
      writeFileSync(
        join(qwenHome, 'settings.json'),
        JSON.stringify({ security: { folderTrust: { enabled: true } } }),
      );
      if (scenario.settings?.['hooks']) approveProjectHooks(qwenHome, dir);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: server.baseUrl,
        OPENAI_MODEL: 'fake-model',
        QWEN_MODEL: 'fake-model',
        NO_PROXY: noProxy,
        no_proxy: noProxy,
        QWEN_HOME: qwenHome,
        // TestRig keeps QWEN_RUNTIME_DIR inside the workspace; leaving it
        // there lets the session runtime write `tmp/<hash>` into the directory
        // each run's request snapshot encodes, so give each run its own
        // scratch runtime outside the workspace.
        QWEN_RUNTIME_DIR: qwenHome,
      };
      delete env['QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP'];
      if (shared) env['QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP'] = '1';
      delete env[PRIVATE_ACP_CAPABILITY_ENV];
      if (scenario.trustedParent) {
        env[PRIVATE_ACP_CAPABILITY_ENV] = PARENT_CAPABILITY;
      }
      const agent = spawn(
        'node',
        [
          rig.bundlePath,
          '--acp',
          ...(scenario.goalTurns ? [] : ['--no-chat-recording']),
        ],
        {
          cwd: dir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        },
      );
      let stderr = '';
      agent.stderr.on('data', (chunk: Buffer) => (stderr += chunk));

      const updates: unknown[] = [];
      const goalTurnEnds: unknown[] = [];
      const backgroundTurnEnds: unknown[] = [];
      const permissions: unknown[] = [];
      const permissionsAt: number[] = [];
      const pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (error: Error) => void }
      >();
      let nextId = 1;
      const send = (message: JsonObject) =>
        agent.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`,
        );
      const request = (method: string, params: unknown) =>
        new Promise<unknown>((resolve, reject) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(
              new Error(`${method} timed out\n${stderr.trimEnd().slice(-800)}`),
            );
          }, PROMPT_TIMEOUT_MS);
          pending.set(id, {
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          });
          send({ id, method, params });
        });
      agent.once('close', (code) => {
        for (const waiter of pending.values()) {
          waiter.reject(
            new Error(
              `agent exited with ${code}\n${stderr.trimEnd().slice(-800)}`,
            ),
          );
        }
        pending.clear();
      });
      createInterface({ input: agent.stdout }).on('line', (line) => {
        if (!line.trim().startsWith('{')) return;
        const message = JSON.parse(line) as JsonObject;
        const id = message['id'];
        const method = message['method'];
        const params = message['params'] as JsonObject | undefined;
        if (typeof id === 'number' && method === undefined) {
          const waiter = pending.get(id);
          pending.delete(id);
          if (message['error']) {
            waiter?.reject(new Error(JSON.stringify(message['error'])));
          } else {
            waiter?.resolve(message['result']);
          }
          return;
        }
        if (method === 'session/update') {
          updates.push(params?.['update']);
          return;
        }
        if (method === '_qwencode/end_turn' && params?.['source'] === 'goal') {
          goalTurnEnds.push(params['reason']);
          return;
        }
        if (
          method === '_qwencode/end_turn' &&
          params?.['source'] === 'background_notification'
        ) {
          backgroundTurnEnds.push(params['reason']);
          return;
        }
        if (typeof id !== 'number' || typeof method !== 'string') return;
        if (method === 'session/request_permission') {
          permissions.push(params?.['toolCall']);
          permissionsAt.push(updates.filter(isPromptUpdate).length);
          send({
            id,
            result: (scenario.permission ?? allowOnce)(params ?? {}),
          });
        } else if (method === 'fs/read_text_file') {
          try {
            send({
              id,
              result: {
                content: readFileSync(String(params?.['path']), 'utf8'),
              },
            });
          } catch (error) {
            send({ id, error: { code: -32000, message: String(error) } });
          }
        } else if (method === 'craft/claimTodoStopGuardContinuation') {
          send({ id, result: { claimed: true, hasQueuedPrompt: false } });
        } else if (method === 'craft/drainMidTurnQueue') {
          send({ id, result: { messages: [], hasQueuedPrompt: false } });
        } else if (method === 'fs/write_text_file') {
          writeFileSync(
            String(params?.['path']),
            String(params?.['content'] ?? ''),
            'utf8',
          );
          send({ id, result: null });
        } else {
          send({ id, error: { code: -32601, message: 'Method not found' } });
        }
      });

      const stopReasons: unknown[] = [];
      let sessionId = '';
      try {
        await request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
          ...(scenario.trustedParent && {
            _meta: {
              'qwen-code/private-parent-capability': PARENT_CAPABILITY,
            },
          }),
        });
        await request('authenticate', { methodId: 'openai' });
        ({ sessionId } = (await request('session/new', {
          cwd: dir,
          mcpServers: [],
        })) as { sessionId: string });
        for (const [promptIndex, text] of scenario.prompts.entries()) {
          let settled = false;
          const cancelFile = scenario.cancelOnFile;
          if (cancelFile && promptIndex === 0) {
            void (async () => {
              while (!settled && !existsSync(join(dir, cancelFile))) {
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
              if (!settled)
                send({ method: 'session/cancel', params: { sessionId } });
            })();
          }
          try {
            const result = (await request('session/prompt', {
              sessionId,
              prompt: [{ type: 'text', text }],
              ...(scenario.promptMeta?.[promptIndex] && {
                _meta: scenario.promptMeta[promptIndex],
              }),
            })) as JsonObject;
            stopReasons.push(result['stopReason']);
          } catch (error) {
            stopReasons.push({ error: (error as Error).message });
          } finally {
            settled = true;
          }
        }
        const goalDeadline = Date.now() + PROMPT_TIMEOUT_MS;
        while (
          (goalTurnEnds.length < (scenario.goalTurns ?? 0) ||
            backgroundTurnEnds.length < (scenario.backgroundTurns ?? 0)) &&
          Date.now() < goalDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        agent.kill();
        await new Promise((resolve) => {
          if (agent.exitCode !== null || agent.signalCode) resolve(undefined);
          else agent.once('exit', resolve);
        });
        // Keep the runtime state for post-mortem whenever TestRig.cleanup()
        // keeps the test directory, which it decides by truthiness.
        if (!process.env['KEEP_OUTPUT']) {
          await removeScratchDir(qwenHome);
        }
      }
      // The scratch runtime keeps the session runtime's `tmp/<hash>` and
      // `usage/` out of the workspace. Comparing against the pre-run listing
      // avoids copying TestRig's seeded names, and a leak fails here directly
      // rather than only when the request equality loses a race.
      expect(readdirSync(join(dir, '.qwen-home')).sort()).toEqual(homeBefore);
      return {
        requests: modelRequests(server, dir),
        dateReminders: streamingMessages(server).filter((messages) =>
          messages.some(
            (message) =>
              Array.isArray(message['content']) &&
              message['content'].some(isDateReminder),
          ),
        ).length,
        updates: updates
          .filter(isPromptUpdate)
          .map((update) => normalize(update, dir, sessionId)),
        stopReasons: stopReasons.map((reason) =>
          normalize(reason, dir, sessionId),
        ),
        permissions: permissions.map((call) => normalize(call, dir, sessionId)),
        permissionsAt,
        goalTurnEnds,
        backgroundTurnEnds,
      };
    }

    async function both(scenario: Scenario) {
      const current = await run(scenario, false);
      const shared = await run(scenario, true);
      const dump = process.env['ACP_PARITY_DUMP'];
      if (dump) {
        const slug = scenario.name.replace(/[^a-z0-9]+/gi, '-');
        writeFileSync(
          join(dump, `${slug}.current.json`),
          JSON.stringify(current, null, 1),
        );
        writeFileSync(
          join(dump, `${slug}.shared.json`),
          JSON.stringify(shared, null, 1),
        );
      }
      return { current, shared };
    }

    const read = (file: string, id: string) =>
      fakeToolCall('read_file', { file_path: file }, id);
    const write = (file: string, content: string, id: string) =>
      fakeToolCall('write_file', { file_path: file, content }, id);
    const hooks = (event: string, script: string) => ({
      [event]: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: `node ${script}` }],
        },
      ],
    });

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
        prepare: (r) => r.createFile('readme.txt', 'readme body\n'),
        reply: (messages, dir) =>
          toolResults(messages) === 0
            ? { toolCalls: [read(join(dir, 'readme.txt'), 'call_read')] }
            : { content: 'It says readme body.' },
      },
      {
        name: 'two reads in one response',
        prompts: ['Read both files.'],
        concurrent: true,
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
        name: 'reads past the per-turn tool-call cap',
        prompts: ['Read the files one by one.'],
        cutByLoopGuard: true,
        settings: { model: { maxToolCallsPerTurn: 2 } },
        prepare: (r) => {
          r.createFile('a.txt', 'alpha\n');
          r.createFile('b.txt', 'beta\n');
          r.createFile('c.txt', 'gamma\n');
        },
        reply: (messages, dir) => {
          const done = toolResults(messages);
          return done < 3
            ? {
                toolCalls: [
                  read(join(dir, `${'abc'[done]}.txt`), `call_${done}`),
                ],
              }
            : { content: 'All read.' };
        },
      },
      {
        name: 'an approved write between reads',
        prompts: ['Read, write, read.'],
        settings: { tools: { approvalMode: 'default' } },
        prepare: (r) => r.createFile('in.txt', 'input\n'),
        reply: (messages, dir) =>
          toolResults(messages) === 0
            ? {
                toolCalls: [
                  read(join(dir, 'in.txt'), 'call_in'),
                  write(join(dir, 'out.txt'), 'written\n', 'call_write'),
                  read(join(dir, 'out.txt'), 'call_out'),
                ],
              }
            : { content: 'Done.' },
      },
      {
        name: 'a denied write',
        prompts: ['Write the file.'],
        settings: { tools: { approvalMode: 'default' } },
        permission: () => ({ outcome: { outcome: 'cancelled' } }),
        reply: (messages, dir) =>
          toolResults(messages) === 0
            ? { toolCalls: [write(join(dir, 'out.txt'), 'no\n', 'call_no')] }
            : { content: 'Understood.' },
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
        name: 'a retry after a model error',
        prompts: ['Answer, please.', 'Answer, please.'],
        // The client retries the prompt the error ended.
        promptMeta: [undefined, { 'qwen.daemon.retry': true }],
        reply: (_messages, _dir, index) =>
          index === 0
            ? { errorContent: 'upstream exploded' }
            : { content: 'Here is the answer.' },
      },
      {
        name: 'a retry that fails again',
        prompts: ['Answer, please.', 'Answer, please.', 'Answer, please.'],
        // The second error comes after the retry's request reached history.
        promptMeta: [
          undefined,
          { 'qwen.daemon.retry': true },
          { 'qwen.daemon.retry': true },
        ],
        reply: (_messages, _dir, index) =>
          index < 2
            ? { errorContent: 'upstream exploded' }
            : { content: 'Here is the answer.' },
      },
      {
        name: 'a channel prompt that reads a file',
        prompts: ['Read the readme.'],
        promptMeta: [{ 'qwen.channel.prompt': true }],
        trustedParent: true,
        prepare: (r) => r.createFile('readme.txt', 'readme body\n'),
        reply: (messages, dir) =>
          toolResults(messages) === 0
            ? { toolCalls: [read(join(dir, 'readme.txt'), 'call_read')] }
            : { content: 'It says readme body.' },
      },
      {
        name: 'a Goal its second continuation completes',
        prompts: ['/goal Report the weather.'],
        goalTurns: 2,
        // The first continuation stops on its own; the second proposes that
        // the Goal is complete, which ends its turn for the verifier.
        reply: (_messages, _dir, index) =>
          index === 0
            ? { content: 'Checking the forecast.' }
            : {
                toolCalls: [
                  fakeToolCall(
                    'update_goal',
                    { status: 'complete', reason: 'The forecast is sunny.' },
                    'call_goal',
                  ),
                ],
              },
        sideReply: () => ({
          content: '{"decision":"accept","reason":"The forecast was given."}',
        }),
      },
      {
        name: 'a background shell whose result starts a notification turn',
        prompts: ['Run the job in the background.'],
        backgroundTurns: 1,
        // The job outlasts the prompt, so its result starts a turn of its
        // own on both loops.
        reply: (_messages, _dir, index) =>
          index === 0
            ? {
                toolCalls: [
                  fakeToolCall(
                    'run_shell_command',
                    {
                      command: 'sleep 2; echo job done',
                      description: 'Run the job',
                      is_background: true,
                    },
                    'call_job',
                  ),
                ],
              }
            : index === 1
              ? { content: 'The job is running.' }
              : { content: 'The job is done.' },
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
        prepare: (r) =>
          r.createFile(
            'block-prompt.mjs',
            "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'not today' }));\n",
          ),
        reply: () => ({ content: 'Should not be asked.' }),
      },
      {
        name: 'a Stop hook that blocks once',
        prompts: ['Answer, then keep going once.'],
        settings: { hooks: hooks('Stop', 'stop-once.mjs') },
        prepare: (r) =>
          r.createFile(
            'stop-once.mjs',
            [
              "import { existsSync, writeFileSync } from 'node:fs';",
              "const marker = 'stop-hook-fired';",
              'if (existsSync(marker)) process.stdout.write("{}");',
              'else {',
              "  writeFileSync(marker, '');",
              "  process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Add a closing line.' }));",
              '}',
              '',
            ].join('\n'),
          ),
        reply: (messages) => ({ content: `Reply ${userTurns(messages)}.` }),
      },
      {
        name: 'the Todo Stop Guard continuing past unfinished todos',
        prompts: ['Plan it, then stop.'],
        settings: {
          experimental: { todoStopGuard: true },
          tools: { todoWrite: { enabled: true } },
        },
        reply: (messages) =>
          toolResults(messages) === 0
            ? {
                toolCalls: [
                  fakeToolCall(
                    'todo_write',
                    {
                      todos: [
                        {
                          id: '1',
                          content: 'finish the task',
                          status: 'pending',
                        },
                      ],
                    },
                    'call_todo',
                  ),
                ],
              }
            : { content: `Reply ${userTurns(messages)}.` },
      },
      {
        name: 'a Stop hook that blocks up to the cap',
        prompts: ['Answer, then keep going.'],
        settings: {
          hooks: hooks('Stop', 'stop-always.mjs'),
          stopHookBlockingCap: 2,
        },
        prepare: (r) =>
          r.createFile(
            'stop-always.mjs',
            "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Keep going.' }));\n",
          ),
        reply: (messages) => ({ content: `Reply ${userTurns(messages)}.` }),
      },
    ];

    it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
      '%s: same requests, updates and stop reasons',
      async (_name, scenario) => {
        const { current, shared } = await both(scenario);

        expect(shared.stopReasons).toEqual(current.stopReasons);
        expect(shared.requests).toEqual(current.requests);
        expect(shared.goalTurnEnds).toEqual(current.goalTurnEnds);
        expect(shared.backgroundTurnEnds).toEqual(current.backgroundTurnEnds);
        expect(current.backgroundTurnEnds).toHaveLength(
          scenario.backgroundTurns ?? 0,
        );
        if (scenario.goalTurns) {
          expect(current.goalTurnEnds).toHaveLength(scenario.goalTurns);
        }
        const updates = (run: Run) =>
          scenario.cutByLoopGuard
            ? run.updates.filter((update) => !isResponseEnd(update))
            : run.updates;
        if (scenario.concurrent) {
          expect(byToolCall(updates(shared))).toEqual(
            byToolCall(updates(current)),
          );
        } else {
          expect(updates(shared)).toEqual(updates(current));
        }
        if (scenario.cutByLoopGuard) {
          const lastEnd = shared.updates.findLast(isResponseEnd) as JsonObject;
          expect(
            (
              (lastEnd['_meta'] as JsonObject)[
                'executionLifecycle'
              ] as JsonObject
            )['outcome'],
          ).toBe('interrupted');
        }
        expect(shared.permissions).toEqual(current.permissions);
      },
      120_000,
    );

    it('asks for every approval of a batch before running any of its calls, as other surfaces do', async () => {
      const { current, shared } = await both(
        scenarios.find(
          ({ name }) => name === 'an approved write between reads',
        )!,
      );
      const started = (run: Run, id: string) =>
        run.updates.findIndex(
          (update) =>
            (update as JsonObject)['toolCallId'] === id &&
            (update as JsonObject)['status'] === 'in_progress',
        );

      // The current loop asks when it reaches the write, after the first read.
      expect(current.permissionsAt[0]).toBeGreaterThan(
        started(current, 'call_in'),
      );
      expect(shared.permissionsAt[0]).toBeLessThanOrEqual(
        started(shared, 'call_in'),
      );
    }, 120_000);

    it('runs UserPromptSubmit on tool-result requests too, as other surfaces do', async () => {
      const hookCalls: number[] = [];
      const scenario: Scenario = {
        name: 'UserPromptSubmit on tool results',
        prompts: ['Read the readme.'],
        settings: { hooks: hooks('UserPromptSubmit', 'count-prompts.mjs') },
        prepare: (r) => {
          r.createFile('readme.txt', 'readme body\n');
          r.createFile(
            'count-prompts.mjs',
            [
              "import { appendFileSync } from 'node:fs';",
              "appendFileSync('prompt-hook-calls', 'x');",
              'process.stdout.write("{}");',
              '',
            ].join('\n'),
          );
        },
        reply: (messages, dir, index) => {
          if (index === 1) {
            hookCalls.push(
              readFileSync(join(dir, 'prompt-hook-calls'), 'utf8').length,
            );
          }
          return toolResults(messages) === 0
            ? { toolCalls: [read(join(dir, 'readme.txt'), 'call_read')] }
            : { content: 'It says readme body.' };
        },
      };

      const { current, shared } = await both(scenario);

      expect(shared.updates).toEqual(current.updates);
      // Hook calls by each run's second model request, the tool result's.
      expect(hookCalls).toEqual([1, 2]);
    }, 120_000);

    it('cancels a tool-result request whose UserPromptSubmit hook is still running', async () => {
      const scenario: Scenario = {
        name: 'cancel during a tool-result hook',
        prompts: ['Read the readme.', 'Next.'],
        settings: { hooks: hooks('UserPromptSubmit', 'slow-hook.mjs') },
        cancelOnFile: 'hook-waiting',
        prepare: (r) => {
          r.createFile('readme.txt', 'readme body\n');
          r.createFile(
            'slow-hook.mjs',
            [
              "import { writeFileSync } from 'node:fs';",
              "let input = ''; for await (const chunk of process.stdin) input += chunk;",
              // The tool-result request's hook has no prompt text.
              'if (JSON.parse(input).prompt === "") {',
              "  writeFileSync('hook-waiting', '');",
              '  await new Promise((resolve) => setTimeout(resolve, 45_000));',
              '}',
              'process.stdout.write("{}");',
              '',
            ].join('\n'),
          );
        },
        reply: (messages, dir) =>
          toolResults(messages) === 0
            ? { toolCalls: [read(join(dir, 'readme.txt'), 'call_read')] }
            : { content: 'It says readme body.' },
      };

      const started = Date.now();
      const shared = await run(scenario, true);

      expect(shared.stopReasons).toEqual(['cancelled', 'end_turn']);
      // The tool result never reached the model.
      expect(shared.requests).toHaveLength(2);
      expect(shared.requests[1]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'tool', tool_call_id: 'call_read' }),
        ]),
      );
      expect(JSON.stringify(shared.requests[1])).not.toContain('readme body');
      expect(Date.now() - started).toBeLessThan(30_000);
    }, 120_000);

    it("blocks a write in plan mode with the scheduler's notice, as other surfaces do", async () => {
      const written: boolean[] = [];
      const { current, shared } = await both({
        name: 'a write in plan mode',
        prompts: ['Write the file.'],
        settings: { tools: { approvalMode: 'plan' } },
        reply: (messages, dir) => {
          if (toolResults(messages) === 0)
            return {
              toolCalls: [write(join(dir, 'out.txt'), 'no\n', 'call_no')],
            };
          // The batch has settled by the time its results are sent back.
          written.push(existsSync(join(dir, 'out.txt')));
          return { content: 'Understood.' };
        },
      });
      // The notice is the text of the blocked call's failed update.
      const notice = (run: Run) => {
        const failed = run.updates.filter(
          (update) =>
            (update as JsonObject)['toolCallId'] === 'call_no' &&
            (update as JsonObject)['status'] === 'failed',
        ) as JsonObject[];
        expect(failed).toHaveLength(1);
        const content = failed[0]['content'] as JsonObject[];
        expect(content).toHaveLength(1);
        return (content[0]['content'] as JsonObject)['text'] as string;
      };
      /** Puts a placeholder wherever a string value is the notice. */
      const withoutNotice = (value: unknown, text: string): unknown =>
        JSON.parse(JSON.stringify(value), (_key, child: unknown) =>
          child === text ? '<PLAN MODE NOTICE>' : child,
        );
      const currentNotice = notice(current);
      const sharedNotice = notice(shared);

      expect(currentNotice).toMatch(
        /^Plan mode is active\. The tool "write_file" cannot be executed because it modifies the system\. .*exit_plan_mode/,
      );
      expect(sharedNotice).toMatch(
        /^Tool blocked by plan mode: "write_file" is not a read-only tool\. .*call exit_plan_mode/,
      );
      expect(shared.stopReasons).toEqual(current.stopReasons);
      // Both loops block the write before it runs and ask nothing; only the
      // notice the model and the client see differs.
      expect(current.permissions).toEqual([]);
      expect(shared.permissions).toEqual([]);
      expect(current.requests).toHaveLength(2);
      expect(withoutNotice(shared.requests, sharedNotice)).toEqual(
        withoutNotice(current.requests, currentNotice),
      );
      expect(withoutNotice(shared.updates, sharedNotice)).toEqual(
        withoutNotice(current.updates, currentNotice),
      );
      // The model gets the notice as the call's result on each loop.
      expect(JSON.stringify(current.requests[1])).toContain(
        JSON.stringify(currentNotice),
      );
      expect(JSON.stringify(shared.requests[1])).toContain(
        JSON.stringify(sharedNotice),
      );
      // One reading per run, current first, and neither wrote the file.
      expect(written).toEqual([false, false]);
    }, 120_000);

    it('adds no date reminder to a first prompt, as other surfaces do', async () => {
      // The startup context already carries today's date; the client adds a
      // reminder only once the date changes.
      const { current, shared } = await both({
        name: 'date reminder',
        prompts: ['Say hello.'],
        reply: () => ({ content: 'Hello there.' }),
      });

      expect(current.dateReminders).toBe(0);
      expect(shared.dateReminders).toBe(0);
    }, 120_000);
  },
);
