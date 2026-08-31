/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  BackendAdaptor,
  BackendCapabilities,
  BackendEvent,
  BackendHandle,
  ContentBlock,
  PermissionDecision,
  PermissionOption,
  PromptReceipt,
  SessionSummary,
} from '../adaptor/types.js';
import type { LiveScreenContextCapture } from '../host/live-host-coordinator.js';
import type { LiveState } from '../host/types.js';
import type { SessionLog } from '../log/session-log.js';
import type {
  openQwenRealtimeSession,
  QwenRealtimeCallbacks,
  QwenRealtimeConfig,
  QwenRealtimeSession,
  RealtimeCloseInfo,
  RealtimeCloseOptions,
  RealtimeFunctionCallRef,
  RealtimeTranscriptEntry,
} from '../realtime/realtime-session.js';
import { LIVE_SESSION_TOOLS } from '../tools/definitions.js';
import { LiveSession } from './live-session.js';

const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: 'allow', kind: 'proceed' },
  { optionId: 'deny', kind: 'reject' },
];

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// -- test doubles -----------------------------------------------------------

/** Minimal push-driven async queue backing FakeAdaptor.events(). */
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.buffered.push(item);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          const value = this.buffered.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

class FakeAdaptor implements BackendAdaptor {
  readonly name = 'fake';
  busy = false;
  promptReceipt: PromptReceipt = { status: 'accepted', jobRef: 'p1' };
  summaries: SessionSummary[] = [];
  readonly queues = new Map<string, AsyncQueue<BackendEvent>>();
  private sessionSeq = 0;

  readonly createSession = vi.fn(
    async (_opts?: {
      cwd?: string;
      label?: string;
    }): Promise<BackendHandle> => ({
      id: `s${++this.sessionSeq}`,
      adaptor: this.name,
    }),
  );

  readonly prompt = vi.fn(
    async (
      _handle: BackendHandle,
      _blocks: readonly ContentBlock[],
      _opts?: { steer?: boolean },
    ): Promise<PromptReceipt> => this.promptReceipt,
  );

  readonly cancel = vi.fn(async (_handle: BackendHandle): Promise<void> => {});

  readonly respondPermission = vi.fn(
    async (
      _handle: BackendHandle,
      _requestId: string,
      _decision: PermissionDecision,
    ): Promise<'delivered' | 'already_resolved'> => 'delivered',
  );

  capabilities(): BackendCapabilities {
    return {
      steering: 'native',
      imageInput: true,
      permissionForwarding: true,
      proactiveSpeak: true,
      sessionList: true,
      eventDelivery: 'stream',
    };
  }

  async preflight(): Promise<void> {}

  async listSessions(): Promise<SessionSummary[]> {
    return this.summaries;
  }

  events(handle: BackendHandle): AsyncIterable<BackendEvent> {
    return this.queue(handle.id);
  }

  isBusy(_handle: BackendHandle): boolean {
    return this.busy;
  }

  async close(): Promise<void> {}

  queue(backendId: string): AsyncQueue<BackendEvent> {
    let queue = this.queues.get(backendId);
    if (!queue) {
      queue = new AsyncQueue<BackendEvent>();
      this.queues.set(backendId, queue);
    }
    return queue;
  }
}

/**
 * FakeAdaptor whose events() hands out one stream per subscription: the
 * first can be ended (without session_closed) to simulate a dropped SSE
 * stream; the pump must resubscribe and land on the second.
 */
class ResubscribeAdaptor extends FakeAdaptor {
  readonly streams = [
    new AsyncQueue<BackendEvent>(),
    new AsyncQueue<BackendEvent>(),
  ];
  eventsCalls = 0;

  override events(): AsyncIterable<BackendEvent> {
    const stream = this.streams[
      Math.min(this.eventsCalls, this.streams.length - 1)
    ] as AsyncQueue<BackendEvent>;
    this.eventsCalls += 1;
    return stream;
  }
}

