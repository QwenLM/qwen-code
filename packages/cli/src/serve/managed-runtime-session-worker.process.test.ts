/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { BridgeExecutionEngine } from '@qwen-code/acp-bridge/bridgeOptions';
import type { AcpChannel, ChannelFactory } from '@qwen-code/acp-bridge/channel';
import { ProcessRegistry } from '@qwen-code/acp-bridge/processRegistry';
import { createSpawnChannelFactory } from '@qwen-code/acp-bridge/spawnChannel';
import { getProjectHash } from '@qwen-code/qwen-code-core/utils/paths.js';
import {
  createAcpSessionBridge,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import { createManagedEngineChannelFactory } from './managed-engine-channel-factory.js';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { localManagedSessionKey } from '@qwen-code/qwen-code-core/utils/sessionStorageUtils.js';
import { parseHarnessCheckpointV1 } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import type { HarnessCheckpointV1 } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { testInternals } from './managed-runtime-ledger.js';

// Real `qwen --acp` children and their Runtime workers, run from source
// through tsx; workspace packages resolve to their sources too.
const CLI_ENTRY = fileURLToPath(new URL('../cli.ts', import.meta.url));
const CLI_TSCONFIG = fileURLToPath(
  new URL('../../tsconfig.json', import.meta.url),
);
const TSX_LOADER = pathToFileURL(
  createRequire(import.meta.url).resolve('tsx/esm'),
).href;
const MODEL = 'm5-fixture';
const RUNTIME_TOOLS = ['edit', 'read_file', 'run_shell_command', 'write_file'];

type ModelTurn =
  | { readonly text: string }
  | {
      readonly toolCalls: ReadonlyArray<{
        readonly name: string;
        readonly args: Record<string, unknown>;
      }>;
    };

interface ModelRequest {
  readonly tools?: Array<{ function?: { name?: string } }>;
  readonly messages?: Array<{ role?: string; content?: unknown }>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The command lines of every process below `root`. */
function descendantArgs(root: number): string[] {
  const children = new Map<number, Array<{ pid: number; args: string }>>();
  for (const line of execFileSync('ps', ['-eo', 'pid=,ppid=,args='], {
    encoding: 'utf8',
    // A loaded CI shard's process table exceeds execFileSync's 1 MiB default.
    maxBuffer: 16 * 1024 * 1024,
  }).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const parent = Number(match[2]);
    const siblings = children.get(parent) ?? [];
    siblings.push({ pid: Number(match[1]), args: match[3]! });
    children.set(parent, siblings);
  }
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    for (const child of children.get(pending.pop()!) ?? []) {
      found.push(child.args);
      pending.push(child.pid);
    }
  }
  return found;
}

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(process.platform === 'win32')('Managed Runtime tools', () => {
  let root: string;
  let workspace: string;
  let server: Server;
  let turns: ModelTurn[];
  let modelRequests: ModelRequest[];
  let bridge: AcpSessionBridge | undefined;
  let registry: ProcessRegistry;
  let sourceEnv: NodeJS.ProcessEnv;
  let settingsFile: string;
  let started: Record<BridgeExecutionEngine, AcpChannel[]>;
  const strayPids: number[] = [];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'qwen-m5-')));
    workspace = path.join(root, 'workspace');
    const qwenHome = path.join(root, 'config');
    await mkdir(workspace);
    await mkdir(qwenHome);
    turns = [];
    modelRequests = [];
    let callSequence = 0;
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest;
      // Side queries, such as the session title, declare no tools and do not
      // take the conversation's scripted turns.
      const conversation = body.tools !== undefined;
      if (conversation) modelRequests.push(body);
      const turn = (conversation ? turns.shift() : undefined) ?? {
        text: 'DONE',
      };
      const deltas: Array<[Record<string, unknown>, string | null]> =
        'text' in turn
          ? [
              [{ role: 'assistant', content: turn.text }, null],
              [{}, 'stop'],
            ]
          : [
              [
                {
                  role: 'assistant',
                  tool_calls: turn.toolCalls.map((call, index) => ({
                    index,
                    id: `call_${++callSequence}`,
                    type: 'function',
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.args),
                    },
                  })),
                },
                null,
              ],
              [{}, 'tool_calls'],
            ];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [delta, finishReason] of deltas) {
        res.write(
          `data: ${JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 0,
            model: MODEL,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      }
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    settingsFile = path.join(qwenHome, 'settings.json');
    await writeFile(
      settingsFile,
      JSON.stringify({
        security: { auth: { selectedType: 'openai' } },
        model: { name: MODEL },
        // Every file write and command asks, so the host's approval flow is
        // visible to the test.
        tools: { approvalMode: 'default' },
        telemetry: { enabled: false },
        privacy: { usageStatisticsEnabled: false },
        modelProviders: {
          openai: [{ id: MODEL, envKey: 'OPENAI_API_KEY', baseUrl }],
        },
      }),
    );
    sourceEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
    );
    Object.assign(sourceEnv, {
      HOME: root,
      QWEN_HOME: qwenHome,
      QWEN_RUNTIME_DIR: path.join(root, 'runtime'),
      QWEN_CLI_ENTRY: CLI_ENTRY,
      NODE_OPTIONS: `--import ${TSX_LOADER}`,
      TSX_TSCONFIG_PATH: CLI_TSCONFIG,
      OPENAI_API_KEY: 'm5-fixture-key',
      OPENAI_BASE_URL: baseUrl,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      NO_COLOR: '1',
    });
    registry = new ProcessRegistry();
    started = { legacy: [], managed: [] };
    const record =
      (
        target: BridgeExecutionEngine,
        factory: ChannelFactory,
      ): ChannelFactory =>
      async (...args) => {
        const channel = await factory(...args);
        started[target].push(channel);
        return channel;
      };
    const options = { sourceEnv, processRegistry: registry };
    bridge = createAcpSessionBridge({
      boundWorkspace: workspace,
      sessionScope: 'thread',
      channelIdleTimeoutMs: 0,
      initializeTimeoutMs: 60_000,
      executionEngines: {
        legacy: record('legacy', createSpawnChannelFactory(options)),
        managed: record('managed', createManagedEngineChannelFactory(options)),
        select: () => 'managed',
      },
    });
  });

  afterEach(async () => {
    await bridge?.shutdown();
    bridge = undefined;
    await registry.shutdown();
    for (const pid of strayPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  async function newSession(): Promise<string> {
    const session = await bridge!.spawnOrAttach({
      workspaceCwd: workspace,
      sessionScope: 'thread',
    });
    return session.sessionId;
  }

  /** Sends a prompt, approving every permission the host asks for. */
  async function prompt(sessionId: string, updates?: SessionUpdate[]) {
    const permissions: string[] = [];
    const events = bridge!.subscribeEvents(sessionId);
    const watching = (async () => {
      for await (const event of events) {
        if (event.type === 'permission_request') {
          const data = event.data as {
            requestId: string;
            toolCall: { _meta?: { toolName?: string } };
            options: Array<{ optionId: string; kind: string }>;
          };
          permissions.push(data.toolCall._meta?.toolName ?? '');
          bridge!.respondToPermission(data.requestId, {
            outcome: {
              outcome: 'selected',
              optionId: data.options.find(
                (option) => option.kind === 'allow_once',
              )!.optionId,
            },
          });
        }
        if (event.type === 'session_update' && updates) {
          updates.push((event.data as { update: SessionUpdate }).update);
        }
        if (event.type === 'turn_complete' || event.type === 'turn_error') {
          return;
        }
      }
    })();
    try {
      const response = await bridge!.sendPrompt(sessionId, {
        sessionId,
        prompt: [{ type: 'text', text: 'go' }],
      });
      await watching;
      return { stopReason: response.stopReason, permissions };
    } finally {
      if (updates) await watching;
      else void watching.catch(() => undefined);
    }
  }

  /** The durable outcome behind the newest tool.receipt on these log lines. */
  async function readLatestOutcome(
    lines: Array<{
      managedSession?: {
        kind?: string;
        payload?: { toolOutcomeRef?: ManagedSessionDurableRef };
      };
    }>,
    sessionId: string,
  ): Promise<{ executionStatus: string }> {
    const sessionKey = localManagedSessionKey(workspace, sessionId);
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: path.join(root, 'runtime'),
      sessionKey,
    });
    const refs = lines
      .filter((line) => line.managedSession?.kind === 'tool.receipt')
      .map((line) => line.managedSession!.payload!.toolOutcomeRef!);
    const envelope = JSON.parse(
      (await resources.read(refs[refs.length - 1]! as never)).toString(),
    ) as { result?: { executionStatus?: string } };
    return { executionStatus: envelope.result?.executionStatus ?? 'unknown' };
  }

  /** The session's Managed Session log, as the child left it. */
  async function readManagedLog(sessionId: string): Promise<string> {
    const transcript = new SessionService(workspace, {
      runtimeBaseDir: path.join(root, 'runtime'),
    }).getSessionTranscriptPath(sessionId);
    return waitFor(async () => {
      const text = await readFile(transcript, 'utf8').catch(() => undefined);
      return text !== undefined && text.length > 0 ? text : undefined;
    });
  }

  /** A shell command that records the worker's pid, command and parent. */
  function recordWorker(file: string, then = ''): Record<string, unknown> {
    return {
      command:
        `printf '%s\\n%s\\n%s\\n' "$PPID" "$(ps -o ppid= -p "$PPID" | tr -d ' ')"` +
        ` "$(ps -o args= -p "$PPID")" > ${JSON.stringify(file)}${then}`,
      description: 'record the worker',
    };
  }

  async function readWorker(file: string) {
    const [pid, parent, args] = await waitFor(async () => {
      const lines = (await readFile(file, 'utf8').catch(() => '')).split('\n');
      return lines.length >= 3 && lines[2] ? lines : undefined;
    });
    const worker = { pid: Number(pid), parent: Number(parent), args };
    strayPids.push(worker.pid);
    return worker;
  }

  it('prepares and asks in the host, and runs the tools in the session worker', async () => {
    const sessionId = await newSession();
    const written = path.join(workspace, 'written.txt');
    const shellOut = path.join(workspace, 'shell.txt');
    turns.push(
      {
        toolCalls: [
          {
            name: 'write_file',
            args: { file_path: written, content: 'from the worker\n' },
          },
          { name: 'run_shell_command', args: recordWorker(shellOut) },
        ],
      },
      {
        toolCalls: [
          {
            name: 'edit',
            args: {
              file_path: written,
              old_string: 'from the worker',
              new_string: 'edited in the worker',
            },
          },
          { name: 'read_file', args: { file_path: written } },
        ],
      },
      { text: 'DONE' },
    );

    const result = await prompt(sessionId);
    expect(result.stopReason).toBe('end_turn');
    // The host's own approval flow asked before each write and the command.
    expect(result.permissions).toEqual([
      'write_file',
      'run_shell_command',
      'edit',
    ]);
    expect(await readFile(written, 'utf8')).toBe('edited in the worker\n');

    // The command ran under the session's Runtime worker, whose parent is the
    // Managed child, not under the host itself.
    const worker = await readWorker(shellOut);
    expect(worker.args).toContain('managed-runtime-worker');
    const managedChild = worker.parent;
    expect(managedChild).not.toBe(worker.pid);
    expect(isAlive(worker.pid)).toBe(true);

    // The model was offered exactly the Runtime-backed tools, and read the
    // worker's results.
    for (const request of modelRequests) {
      expect(request.tools?.map((tool) => tool.function?.name).sort()).toEqual(
        RUNTIME_TOOLS,
      );
    }
    const results = (modelRequests.at(-1)?.messages ?? []).filter(
      (message) => message.role === 'tool',
    );
    expect(results).toHaveLength(4);
    // The read returned the file as the worker's edit left it.
    expect(JSON.stringify(results.at(-1)?.content)).toContain(
      'edited in the worker',
    );

    // Closing the session stops its worker before the session ends.
    await bridge!.closeSession(sessionId);
    expect(isAlive(worker.pid)).toBe(false);

    // Every call's evidence is durable: admitted before dispatch, settled as
    // it ended, and the batch closed behind it before the model continued.
    const log = await readManagedLog(sessionId);
    const count = (needle: string) => log.split(needle).length - 1;
    expect(count('"tool.intent"')).toBe(4);
    expect(count('"tool.receipt"')).toBe(4);
    expect(count('"durable_wait"')).toBeGreaterThanOrEqual(1);
    expect(count('"turn_complete"')).toBeGreaterThanOrEqual(1);

    // The batch closed behind the results: a consumed turn_settled
    // checkpoint names every call settled with its outcome.
    const checkpointRefs = log
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            managedSession?: { kind?: string; payload?: { stateRef?: never } };
          },
      )
      .filter((line) => line.managedSession?.kind === 'checkpoint.committed')
      .map((line) => line.managedSession!.payload!.stateRef!);
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: path.join(root, 'runtime'),
      sessionKey: localManagedSessionKey(workspace, sessionId),
    });
    const checkpoints: HarnessCheckpointV1[] = [];
    for (const ref of checkpointRefs) {
      // parse, not JSON.parse: the decoded body must satisfy the schema, so
      // a renamed or dropped field fails here rather than passing vacuously.
      checkpoints.push(parseHarnessCheckpointV1(await resources.read(ref)));
    }
    const closed = checkpoints
      .reverse()
      .find(
        (checkpoint) =>
          checkpoint.continuation.phase === 'turn_settled' &&
          Array.isArray(checkpoint.tools?.items),
      );
    const closedItems = closed?.tools?.items;
    expect(closedItems).toBeDefined();
    expect(closedItems!.length).toBe(4);
    expect(
      closedItems!.every(
        (item) =>
          item.state === 'settled' &&
          item.consumed === true &&
          item.outcomeRef !== null,
      ),
    ).toBe(true);
  }, 120_000);

  it('starts no worker for a session that calls no tool', async () => {
    const sessionId = await newSession();
    turns.push({ text: 'NO_TOOLS' });
    expect((await prompt(sessionId)).stopReason).toBe('end_turn');
    const [managed] = started.managed;
    expect(managed).toBeDefined();
    // While the idle session lives, no worker runs below this test.
    expect(
      descendantArgs(process.pid).filter((args) =>
        args.includes('managed-runtime-worker'),
      ),
    ).toEqual([]);
    await bridge!.closeSession(sessionId);
    expect(await managed.exited).toEqual({ exitCode: 0, signalCode: null });
    await managed.registryReleased;
    expect(registry.committedProcessCount).toBe(0);
  }, 120_000);

  it('stops a running command when the session is cancelled', async () => {
    const sessionId = await newSession();
    const shellOut = path.join(workspace, 'shell.txt');
    const sleeper = path.join(workspace, 'sleeper.pid');
    turns.push({
      toolCalls: [
        {
          name: 'run_shell_command',
          args: recordWorker(
            shellOut,
            `; echo $$ > ${JSON.stringify(sleeper)}; exec sleep 120`,
          ),
        },
      ],
    });
    const running = prompt(sessionId);
    void running.catch(() => undefined);
    const worker = await readWorker(shellOut);
    const sleepPid = Number(
      await waitFor(
        async () =>
          (await readFile(sleeper, 'utf8').catch(() => '')).trim() || undefined,
      ),
    );
    strayPids.push(sleepPid);
    await bridge!.cancelSession(sessionId);
    expect((await running).stopReason).toBe('cancelled');
    // The worker settled the call only after the command stopped.
    expect(isAlive(sleepPid)).toBe(false);
    expect(isAlive(worker.pid)).toBe(true);
    // The cancellation settled as a receipt too, and its outcome says how
    // the call ended — read from the outcome itself, not a substring.
    const cancelledLog = await readManagedLog(sessionId);
    expect(cancelledLog).toContain('"tool.intent"');
    expect(cancelledLog).toContain('"tool.receipt"');
    const outcome = await readLatestOutcome(
      cancelledLog
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              managedSession?: {
                kind?: string;
                payload?: { toolOutcomeRef?: ManagedSessionDurableRef };
              };
            },
        ),
      sessionId,
    );
    expect(outcome.executionStatus).toBe('cancelled');

    // The same worker serves the session's next call.
    const nextOut = path.join(workspace, 'next.txt');
    turns.push(
      {
        toolCalls: [{ name: 'run_shell_command', args: recordWorker(nextOut) }],
      },
      { text: 'DONE' },
    );
    expect((await prompt(sessionId)).stopReason).toBe('end_turn');
    expect((await readWorker(nextOut)).pid).toBe(worker.pid);
  }, 120_000);

  it('does not finish a kernel cancellation while a Managed tool is unresolved', async () => {
    sourceEnv['QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP'] = 'acp=1';
    sourceEnv['QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP'] = 'acp=1';
    const sessionId = await newSession();
    const shellOut = path.join(workspace, 'shell.txt');
    const sleeper = path.join(workspace, 'sleeper.pid');
    turns.push({
      toolCalls: [
        {
          name: 'run_shell_command',
          args: recordWorker(
            shellOut,
            `; echo $$ > ${JSON.stringify(sleeper)}; exec sleep 120`,
          ),
        },
      ],
    });
    const running = prompt(sessionId);
    const finished = vi.fn();
    void running.then(finished, finished);
    const worker = await readWorker(shellOut);
    const sleepPid = Number(
      await waitFor(
        async () =>
          (await readFile(sleeper, 'utf8').catch(() => '')).trim() || undefined,
      ),
    );
    strayPids.push(sleepPid);
    const requestsBefore = modelRequests.length;
    process.kill(worker.pid, 'SIGSTOP');
    const cancelling = bridge!.cancelSession(sessionId);
    void cancelling.catch(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      expect(finished).not.toHaveBeenCalled();
      expect(isAlive(sleepPid)).toBe(true);
    } finally {
      process.kill(worker.pid, 'SIGKILL');
    }
    const unknownOutcome = {
      data: { errorKind: 'managed_runtime_outcome_unknown' },
    };
    await expect(running).rejects.toMatchObject(unknownOutcome);
    await cancelling;
    await expect(prompt(sessionId)).rejects.toMatchObject(unknownOutcome);
    expect(modelRequests).toHaveLength(requestsBefore);
  }, 120_000);

  async function holdReadFilePostHook() {
    const ready = path.join(workspace, 'hook.ready');
    const release = path.join(workspace, 'hook.release');
    const settings = JSON.parse(await readFile(settingsFile, 'utf8')) as object;
    await writeFile(
      settingsFile,
      JSON.stringify({
        ...settings,
        hooks: {
          PostToolUse: [
            {
              matcher: 'read_file',
              hooks: [
                {
                  type: 'command',
                  command:
                    `touch ${JSON.stringify(ready)}; ` +
                    `while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done; printf '{}'`,
                },
              ],
            },
          ],
        },
      }),
    );
    return { ready, release };
  }

  it('cancels after Runtime settlement without publishing pending post-tool output', async () => {
    sourceEnv['QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP'] = 'acp=1';
    sourceEnv['QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP'] = 'acp=1';
    const { ready, release } = await holdReadFilePostHook();
    const sessionId = await newSession();
    const file = path.join(workspace, 'input.txt');
    const knownOutput = 'content already returned by Runtime';
    const expectCancelledToolMessage = () => {
      const toolMessages = modelRequests
        .at(-1)
        ?.messages?.filter(({ role }) => role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(JSON.stringify(toolMessages)).toContain('[Operation Cancelled]');
      expect(JSON.stringify(toolMessages)).not.toContain(knownOutput);
    };
    await writeFile(file, knownOutput);
    turns.push({
      toolCalls: [{ name: 'read_file', args: { file_path: file } }],
    });
    const updates: SessionUpdate[] = [];
    const running = prompt(sessionId, updates);
    void running.catch(() => undefined);
    try {
      await waitFor(() => existsSync(ready) || undefined);
      expect(await readManagedLog(sessionId)).toContain('"tool.receipt"');
      const cancelling = bridge!.cancelSession(sessionId);
      void cancelling.catch(() => undefined);
      const cancelled = vi.fn();
      void running.then(cancelled, () => undefined);
      await waitFor(() => cancelled.mock.calls[0]?.[0], 13_000);
      expect((await running).stopReason).toBe('cancelled');
      await cancelling;
      expect(
        updates.flatMap((update) =>
          update.sessionUpdate === 'tool_call_update' &&
          update._meta?.['toolName'] === 'read_file' &&
          (update.status === 'completed' || update.status === 'failed')
            ? [update.status]
            : [],
        ),
      ).toEqual(['failed']);
      expect(
        updates.map((update) => update._meta?.['toolLifecycle']),
      ).toContainEqual(
        expect.objectContaining({
          toolName: 'read_file',
          phase: 'ended',
          outcome: 'cancelled',
          executionStatus: 'success',
        }),
      );
      expect(JSON.stringify(updates)).not.toContain(knownOutput);
      turns.push({ text: 'CONTINUED' });
      expect((await prompt(sessionId)).stopReason).toBe('end_turn');
      expectCancelledToolMessage();
    } finally {
      await writeFile(release, '');
      await running.catch(() => undefined);
    }

    await bridge!.closeSession(sessionId);
    await bridge!.loadSession({ sessionId, workspaceCwd: workspace });
    turns.push({ text: 'RESTORED' });
    expect((await prompt(sessionId)).stopReason).toBe('end_turn');
    expectCancelledToolMessage();
  }, 120_000);

  it.each([
    { mode: 'kernel cancellation', eventBus: 'acp=1', cancel: true },
    { mode: 'kernel error', eventBus: 'acp=1', cancel: false },
    { mode: 'shared error', eventBus: '0', cancel: false },
  ])(
    'reports an unknown outcome with a settled sibling still in a post-tool hook ($mode)',
    async ({ eventBus, cancel }) => {
      sourceEnv['QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP'] = 'acp=1';
      sourceEnv['QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP'] = eventBus;
      const { ready, release } = await holdReadFilePostHook();
      const sessionId = await newSession();
      const marker = path.join(workspace, 'worker.txt');
      turns.push(
        {
          toolCalls: [
            { name: 'run_shell_command', args: recordWorker(marker) },
          ],
        },
        { text: 'READY' },
      );
      expect((await prompt(sessionId)).stopReason).toBe('end_turn');
      const worker = await readWorker(marker);
      const fifo = path.join(workspace, 'wait.fifo');
      execFileSync('mkfifo', [fifo]);
      const file = path.join(workspace, 'fixture.txt');
      await writeFile(file, 'fixture');
      turns.push({
        toolCalls: [
          { name: 'read_file', args: { file_path: file } },
          {
            name: 'run_shell_command',
            args: {
              command: `cat ${JSON.stringify(fifo)}`,
              description: 'Wait for the fixture',
            },
          },
        ],
      });
      const running = prompt(sessionId);
      const rejected = vi.fn();
      void running.catch(rejected);
      const unknownOutcome = {
        data: { errorKind: 'managed_runtime_outcome_unknown' },
      };
      try {
        await waitFor(() => existsSync(ready) || undefined);
        await waitFor(
          () =>
            descendantArgs(worker.pid).some((args) => args.includes(fifo)) ||
            undefined,
        );
        process.kill(worker.pid, 'SIGKILL');
        const cancelling = cancel
          ? bridge!.cancelSession(sessionId)
          : undefined;
        void cancelling?.catch(() => undefined);
        const error = await waitFor(() => rejected.mock.calls[0]?.[0], 13_000);
        expect(error).toMatchObject(unknownOutcome);
        await cancelling;
        const requestsBefore = modelRequests.length;
        await expect(prompt(sessionId)).rejects.toMatchObject(unknownOutcome);
        expect(modelRequests).toHaveLength(requestsBefore);
      } finally {
        if (isAlive(worker.pid)) process.kill(worker.pid, 'SIGKILL');
        await writeFile(release, '');
        await running.catch(() => undefined);
      }
    },
    120_000,
  );

  it('stops the worker and its command when the Managed child dies', async () => {
    const sessionId = await newSession();
    const shellOut = path.join(workspace, 'shell.txt');
    const sleeper = path.join(workspace, 'sleeper.pid');
    turns.push({
      toolCalls: [
        {
          name: 'run_shell_command',
          args: recordWorker(
            shellOut,
            `; echo $$ > ${JSON.stringify(sleeper)}; exec sleep 120`,
          ),
        },
      ],
    });
    const running = prompt(sessionId);
    void running.catch(() => undefined);
    const worker = await readWorker(shellOut);
    const sleepPid = Number(
      await waitFor(
        async () =>
          (await readFile(sleeper, 'utf8').catch(() => '')).trim() || undefined,
      ),
    );
    strayPids.push(sleepPid);

    // Kill only the Managed child: no shutdown of its own runs, and the
    // worker sits in a process group of its own.
    process.kill(worker.parent, 'SIGKILL');
    await waitFor(() =>
      !isAlive(worker.pid) && !isAlive(sleepPid) ? true : undefined,
    );
    await expect(running).rejects.toThrow();
    // M5c.3's first half: the worker's disconnect-driven close swept its
    // ledger too — the file is gone with the groups it named, not left
    // behind for a later child's startup sweep.
    await waitFor(async () =>
      (await managedRuntimeLedgerFiles()).length === 0 ? true : undefined,
    );
  }, 120_000);

  it('blocks the session when a call outcome cannot be learned', async () => {
    const sessionId = await newSession();
    const shellOut = path.join(workspace, 'shell.txt');
    const sleeper = path.join(workspace, 'sleeper.pid');
    const laterWrite = path.join(workspace, 'later.txt');
    const updates: SessionUpdate[] = [];
    turns.push({
      toolCalls: [
        {
          name: 'run_shell_command',
          args: recordWorker(
            shellOut,
            `; echo $$ > ${JSON.stringify(sleeper)}; exec sleep 120`,
          ),
        },
        {
          name: 'write_file',
          args: { file_path: laterWrite, content: 'must not run' },
        },
      ],
    });
    const running = prompt(sessionId, updates);
    void running.catch(() => undefined);
    const worker = await readWorker(shellOut);
    const sleepPid = Number(
      await waitFor(
        async () =>
          (await readFile(sleeper, 'utf8').catch(() => '')).trim() || undefined,
      ),
    );
    strayPids.push(sleepPid);
    const requestsBefore = modelRequests.length;

    // The worker dies mid-call: whether the command took effect is unknown.
    process.kill(worker.pid, 'SIGKILL');
    const unknownOutcome = {
      data: { errorKind: 'managed_runtime_outcome_unknown' },
    };
    await expect(running).rejects.toMatchObject(unknownOutcome);
    const toolUpdates = updates.filter(
      (update) =>
        update.sessionUpdate === 'tool_call' ||
        update.sessionUpdate === 'tool_call_update',
    );
    const runningShell = toolUpdates.find(
      (update) =>
        update.status === 'in_progress' &&
        update._meta?.['toolName'] === 'run_shell_command',
    );
    expect(runningShell).toBeDefined();
    const shellStatuses = toolUpdates
      .filter(({ toolCallId }) => toolCallId === runningShell?.toolCallId)
      .map(({ status }) => status);
    expect(shellStatuses).not.toContain('failed');
    expect(shellStatuses).not.toContain('completed');
    // The model was not asked to continue with an invented result, and the
    // session refuses another turn.
    expect(modelRequests).toHaveLength(requestsBefore);
    turns.push({ text: 'SHOULD_NOT_RUN' });
    await expect(prompt(sessionId)).rejects.toMatchObject(unknownOutcome);
    expect(modelRequests).toHaveLength(requestsBefore);

    await bridge!.closeSession(sessionId);
    // The durable form of the block: admitted before dispatch, never settled,
    // and the log answers nothing for it.
    const blockedLog = await readManagedLog(sessionId);
    const events = blockedLog
      .trim()
      .split('\n')
      .map(
        (line) =>
          (
            JSON.parse(line) as {
              managedSession?: { kind: string; payload: { role?: string } };
            }
          ).managedSession,
      );
    expect(
      events.filter((event) => event?.kind === 'tool.intent'),
    ).toHaveLength(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: 'tool.receipt' }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'message.committed',
        payload: expect.objectContaining({ role: 'tool_result' }),
      }),
    );
    expect(existsSync(laterWrite)).toBe(false);
    expect(blockedLog).toContain('"durable_wait"');
  }, 120_000);

  /** The ledger files any worker of this project left behind. */
  async function managedRuntimeLedgerFiles(): Promise<string[]> {
    const found: string[] = [];
    const tmpRoot = path.join(root, 'runtime', 'tmp');
    for (const entry of await readdir(tmpRoot).catch(() => [] as string[])) {
      const directory = path.join(tmpRoot, entry, 'managed-runtime');
      for (const file of await readdir(directory).catch(() => [] as string[])) {
        found.push(path.join(directory, file));
      }
    }
    return found;
  }

  it('sweeps the worker ledger when the worker is killed mid-call', async () => {
    const sessionId = await newSession();
    const shellOut = path.join(workspace, 'shell.txt');
    const sleeper = path.join(workspace, 'sleeper.pid');
    turns.push({
      toolCalls: [
        {
          name: 'run_shell_command',
          args: recordWorker(
            shellOut,
            `; echo $$ > ${JSON.stringify(sleeper)}; exec sleep 120` +
              ' # intentional-sleep: hold the worker Shell for the crash witness',
          ),
        },
      ],
    });
    const running = prompt(sessionId);
    void running.catch(() => undefined);
    const worker = await readWorker(shellOut);
    const sleepPid = Number(
      await waitFor(
        async () =>
          (await readFile(sleeper, 'utf8').catch(() => '')).trim() || undefined,
      ),
    );
    strayPids.push(sleepPid);

    // While the Shell runs, its process group is durable on disk: the ledger
    // names it for whoever must sweep after a crash.
    const ledgerDuringRun = await waitFor(async () => {
      const files = await managedRuntimeLedgerFiles();
      return files.length > 0
        ? files.map((file) => path.basename(file))
        : undefined;
    });

    // Mid-call, the worker dies; answering for the call is impossible.
    process.kill(worker.pid, 'SIGKILL');
    await expect(running).rejects.toMatchObject({
      data: { errorKind: 'managed_runtime_outcome_unknown' },
    });

    // The ledger is swept: the worker's truth is gone once its groups are.
    expect(ledgerDuringRun).toHaveLength(1);
    await waitFor(async () => {
      const files = await managedRuntimeLedgerFiles();
      return files.length === 0 ? true : undefined;
    });
  }, 120_000);

  it('sweeps a stale worker ledger and its orphan group when the next child starts', async () => {
    // First, prove the engine boots and prompts over a clean ledger dir.
    const sessionId = await newSession();
    turns.push({ text: 'DONE' });
    expect((await prompt(sessionId)).stopReason).toBe('end_turn');

    // Debris left by a child and worker that both died: a ledger naming a
    // dead worker and a live orphaned Shell group that holds it.
    const orphan = spawn('sleep', ['300'], {
      detached: true,
      stdio: 'ignore',
    });
    orphan.unref();
    orphan.on('exit', () => undefined);
    if (orphan.pid === undefined) throw new Error('spawn failed');
    strayPids.push(orphan.pid);
    const ledgerDir = path.join(
      root,
      'runtime',
      'tmp',
      getProjectHash(workspace),
      'managed-runtime',
    );
    await mkdir(ledgerDir, { recursive: true });
    const workFile = path.join(ledgerDir, 'orphan-worker.json');
    testInternals.writeLedgerDocument(
      workFile,
      {
        pid: 42424242,
        pgid: 42424242,
        hostPid: 42424243,
        incarnation: 'incarnation-9',
        startedAt: Date.now(),
      },
      [
        {
          pgid: orphan.pid,
          callId: 'call-orphan',
          startedAt: Date.now(),
        },
      ],
    );

    // Nothing currently alive will deal with it, and the bridge goes down.
    await bridge!.shutdown();
    bridge = undefined;
    expect(existsSync(workFile)).toBe(true);
    expect(isAlive(orphan.pid)).toBe(true);

    // The next engine's first environment proves the ledger's truth before
    // any new Managed work runs.
    const sourceEnv: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    Object.assign(sourceEnv, {
      HOME: root,
      QWEN_HOME: path.join(root, 'config'),
      QWEN_RUNTIME_DIR: path.join(root, 'runtime'),
      QWEN_CLI_ENTRY: CLI_ENTRY,
      NODE_OPTIONS: `--import ${TSX_LOADER}`,
      TSX_TSCONFIG_PATH: CLI_TSCONFIG,
      OPENAI_API_KEY: 'm5-fixture-key',
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      NO_COLOR: '1',
    });
    bridge = createAcpSessionBridge({
      boundWorkspace: workspace,
      sessionScope: 'thread',
      channelIdleTimeoutMs: 0,
      initializeTimeoutMs: 60_000,
      executionEngines: {
        legacy: createSpawnChannelFactory({
          sourceEnv,
          processRegistry: registry,
        }),
        managed: createManagedEngineChannelFactory({
          sourceEnv,
          processRegistry: registry,
        }),
        select: () => 'managed',
      },
    });
    const restartedSessionId = await newSession();
    // The next engine runs a real tool call while the stale sweep may still
    // be pending: fresh Managed work is genuinely admitted inside that
    // window.
    turns.push(
      {
        toolCalls: [
          {
            name: 'read_file',
            args: { file_path: path.join(workspace, 'written-by-test.txt') },
          },
        ],
      },
      { text: 'DONE' },
    );
    await writeFile(path.join(workspace, 'written-by-test.txt'), 'seed\n');
    const restarted = await prompt(restartedSessionId);
    expect(restarted.stopReason).toBe('end_turn');
    // The debris is gone — its groups were swept by the new child's sweep
    // of its stale ledgers, and the live restarted worker's own ledger is
    // allowed to exist while its session stays open. The sweep is
    // fire-and-forget, so both postconditions are polled, not sampled once.
    await waitFor(async () =>
      (await managedRuntimeLedgerFiles()).includes(workFile) ? undefined : true,
    );
    await waitFor(() => (!isAlive(orphan.pid!) ? true : undefined));
    await bridge!.closeSession(restartedSessionId);
    expect(await managedRuntimeLedgerFiles()).toEqual([]);
  }, 120_000);
});