function createFakeHost(capture: LiveScreenContextCapture) {
  const states: Array<Exclude<LiveState, 'unavailable' | 'idle'>> = [];
  return {
    states,
    setCallState: vi.fn(
      (
        _epoch: number,
        state: Exclude<LiveState, 'unavailable' | 'idle'>,
      ): boolean => {
        states.push(state);
        return true;
      },
    ),
    setCoordinator: vi.fn(
      (
        _epoch: number,
        _locator: { workspaceCwd: string; sessionId: string },
      ): boolean => true,
    ),
    sendOutputAudio: vi.fn(
      (_epoch: number, _pcm16: Uint8Array): boolean => true,
    ),
    clearOutput: vi.fn((_epoch: number): void => {}),
    setCaption: vi.fn((_epoch: number, _caption: string): boolean => true),
    setStatusText: vi.fn(
      (_epoch: number, _statusText?: string): boolean => true,
    ),
    setTranscript: vi.fn(
      (_epoch: number, _transcript: string): boolean => true,
    ),
    failCall: vi.fn((_epoch: number, _message?: string): boolean => true),
    captureScreenContext: vi.fn(
      async (_callerSessionId: string): Promise<LiveScreenContextCapture> =>
        capture,
    ),
  };
}

function createFakeRealtime() {
  return {
    callEpoch: 1,
    closed: new Promise<RealtimeCloseInfo>(() => {}),
    pushAudio: vi.fn((_pcm16: Uint8Array): boolean => true),
    commitInputAudio: vi.fn((): boolean => true),
    clearInputAudio: vi.fn((): boolean => true),
    cancelResponse: vi.fn((): boolean => true),
    submitFunctionOutput: vi.fn(
      (_ref: RealtimeFunctionCallRef, _output: string): boolean => true,
    ),
    sendBackendContext: vi.fn((_text: string): boolean => true),
    speakToUser: vi.fn((_message: string): boolean => true),
    takeTranscriptTail: vi.fn((): readonly RealtimeTranscriptEntry[] => []),
    close: vi.fn((_options?: RealtimeCloseOptions): void => {}),
  };
}

type FakeRealtime = ReturnType<typeof createFakeRealtime>;

// -- rig ---------------------------------------------------------------------

let tempDir: string;
let pngPath: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'qwen-live-session-test-'));
  pngPath = join(tempDir, 'shot.png');
  // A real (if tiny) PNG signature so image blocks carry non-empty bytes.
  await writeFile(
    pngPath,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

interface Rig {
  session: LiveSession;
  adaptor: FakeAdaptor;
  host: ReturnType<typeof createFakeHost>;
  realtime: FakeRealtime;
  config: QwenRealtimeConfig;
  callbacks: QwenRealtimeCallbacks;
}

async function startSession(adaptorArg?: FakeAdaptor): Promise<Rig> {
  const adaptor = adaptorArg ?? new FakeAdaptor();
  const host = createFakeHost({
    appName: 'Safari',
    windowTitle: 'Docs',
    accessibilityText: 'visible text',
    screenshotPath: pngPath,
  });
  const realtime = createFakeRealtime();
  let config: QwenRealtimeConfig | undefined;
  let callbacks: QwenRealtimeCallbacks = {};
  const openRealtime: typeof openQwenRealtimeSession = (cfg, cbs = {}) => {
    config = cfg;
    callbacks = cbs;
    return Promise.resolve(realtime as unknown as QwenRealtimeSession);
  };
  const session = new LiveSession({
    host,
    adaptor,
    realtime: {
      endpoint: 'https://dashscope.example.com',
      model: 'qwen-omni-turbo-realtime',
      voice: 'Cherry',
    },
    log: { write: vi.fn(), close: async () => {} } as unknown as SessionLog,
    openRealtime,
  });
  await session.start({ epoch: 1, callId: 'call-1', mode: 'new' });
  if (!config) throw new Error('openRealtime was not called');
  return { session, adaptor, host, realtime, config, callbacks };
}

let callSeq = 0;

function callTool(
  callbacks: QwenRealtimeCallbacks,
  name: string,
  args: Record<string, unknown>,
  activeTranscript: readonly RealtimeTranscriptEntry[] = [],
): void {
  callSeq += 1;
  callbacks.onFunctionCall?.({
    callEpoch: 1,
    responseId: `resp_${callSeq}`,
    callId: `fc_${callSeq}`,
    name,
    arguments: JSON.stringify(args),
    activeTranscript,
  });
}

function receipts(realtime: FakeRealtime): Array<Record<string, unknown>> {
  return realtime.submitFunctionOutput.mock.calls.map(
    ([, output]) => JSON.parse(output) as Record<string, unknown>,
  );
}

async function awaitReceipts(
  realtime: FakeRealtime,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  await vi.waitFor(() => {
    expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(count);
  });
  return receipts(realtime);
}

// -- tests --------------------------------------------------------------------

describe('LiveSession', () => {
  it('start opens the realtime session with the live tool surface and walks starting → listening', async () => {
    const { config, host } = await startSession();

    expect(config.tools).toBe(LIVE_SESSION_TOOLS);
    expect(config.instructions.length).toBeGreaterThan(0);
    expect(host.states).toEqual(['starting', 'listening']);
  });

  it('handoff creates a default session and prompts with the task plus voice context', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'fix tests' }, [
      { role: 'user', text: 'please fix the failing tests' },
    ]);
    const [receipt] = await awaitReceipts(realtime, 1);

    expect(adaptor.createSession).toHaveBeenCalledTimes(1);
    expect(adaptor.prompt).toHaveBeenCalledTimes(1);
    const blocks = adaptor.prompt.mock.calls[0]?.[1];
    expect(blocks).toBeDefined();
    const text = blocks?.[0];
    if (text?.type !== 'text') throw new Error('expected a leading text block');
    expect(text.text).toContain('fix tests');
    expect(text.text).toContain('<recent_voice_context>');
    expect(text.text).toContain('please fix the failing tests');
    expect(receipt).toMatchObject({
      status: 'accepted',
      job: 'job_1',
      session: 'session_1',
    });
  });

  it('handoff to a busy session steers instead of prompting fresh', async () => {
    const { adaptor, callbacks, realtime } = await startSession();
    adaptor.busy = true;

    callTool(callbacks, 'handoff', { task: 'also run lint' });
    await awaitReceipts(realtime, 1);

    expect(adaptor.prompt.mock.calls[0]?.[2]).toEqual({ steer: true });
  });

  it('a steer that joined the running turn reuses that job instead of orphaning it', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'run the tests' });
    const [first] = await awaitReceipts(realtime, 1);
    expect(first).toMatchObject({ job: 'job_1', session: 'session_1' });
    adaptor.queue('s1').push({ type: 'turn_started', jobRef: 'p1' });

    // The backend joins the steer to the running turn: same jobRef back.
    adaptor.busy = true;
    adaptor.promptReceipt = {
      status: 'accepted',
      jobRef: 'p1',
      joinedActiveTurn: true,
      note: 'joined the currently running task',
    };
    callTool(callbacks, 'handoff', { task: 'also run lint' });
    const [, second] = await awaitReceipts(realtime, 2);
    expect(second).toMatchObject({ job: 'job_1', session: 'session_1' });

    // One job only — and the turn's completion retires it.
    adaptor.queue('s1').push({
      type: 'turn_complete',
      jobRef: 'p1',
      summary: 'all done.',
    });
    await vi.waitFor(() => {
      expect(realtime.sendBackendContext).toHaveBeenCalledTimes(1);
    });
    adaptor.busy = false;
    callTool(callbacks, 'session_monitor', { session: 'session_1' });
    const [, , monitor] = await awaitReceipts(realtime, 3);
    expect(monitor).toEqual({
      status: 'ok',
      session: 'session_1',
      state: 'idle',
    });
  });

  it('handoff attaches appshot-registered assets as image blocks', async () => {
    const { adaptor, callbacks, host, realtime } = await startSession();

    callTool(callbacks, 'appshot', {});
    const [appshotReceipt] = await awaitReceipts(realtime, 1);
    expect(host.captureScreenContext).toHaveBeenCalledTimes(1);
    expect(appshotReceipt).toMatchObject({
      status: 'ok',
      app: 'Safari',
      window: 'Docs',
      asset: 'asset_1',
    });

    callTool(callbacks, 'handoff', {
      task: 'describe this window',
      input_refs: ['asset_1'],
    });
    await awaitReceipts(realtime, 2);

    const blocks = adaptor.prompt.mock.calls[0]?.[1];
    expect(blocks).toHaveLength(2);
    const image = blocks?.[1];
    if (image?.type !== 'image') throw new Error('expected an image block');
    expect(image.mimeType).toBe('image/png');
    expect(image.data.byteLength).toBeGreaterThan(0);
  });

  it('session_list returns handles and states for backend sessions', async () => {
    const { adaptor, callbacks, realtime } = await startSession();
    adaptor.summaries = [
      {
        handle: { id: 'a', adaptor: 'fake' },
        label: 'One',
        cwd: '/tmp/a',
        state: 'idle',
      },
      { handle: { id: 'b', adaptor: 'fake' }, state: 'busy' },
    ];

    callTool(callbacks, 'session_list', {});
    const [receipt] = await awaitReceipts(realtime, 1);

    expect(receipt).toMatchObject({ status: 'ok' });
    expect(receipt?.['sessions']).toEqual([
      { handle: 'session_1', label: 'One', cwd: '/tmp/a', state: 'idle' },
      { handle: 'session_2', state: 'busy' },
    ]);
  });

  it('session_stop cancels the backend turn and marks the job cancelled', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'long task' });
    await awaitReceipts(realtime, 1);

    callTool(callbacks, 'session_stop', { job: 'job_1' });
    const [, stopReceipt] = await awaitReceipts(realtime, 2);

    expect(adaptor.cancel).toHaveBeenCalledTimes(1);
    expect(stopReceipt).toMatchObject({
      status: 'cancelling',
      session: 'session_1',
    });

    callTool(callbacks, 'session_monitor', { job: 'job_1' });
    const [, , monitorReceipt] = await awaitReceipts(realtime, 3);
    expect(monitorReceipt).toMatchObject({
      job: 'job_1',
      job_state: 'cancelled',
    });
  });

  it('injects turn_complete and turn_error events as context plus speech', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'run the tests' });
    await awaitReceipts(realtime, 1);
    const queue = adaptor.queue('s1');

    queue.push({
      type: 'turn_complete',
      jobRef: 'p1',
      summary: 'done: all tests pass',
    });
    await vi.waitFor(() => {
      expect(realtime.sendBackendContext).toHaveBeenCalledTimes(1);
    });
    expect(realtime.sendBackendContext.mock.calls[0]?.[0]).toMatch(
      /^\[COMPLETE job_1\]/,
    );
    expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    expect(realtime.speakToUser.mock.calls[0]?.[0]).toContain('job_1');

    queue.push({ type: 'turn_error', jobRef: 'p1', error: 'lint exploded' });
    await vi.waitFor(() => {
      expect(realtime.sendBackendContext).toHaveBeenCalledTimes(2);
    });
    expect(realtime.sendBackendContext.mock.calls[1]?.[0]).toMatch(
      /^\[ERROR job_1\]/,
    );
  });

  it('routes permission requests to the voice and relays the answer back', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'clean tmp' });
    await awaitReceipts(realtime, 1);
    const queue = adaptor.queue('s1');

    queue.push({
      type: 'permission_request',
      requestId: 'r1',
      title: 'Bash: rm -rf /tmp',
      options: PERMISSION_OPTIONS,
    });
    await vi.waitFor(() => {
      expect(realtime.sendBackendContext).toHaveBeenCalledTimes(1);
    });
    expect(realtime.sendBackendContext.mock.calls[0]?.[0]).toContain(
      '[PERMISSION req_1]',
    );
    expect(realtime.speakToUser).toHaveBeenCalledTimes(1);

    callTool(callbacks, 'respond_permission', {
      request_id: 'req_1',
      decision: 'allow',
    });
    const [, respondReceipt] = await awaitReceipts(realtime, 2);

    expect(adaptor.respondPermission).toHaveBeenCalledTimes(1);
    const [, requestId, decision] =
      adaptor.respondPermission.mock.calls[0] ?? [];
    expect(requestId).toBe('r1');
    expect(decision).toBe('allow');
    expect(respondReceipt).toEqual({ status: 'delivered' });
  });

  it('relays a respond_permission note to the backend session after the vote', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'clean tmp' });
    await awaitReceipts(realtime, 1);
    adaptor.queue('s1').push({
      type: 'permission_request',
      requestId: 'r1',
      title: 'Bash: rm -rf /tmp',
      options: PERMISSION_OPTIONS,
    });
    await vi.waitFor(() => {
      expect(realtime.sendBackendContext).toHaveBeenCalledTimes(1);
    });

    adaptor.busy = true;
    callTool(callbacks, 'respond_permission', {
      request_id: 'req_1',
      decision: 'allow',
      note: 'only the cache subfolder',
    });
    const [, respondReceipt] = await awaitReceipts(realtime, 2);

    expect(respondReceipt).toEqual({ status: 'delivered' });
    expect(adaptor.respondPermission).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }),
      'r1',
      'allow',
    );
    // The vote channel has no note field: the constraint rides the prompt
    // path to the same session, steered into the running turn.
    expect(adaptor.prompt).toHaveBeenCalledTimes(2);
    const [handle, blocks, opts] = adaptor.prompt.mock.calls[1] ?? [];
    expect(handle).toEqual(expect.objectContaining({ id: 's1' }));
    const text = blocks?.[0];
    if (text?.type !== 'text') throw new Error('expected a text block');
    expect(text.text).toContain('only the cache subfolder');
    expect(text.text).toContain('Bash: rm -rf /tmp');
    expect(opts).toEqual({ steer: true });
  });

  it('delivers a note-less respond_permission without a follow-up prompt', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'clean tmp' });
    await awaitReceipts(realtime, 1);
    adaptor.queue('s1').push({
      type: 'permission_request',
      requestId: 'r1',
      title: 'Bash: rm -rf /tmp',
      options: PERMISSION_OPTIONS,
    });
    await vi.waitFor(() => {
      expect(realtime.sendBackendContext).toHaveBeenCalledTimes(1);
    });

    callTool(callbacks, 'respond_permission', {
      request_id: 'req_1',
      decision: 'deny',
    });
    const [, respondReceipt] = await awaitReceipts(realtime, 2);

    expect(respondReceipt).toEqual({ status: 'delivered' });
    // Only the handoff prompt — no constraint relay was needed.
    expect(adaptor.prompt).toHaveBeenCalledTimes(1);
  });

  it('retracts a queued permission ask resolved elsewhere before injection', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'clean tmp' });
    await awaitReceipts(realtime, 1);
    const queue = adaptor.queue('s1');

    // Close the injection window: a realtime response is in flight.
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'resp_open',
      authority: 'direct',
    });

    queue.push({
      type: 'permission_request',
      requestId: 'r2',
      title: 'Bash: rm -rf /tmp',
      options: PERMISSION_OPTIONS,
    });
    await delay(30);
    expect(realtime.sendBackendContext).not.toHaveBeenCalled();

    // Resolved from the WebShell before the voice ever asked.
    queue.push({ type: 'permission_resolved', requestId: 'r2', byUs: false });
    await delay(30);

    // Reopen the window: the retracted ask must not surface.
    callbacks.onResponseDone?.({ callEpoch: 1, responseId: 'resp_open' });
    await delay(50);
    expect(realtime.sendBackendContext).not.toHaveBeenCalled();
    expect(realtime.speakToUser).not.toHaveBeenCalled();
  });

  it('barge-in clears the host output', async () => {
    const { callbacks, host } = await startSession();

    callbacks.onBargeIn?.({ callEpoch: 1, responseId: 'resp_x' });

    expect(host.clearOutput).toHaveBeenCalledTimes(1);
  });

  it('stop resolves immediately when no response is in flight', async () => {
    const { realtime, session } = await startSession();

    const outcome = await session.stop({ epoch: 1, callId: 'call-1' });

    expect(outcome).toBeUndefined();
    expect(realtime.close).toHaveBeenCalledTimes(1);
  });

  it('stop waits for the in-flight response to settle', async () => {
    const { callbacks, realtime, session } = await startSession();

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'resp_1',
      authority: 'direct',
    });

    let settled = false;
    const pending = session
      .stop({ epoch: 1, callId: 'call-1' })
      .then((outcome) => {
        settled = true;
        return outcome;
      });
    await delay(150);
    expect(settled).toBe(false);

    callbacks.onResponseDone?.({ callEpoch: 1, responseId: 'resp_1' });
    await vi.waitFor(
      () => {
        expect(settled).toBe(true);
      },
      { timeout: 3_000, interval: 100 },
    );
    expect(await pending).toBeUndefined();
    expect(realtime.close).toHaveBeenCalledTimes(1);
  });

  it('stop drain settles on the input-commit ack instead of burning the budget', async () => {
    // Default drain budget: 30 s. The commit ack must settle the stop in
    // milliseconds — resolving only at the deadline is the bug.
    const { callbacks, realtime, session } = await startSession();

    callbacks.onSpeechStarted?.({ callEpoch: 1 });

    let settled = false;
    const pending = session
      .stop({ epoch: 1, callId: 'call-1' })
      .then((outcome) => {
        settled = true;
        return outcome;
      });
    expect(realtime.commitInputAudio).toHaveBeenCalledTimes(1);
    await delay(150);
    expect(settled).toBe(false);

    callbacks.onInputCommitted?.({ callEpoch: 1 });
    await vi.waitFor(
      () => {
        expect(settled).toBe(true);
      },
      { timeout: 2_000, interval: 50 },
    );
    expect(await pending).toBeUndefined();
    expect(realtime.close).toHaveBeenCalledTimes(1);
  });

  it('stop fails fast when the trailing speech cannot be committed', async () => {
    const { callbacks, realtime, session } = await startSession();
    realtime.commitInputAudio.mockReturnValue(false);

    callbacks.onSpeechStarted?.({ callEpoch: 1 });
    const outcome = await session.stop({ epoch: 1, callId: 'call-1' });

    expect(outcome).toEqual({
      error: 'Live Voice could not commit the final spoken input.',
    });
  });

  it('keeps the call state at stopping when response.created arrives during the drain', async () => {
    const { callbacks, host, session } = await startSession();

    callbacks.onSpeechStarted?.({ callEpoch: 1 });
    let settled = false;
    const pending = session
      .stop({ epoch: 1, callId: 'call-1' })
      .then((outcome) => {
        settled = true;
        return outcome;
      });
    callbacks.onInputCommitted?.({ callEpoch: 1 });

    // semantic_vad create_response: the committed trailing speech spawns a
    // response mid-drain. It must hold the drain open, but never flip the
    // coordinator back to 'speaking' — that would strand the stopping call.
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'resp_tail',
      authority: 'direct',
    });
    expect(host.states[host.states.length - 1]).toBe('stopping');
    await delay(150);
    expect(settled).toBe(false);

    callbacks.onResponseDone?.({ callEpoch: 1, responseId: 'resp_tail' });
    await vi.waitFor(
      () => {
        expect(settled).toBe(true);
      },
      { timeout: 2_000, interval: 50 },
    );
    expect(await pending).toBeUndefined();
    expect(host.states).not.toContain('speaking');
  });

  it('speaks error strings with mid-token periods untruncated', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'read config' });
    await awaitReceipts(realtime, 1);
    const queue = adaptor.queue('s1');

    queue.push({
      type: 'turn_error',
      jobRef: 'p1',
      error: 'ENOENT: open /home/user/.qwen-live/config.json',
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });
    expect(realtime.speakToUser.mock.calls[0]?.[0]).toContain(
      '/home/user/.qwen-live/config.json',
    );

    queue.push({
      type: 'turn_error',
      jobRef: 'p1',
      error: 'Connection refused: 10.0.0.1:4170',
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(2);
    });
    expect(realtime.speakToUser.mock.calls[1]?.[0]).toContain('10.0.0.1:4170');
  });

  it('speaks the closing sentence of a long CJK summary', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: '跑测试' });
    await awaitReceipts(realtime, 1);

    // >200 chars, multiple sentences, no whitespace after 。 (standard CJK
    // typography): the spoken line must be the LAST sentence, complete.
    const body = `${'任务进行中'.repeat(50)}。`;
    const closing = '所有测试都通过了。';
    adaptor.queue('s1').push({
      type: 'turn_complete',
      jobRef: 'p1',
      summary: `${body}${closing}`,
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });
    expect(realtime.speakToUser.mock.calls[0]?.[0]).toBe(
      `Task job_1 finished. ${closing}`,
    );
  });

  it('resubscribes after the event stream ends without session_closed', async () => {
    const adaptor = new ResubscribeAdaptor();
    const { callbacks, realtime } = await startSession(adaptor);

    callTool(callbacks, 'handoff', { task: 'long task' });
    await awaitReceipts(realtime, 1);
    expect(adaptor.eventsCalls).toBe(1);

    // The stream drops without a session_closed (daemon restart, broken
    // SSE connection) — the session must not go permanently unobserved.
    adaptor.streams[0]?.end();
    adaptor.streams[1]?.push({
      type: 'turn_complete',
      jobRef: 'p1',
      summary: 'all tests pass.',
    });

    await vi.waitFor(
      () => {
        expect(realtime.sendBackendContext).toHaveBeenCalledTimes(1);
      },
      { timeout: 5_000, interval: 100 },
    );
    expect(realtime.sendBackendContext.mock.calls[0]?.[0]).toMatch(
      /^\[COMPLETE job_1\]/,
    );
    expect(adaptor.eventsCalls).toBe(2);
  }, 10_000);

  it('pushAudio forwards frames to realtime but not while stopping', async () => {
    const { callbacks, realtime, session } = await startSession();

    const frame = Buffer.from([1, 2]);
    expect(
      session.pushAudio({ epoch: 1, callId: 'call-1', pcm16: frame }),
    ).toBe(true);
    expect(realtime.pushAudio).toHaveBeenCalledTimes(1);
    expect(realtime.pushAudio).toHaveBeenCalledWith(frame);

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'resp_1',
      authority: 'direct',
    });
    const stopPending = session.stop({ epoch: 1, callId: 'call-1' });

    expect(
      session.pushAudio({ epoch: 1, callId: 'call-1', pcm16: frame }),
    ).toBe(true);
    expect(realtime.pushAudio).toHaveBeenCalledTimes(1);

    callbacks.onResponseDone?.({ callEpoch: 1, responseId: 'resp_1' });
    await stopPending;
  });
});
