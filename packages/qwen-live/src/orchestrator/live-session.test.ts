/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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
import { BackendRegistry } from '../adaptor/registry.js';
import { AsyncEventQueue } from '../adaptor/async-event-queue.js';
import { displayLiveMessage, liveMessage } from '../i18n/messages.js';
import { DEFAULT_PROACTIVE_CONFIG, type ProactiveConfig } from '../config.js';
import type { LiveVisualCapture } from '../host/live-host-coordinator.js';
import type { LiveState, LiveVisualInput } from '../host/types.js';
import type { SessionLog } from '../log/session-log.js';
import type { SubagentsSnapshot } from '../subagents/types.js';
import { LiveLogger } from '../logger.js';
import { resolveMemoryConfig } from '../memory/config.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';
import { MEMORY_SYSTEM_PROMPT } from '../memory/tools.js';
import {
  ProactiveScheduler,
  type ProactiveDelivery,
  type ProactiveSchedulerControl,
  type ProactiveSchedulerOptions,
} from '../proactive/scheduler.js';
import type { ProactiveTask } from '../proactive/task-manager.js';
import {
  QwenRealtimeError,
  type openQwenRealtimeSession,
  type QwenRealtimeCallbacks,
  type QwenRealtimeConfig,
  type QwenRealtimeSession,
  type RealtimeCloseInfo,
  type RealtimeCloseOptions,
  type RealtimeFunctionCallRef,
  type RealtimeTranscriptEntry,
} from '../realtime/realtime-session.js';
import {
  CANCEL_PROACTIVE_TASK_TOOL_NAME,
  CREATE_LIVE_NARRATION_TOOL_NAME,
  CREATE_PROACTIVE_MONITOR_TOOL_NAME,
  CREATE_PROACTIVE_TIMER_TOOL_NAME,
  LIST_PROACTIVE_TASKS_TOOL_NAME,
  LIVE_SESSION_TOOLS,
  PROACTIVE_SESSION_TOOLS,
  UPDATE_PROACTIVE_TASK_TOOL_NAME,
} from '../tools/definitions.js';
import { LiveSession } from './live-session.js';
import { buildLiveInstructions } from '../realtime/instructions.js';

const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: 'allow', kind: 'proceed' },
  { optionId: 'deny', kind: 'reject' },
];
const DEFAULT_VISUAL_INPUT: LiveVisualInput = {
  source: 'screen',
  mode: 'on-demand',
  fps: 1,
  liveWidth: 1280,
  liveHeight: 720,
};
const TEST_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

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
  constructor(readonly name = 'fake') {}
  busy = false;
  promptReceipt: PromptReceipt = { status: 'accepted', jobRef: 'p1' };
  summaries: SessionSummary[] = [];
  readonly queues = new Map<string, AsyncEventQueue<BackendEvent>>();
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
  readonly cancelJob = vi.fn(
    async (
      _handle: BackendHandle,
      _jobRef: string,
    ): Promise<'stopping' | 'stopped' | 'not_found'> => 'stopping',
  );

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

  events(
    handle: BackendHandle,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<BackendEvent> {
    return this.queue(handle.id).subscribe({
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  isBusy(_handle: BackendHandle): boolean {
    return this.busy;
  }

  async close(): Promise<void> {}

  queue(backendId: string): AsyncEventQueue<BackendEvent> {
    let queue = this.queues.get(backendId);
    if (!queue) {
      queue = new AsyncEventQueue<BackendEvent>();
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

function createFakeHost(capture: LiveVisualCapture) {
  const states: Array<Exclude<LiveState, 'unavailable' | 'idle'>> = [];
  let outputMuted = false;
  return {
    states,
    setOutputMuted: (muted: boolean): void => {
      outputMuted = muted;
    },
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
    finishOutputAudio: vi.fn((_epoch: number): void => {}),
    isOutputMuted: vi.fn((): boolean => outputMuted),
    clearOutput: vi.fn((_epoch: number): void => {}),
    setCaption: vi.fn((_epoch: number, _caption: string): boolean => true),
    setStatusText: vi.fn(
      (_epoch: number, _statusText?: string): boolean => true,
    ),
    setTranscript: vi.fn(
      (_epoch: number, _transcript: string): boolean => true,
    ),
    failCall: vi.fn((_epoch: number, _message?: string): boolean => true),
    captureVisualContext: vi.fn(
      async (
        _callerSessionId: string,
        _options?: { persistAsset?: boolean; screenScope?: 'display' },
      ): Promise<LiveVisualCapture> => capture,
    ),
  };
}

function createFakeRealtime() {
  return {
    callEpoch: 1,
    closed: new Promise<RealtimeCloseInfo>(() => {}),
    configure: vi.fn(
      (_update: Parameters<QwenRealtimeSession['configure']>[0]): boolean =>
        true,
    ),
    pushAudio: vi.fn((_pcm16: Uint8Array): boolean => true),
    pushImage: vi.fn((_jpegBase64: string): boolean => true),
    commitInputAudio: vi.fn((): boolean => true),
    clearInputAudio: vi.fn((): boolean => true),
    cancelResponse: vi.fn((): boolean => true),
    submitFunctionOutput: vi.fn(
      (_ref: RealtimeFunctionCallRef, _output: string): boolean => true,
    ),
    sendBackendContext: vi.fn((_text: string): boolean => true),
    speakToUser: vi.fn((_message: string): boolean => true),
    respondToProactiveEvent: vi.fn((_event: string): boolean => true),
    requestProactiveRepair: vi.fn(
      (_instruction: string, _allowedToolNames: readonly string[]): boolean =>
        true,
    ),
    takeTranscriptTail: vi.fn((): readonly RealtimeTranscriptEntry[] => []),
    close: vi.fn((_options?: RealtimeCloseOptions): void => {}),
  };
}

type FakeRealtime = ReturnType<typeof createFakeRealtime>;

interface StartSessionOptions {
  logger?: LiveLogger;
  visualInput?: LiveVisualInput;
  capture?: LiveVisualCapture;
  proactive?: ProactiveConfig;
  memory?: MemoryService;
  onSubagentsChanged?: (snapshot: SubagentsSnapshot) => void;
  createProactiveScheduler?: (
    options: ProactiveSchedulerOptions,
  ) => ProactiveSchedulerControl;
}

const MONITOR_TASK: ProactiveTask = {
  taskId: 'task-monitor',
  title: 'Watch posture',
  taskType: 'perception_monitor',
  status: 'running',
  monitorMode: 'event',
  repeat: true,
  generation: 1,
  createdAt: 1,
  updatedAt: 1,
  triggerCount: 0,
  failureCount: 0,
  modalities: ['vision', 'audio'],
  taskDescription: 'The user starts slouching.',
  interventionText: 'Remind the user to sit upright.',
};

const NARRATION_TASK: ProactiveTask = {
  ...MONITOR_TASK,
  taskId: 'task-narration',
  title: 'Narrate the workspace',
  monitorMode: 'always',
  taskDescription: 'Meaningful workspace changes.',
  interventionText: 'Brief English narration.',
};

const TIMER_TASK: ProactiveTask = {
  taskId: 'task-timer',
  title: 'Tea timer',
  taskType: 'time_reminder',
  status: 'running',
  monitorMode: 'event',
  repeat: false,
  generation: 1,
  createdAt: 1,
  updatedAt: 1,
  triggerCount: 0,
  failureCount: 0,
  durationSec: 300,
  reminderText: 'The tea is ready.',
  remainingSec: 240,
};

const UPDATED_TASK: ProactiveTask = {
  ...MONITOR_TASK,
  title: 'Watch desk posture',
  repeat: false,
  generation: 2,
};

const CANCELLED_TASK: ProactiveTask = {
  ...TIMER_TASK,
  status: 'cancelled',
};

class FakeProactiveScheduler implements ProactiveSchedulerControl {
  activeTasks: ProactiveTask[] = [MONITOR_TASK, TIMER_TASK];

  readonly createPerceptionMonitor = vi.fn(
    (
      _input: Parameters<
        ProactiveSchedulerControl['createPerceptionMonitor']
      >[0],
    ): ProactiveTask => MONITOR_TASK,
  );
  readonly createLiveNarration = vi.fn(
    (
      _input: Parameters<ProactiveSchedulerControl['createLiveNarration']>[0],
    ): ProactiveTask => NARRATION_TASK,
  );
  readonly createTimer = vi.fn(
    (
      _input: Parameters<ProactiveSchedulerControl['createTimer']>[0],
    ): ProactiveTask => TIMER_TASK,
  );
  readonly updateTask = vi.fn(
    (
      _input: Parameters<ProactiveSchedulerControl['updateTask']>[0],
    ): ProactiveTask => UPDATED_TASK,
  );
  readonly cancelTasks = vi.fn(
    (
      _selector: Parameters<ProactiveSchedulerControl['cancelTasks']>[0],
    ): ProactiveTask[] => [CANCELLED_TASK],
  );
  readonly cancelTaskById = vi.fn(
    (_taskId: string): ProactiveTask | undefined => CANCELLED_TASK,
  );
  readonly listTasks = vi.fn((): ProactiveTask[] => this.activeTasks);
  readonly feedAudio = vi.fn((_pcm16: Uint8Array): void => {});
  readonly feedImage = vi.fn((_jpegBase64: string): void => {});
  readonly resetVisualSource = vi.fn((): void => {});
  readonly announcementStarted = vi.fn(
    (_delivery: ProactiveDelivery): void => {},
  );
  readonly deferDelivery = vi.fn(
    (_delivery: ProactiveDelivery): boolean => true,
  );
  readonly acknowledgeDelivery = vi.fn(
    (_delivery: ProactiveDelivery): void => {},
  );
  readonly failDelivery = vi.fn(
    (_delivery: ProactiveDelivery, _error: string): void => {},
  );
  readonly dispose = vi.fn((): void => {});
}

function createProactiveHarness(): {
  scheduler: FakeProactiveScheduler;
  createScheduler: ReturnType<typeof vi.fn>;
  options: () => ProactiveSchedulerOptions;
} {
  const scheduler = new FakeProactiveScheduler();
  let schedulerOptions: ProactiveSchedulerOptions | undefined;
  const createScheduler = vi.fn(
    (options: ProactiveSchedulerOptions): ProactiveSchedulerControl => {
      schedulerOptions = options;
      return scheduler;
    },
  );
  return {
    scheduler,
    createScheduler,
    options: () => {
      if (!schedulerOptions) throw new Error('scheduler was not created');
      return schedulerOptions;
    },
  };
}

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
  log: { write: ReturnType<typeof vi.fn>; close: () => Promise<void> };
  config: QwenRealtimeConfig;
  callbacks: QwenRealtimeCallbacks;
  currentCallbacks: () => QwenRealtimeCallbacks;
}

async function startSession(
  adaptorArg?: FakeAdaptor | FakeAdaptor[],
  options: StartSessionOptions = {},
): Promise<Rig & { secondary?: FakeAdaptor }> {
  const adaptor: FakeAdaptor =
    adaptorArg === undefined
      ? new FakeAdaptor()
      : Array.isArray(adaptorArg)
        ? (adaptorArg[0] as FakeAdaptor)
        : adaptorArg;
  const secondary: FakeAdaptor | undefined = Array.isArray(adaptorArg)
    ? adaptorArg[1]
    : undefined;
  const host = createFakeHost(
    options.capture ?? {
      source: 'screen',
      image: TEST_JPEG,
      width: 1280,
      height: 720,
      appName: 'Safari',
      windowTitle: 'Docs',
      accessibilityText: 'visible text',
      screenshotPath: pngPath,
    },
  );
  const realtime = createFakeRealtime();
  let config: QwenRealtimeConfig | undefined;
  let callbacks: QwenRealtimeCallbacks = {};
  const openRealtime: typeof openQwenRealtimeSession = (cfg, cbs = {}) => {
    config = cfg;
    callbacks = cbs;
    return Promise.resolve(realtime as unknown as QwenRealtimeSession);
  };
  const log = { write: vi.fn(), close: async () => {} };
  const session = new LiveSession({
    host,
    registry: new BackendRegistry(
      secondary
        ? [
            { adaptor, isDefault: true },
            { adaptor: secondary, isDefault: false },
          ]
        : [{ adaptor, isDefault: true }],
    ),
    realtime: {
      endpoint: 'https://dashscope.example.com',
      model: 'qwen-omni-turbo-realtime',
      voice: 'Cherry',
    },
    log: log as unknown as SessionLog,
    ...(options.logger ? { logger: options.logger } : {}),
    openRealtime,
    ...(options.proactive ? { proactive: options.proactive } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.onSubagentsChanged
      ? { onSubagentsChanged: options.onSubagentsChanged }
      : {}),
    ...(options.createProactiveScheduler
      ? { createProactiveScheduler: options.createProactiveScheduler }
      : {}),
  });
  await session.start({
    epoch: 1,
    callId: 'call-1',
    mode: 'new',
    visualInput: options.visualInput ?? DEFAULT_VISUAL_INPUT,
  });
  if (!config) throw new Error('openRealtime was not called');
  return {
    session,
    adaptor,
    ...(secondary ? { secondary } : {}),
    host,
    realtime,
    log,
    config,
    callbacks,
    currentCallbacks: () => callbacks,
  };
}

let callSeq = 0;

function callTool(
  callbacks: QwenRealtimeCallbacks,
  name: string,
  args: Record<string, unknown>,
  activeTranscript: readonly RealtimeTranscriptEntry[] = [],
): void {
  callToolForResponse(
    callbacks,
    `resp_${callSeq}`,
    name,
    args,
    activeTranscript,
  );
}

function callToolForResponse(
  callbacks: QwenRealtimeCallbacks,
  responseId: string,
  name: string,
  args: Record<string, unknown>,
  activeTranscript: readonly RealtimeTranscriptEntry[] = [],
): void {
  callSeq += 1;
  callbacks.onFunctionCall?.({
    callEpoch: 1,
    responseId,
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

describe('standalone subagent controls', () => {
  it('signals unassigned approvals in the summary, getter and page even without a task or call', async () => {
    const updates: SubagentsSnapshot[] = [];
    const { session, adaptor, callbacks, realtime } = await startSession(
      undefined,
      { onSubagentsChanged: (snapshot) => updates.push(snapshot) },
    );
    try {
      callTool(callbacks, 'session_create', {});
      await awaitReceipts(realtime, 1);
      await session.stop({ epoch: 1, callId: 'call-1' });
      adaptor.queue('s1').push({
        type: 'permission_request',
        requestId: 'unassigned',
        title: 'Real waiting operation',
        options: PERMISSION_OPTIONS,
      });
      await vi.waitFor(() =>
        expect(session.getSubagentsSnapshot()).toMatchObject({
          counts: { needsAttention: 0 },
          tasks: [],
          pendingUnassignedPermissions: 1,
        }),
      );
      await vi.waitFor(() =>
        expect(updates.at(-1)?.pendingUnassignedPermissions).toBe(1),
      );
      expect(
        await session.handleSubagentsRequest({ action: 'list' }),
      ).toMatchObject({
        type: 'page',
        page: { snapshot: { pendingUnassignedPermissions: 1 } },
      });
      expect(
        await session.handleSubagentsRequest({
          action: 'permission',
          requestHandle: 'req_1',
          decision: 'deny',
        }),
      ).toMatchObject({ outcome: 'denied' });
      expect(session.getSubagentsSnapshot().pendingUnassignedPermissions).toBe(
        0,
      );
      await vi.waitFor(() =>
        expect(updates.at(-1)?.pendingUnassignedPermissions).toBe(0),
      );
      expect(realtime.speakToUser).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it('keeps a real pending permission visible after its terminal task detail is evicted', async () => {
    const { session, adaptor, callbacks, realtime } = await startSession();
    try {
      for (let index = 0; index < 33; index += 1) {
        const jobRef = `terminal-${index}`;
        adaptor.promptReceipt = { status: 'accepted', jobRef };
        callTool(callbacks, 'handoff', { task: `Terminal task ${index}` });
        await awaitReceipts(realtime, index + 1);
        if (index === 0)
          adaptor.queue('s1').push({
            type: 'permission_request',
            jobRef,
            requestId: 'still-pending',
            title: 'Unresolved file operation',
            options: PERMISSION_OPTIONS,
          });
        adaptor
          .queue('s1')
          .push({ type: 'turn_complete', jobRef, summary: 'Finished' });
        await vi.waitFor(() =>
          expect(session.getSubagentsSnapshot().counts.completed).toBe(
            index + 1,
          ),
        );
      }
      const result = await session.handleSubagentsRequest({
        action: 'list',
        selectedId: 'harness:job_1',
      });
      expect(result.type).toBe('page');
      if (result.type !== 'page') throw new Error('No page');
      expect(result.page.selected).toBeUndefined();
      expect(result.page.unassignedPermissions).toMatchObject([
        {
          requestHandle: 'req_1',
          backend: 'fake',
          sessionId: 'session_1',
          title: 'Unresolved file operation',
        },
      ]);
      expect(
        await session.handleSubagentsRequest({
          action: 'permission',
          requestHandle: 'req_1',
          decision: 'deny',
        }),
      ).toMatchObject({ outcome: 'denied' });
      expect(adaptor.respondPermission).toHaveBeenCalledExactlyOnceWith(
        { id: 's1', adaptor: 'fake' },
        'still-pending',
        'deny',
      );
    } finally {
      session.dispose();
    }
  });

  it('does not invent approvals for filesystem failures or allow an incomplete request', async () => {
    const { session, adaptor, callbacks, realtime } = await startSession();
    try {
      callTool(callbacks, 'handoff', { task: 'Write a file' });
      await awaitReceipts(realtime, 1);
      await session.stop({ epoch: 1, callId: 'call-1' });
      adaptor.queue('s1').push({
        type: 'turn_error',
        jobRef: 'p1',
        error: 'Filesystem denied access',
      });
      await vi.waitFor(() =>
        expect(session.getSubagentsSnapshot().tasks[0]?.status).toBe('failed'),
      );
      expect(
        await session.handleSubagentsRequest({
          action: 'list',
          selectedId: 'harness:job_1',
        }),
      ).toMatchObject({
        type: 'page',
        page: { selected: { permissions: [] }, unassignedPermissions: [] },
      });
      adaptor.queue('s1').push({
        type: 'permission_request',
        requestId: 'long',
        title: 'command '.repeat(600),
        options: PERMISSION_OPTIONS,
      });
      await vi.waitFor(async () =>
        expect(
          await session.handleSubagentsRequest({ action: 'list' }),
        ).toMatchObject({
          type: 'page',
          page: {
            unassignedPermissions: [
              {
                requestHandle: 'req_1',
                backend: 'fake',
                sessionId: 'session_1',
                titleTruncated: true,
                choices: [{ decision: 'deny' }],
              },
            ],
          },
        }),
      );
      expect(
        await session.handleSubagentsRequest({
          action: 'permission',
          requestHandle: 'req_1',
          decision: 'allow',
        }),
      ).toMatchObject({ type: 'error', code: 'permission_unavailable' });
      expect(adaptor.respondPermission).not.toHaveBeenCalled();
      expect(
        await session.handleSubagentsRequest({
          action: 'permission',
          requestHandle: 'req_1',
          decision: 'deny',
        }),
      ).toMatchObject({ outcome: 'denied' });
    } finally {
      session.dispose();
    }
  });

  it('stops an exact job once, preserves requested versus terminal state, and rejects stale IDs', async () => {
    const { session, adaptor, callbacks, realtime } = await startSession();
    try {
      callTool(callbacks, 'handoff', { task: 'First task' });
      await awaitReceipts(realtime, 1);
      const list = await session.handleSubagentsRequest({
        action: 'list',
        selectedId: 'harness:job_1',
      });
      expect(list).toMatchObject({
        type: 'page',
        page: {
          selected: { id: 'harness:job_1', canStop: true, permissions: [] },
        },
      });
      const request = { action: 'stop', taskId: 'harness:job_1' } as const;
      expect(
        await Promise.all([
          session.handleSubagentsRequest(request),
          session.handleSubagentsRequest(request),
        ]),
      ).toEqual([
        { type: 'outcome', outcome: 'stopping', taskId: request.taskId },
        { type: 'outcome', outcome: 'stopping', taskId: request.taskId },
      ]);
      expect(adaptor.cancelJob).toHaveBeenCalledTimes(1);
      expect(session.getSubagentsSnapshot().tasks[0]?.status).not.toBe(
        'cancelled',
      );
      expect(
        await session.handleSubagentsRequest({ action: 'list' }),
      ).toMatchObject({
        type: 'page',
        page: {
          snapshot: { tasks: [{ canStop: false, stopReason: 'stopping' }] },
        },
      });
      adaptor
        .queue('s1')
        .push({ type: 'turn_error', jobRef: 'p1', error: 'cancelled' });
      await vi.waitFor(() =>
        expect(session.getSubagentsSnapshot().tasks[0]?.status).toBe(
          'cancelled',
        ),
      );
      const texts = realtime.sendBackendContext.mock.calls.map(
        ([text]) => text,
      );
      expect(texts.filter((text) => text.includes('SUBAGENT_CONTROL'))).toEqual(
        [
          '[SUBAGENT_CONTROL harness:job_1] Stop requested. Awaiting backend terminal confirmation.',
          '[SUBAGENT_CONTROL harness:job_1] Backend confirmed cancellation.',
        ],
      );
      adaptor.promptReceipt = { status: 'accepted', jobRef: 'p2' };
      callTool(callbacks, 'handoff', { task: 'Replacement task' });
      await awaitReceipts(realtime, 2);
      expect(await session.handleSubagentsRequest(request)).toMatchObject({
        outcome: 'already_ended',
      });
      expect(
        await session.handleSubagentsRequest({
          action: 'stop',
          taskId: 'harness:missing',
        }),
      ).toMatchObject({ type: 'error', code: 'not_found' });
      callTool(callbacks, 'session_stop', {
        job: 'missing',
        session: 'session_1',
      });
      expect((await awaitReceipts(realtime, 3))[2]).toMatchObject({
        status: 'error',
      });
      expect(adaptor.cancelJob).toHaveBeenCalledTimes(1);
      expect(adaptor.cancel).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it('retains complete silent receipts across hangup and a refused resumed transport', async () => {
    const { session, adaptor, callbacks, realtime } = await startSession();
    try {
      callTool(callbacks, 'handoff', { task: 'Offline task' });
      await awaitReceipts(realtime, 1);
      await session.stop({ epoch: 1, callId: 'call-1' });
      await session.handleSubagentsRequest({
        action: 'stop',
        taskId: 'harness:job_1',
      });
      adaptor
        .queue('s1')
        .push({ type: 'turn_error', jobRef: 'p1', error: 'cancelled' });
      await vi.waitFor(() =>
        expect(session.getSubagentsSnapshot().tasks[0]?.status).toBe(
          'cancelled',
        ),
      );
      expect(realtime.sendBackendContext).not.toHaveBeenCalled();
      realtime.sendBackendContext.mockReturnValue(false);
      await session.start({
        epoch: 2,
        callId: 'call-2',
        mode: 'resume',
        visualInput: DEFAULT_VISUAL_INPUT,
      });
      expect(realtime.sendBackendContext).toHaveBeenCalled();
      expect(realtime.speakToUser).not.toHaveBeenCalled();
      await session.stop({ epoch: 2, callId: 'call-2' });
      realtime.sendBackendContext.mockClear().mockReturnValue(true);
      await session.start({
        epoch: 3,
        callId: 'call-3',
        mode: 'resume',
        visualInput: DEFAULT_VISUAL_INPUT,
      });
      expect(
        realtime.sendBackendContext.mock.calls.map(([text]) => text),
      ).toEqual([
        '[SUBAGENT_CONTROL harness:job_1] Stop requested. Awaiting backend terminal confirmation.',
        '[SUBAGENT_CONTROL harness:job_1] Backend confirmed cancellation.',
      ]);
      await session.stop({ epoch: 3, callId: 'call-3' });
      realtime.sendBackendContext.mockClear();
      await session.start({
        epoch: 4,
        callId: 'call-4',
        mode: 'resume',
        visualInput: DEFAULT_VISUAL_INPUT,
      });
      expect(realtime.sendBackendContext).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it('reports completion racing a stop without claiming cancellation', async () => {
    const { session, adaptor, callbacks, realtime } = await startSession();
    try {
      callTool(callbacks, 'handoff', { task: 'Race task' });
      await awaitReceipts(realtime, 1);
      adaptor.cancelJob.mockImplementation(async () => {
        adaptor.queue('s1').push({
          type: 'turn_complete',
          jobRef: 'p1',
          summary: 'Actually completed',
        });
        await delay(10);
        return 'stopping';
      });
      expect(
        await session.handleSubagentsRequest({
          action: 'stop',
          taskId: 'harness:job_1',
        }),
      ).toMatchObject({ outcome: 'already_ended' });
      expect(session.getSubagentsSnapshot().tasks[0]?.status).toBe('completed');
      expect(
        realtime.sendBackendContext.mock.calls.map(([text]) => text),
      ).toEqual([
        '[SUBAGENT_CONTROL harness:job_1] Stop requested. Awaiting backend terminal confirmation.',
        '[SUBAGENT_CONTROL harness:job_1] Backend reported completion after the stop request; cancellation was not confirmed.',
      ]);
    } finally {
      session.dispose();
    }
  });

  it('keeps real permission choices exact and unassigned requests separate after hangup', async () => {
    const { session, adaptor, callbacks, realtime } = await startSession();
    try {
      callTool(callbacks, 'handoff', { task: 'Permission task' });
      await awaitReceipts(realtime, 1);
      await session.stop({ epoch: 1, callId: 'call-1' });
      const queue = adaptor.queue('s1');
      queue.push({
        type: 'permission_request',
        jobRef: 'p1',
        requestId: 'real',
        title: 'Write fixture',
        options: [
          { optionId: 'always', kind: 'proceed', escalation: 'always' },
          { optionId: 'deny', kind: 'reject', escalation: 'once' },
        ],
      });
      queue.push({
        type: 'permission_request',
        requestId: 'unassigned',
        title: 'Unassigned operation',
        options: [{ optionId: 'unknown', kind: 'other' }],
      });
      await vi.waitFor(async () =>
        expect(
          await session.handleSubagentsRequest({
            action: 'list',
            selectedId: 'harness:job_1',
          }),
        ).toMatchObject({
          type: 'page',
          page: {
            selected: {
              permissions: [
                {
                  requestHandle: 'req_1',
                  choices: [
                    { decision: 'allow', scope: 'always' },
                    { decision: 'deny', scope: 'once' },
                  ],
                },
              ],
            },
            unassignedPermissions: [{ requestHandle: 'req_2', choices: [] }],
          },
        }),
      );
      expect(
        await session.handleSubagentsRequest({
          action: 'permission',
          requestHandle: 'req_2',
          decision: 'allow',
        }),
      ).toMatchObject({ type: 'error', code: 'permission_unavailable' });
      expect(
        await session.handleSubagentsRequest({
          action: 'permission',
          requestHandle: 'req_1',
          decision: 'deny',
        }),
      ).toMatchObject({
        type: 'outcome',
        outcome: 'denied',
        requestHandle: 'req_1',
      });
      expect(adaptor.respondPermission).toHaveBeenCalledExactlyOnceWith(
        { id: 's1', adaptor: 'fake' },
        'real',
        'deny',
      );
      expect(
        await session.handleSubagentsRequest({
          action: 'permission',
          requestHandle: 'req_1',
          decision: 'allow',
        }),
      ).toMatchObject({ type: 'error', code: 'permission_unavailable' });
      expect(adaptor.respondPermission).toHaveBeenCalledTimes(1);
      expect(realtime.speakToUser).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it('stops a Proactive ID without touching its same-title replacement', async () => {
    const { session, callbacks, realtime } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
    });
    try {
      const input = {
        title: 'Timer',
        duration_sec: 600,
        reminder_text: 'Ready',
      };
      callTool(callbacks, CREATE_PROACTIVE_TIMER_TOOL_NAME, input);
      await vi.waitFor(() =>
        expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(1),
      );
      const original = session.getSubagentsSnapshot().tasks[0]!;
      expect(
        await session.handleSubagentsRequest({
          action: 'stop',
          taskId: original.id,
        }),
      ).toMatchObject({ outcome: 'stopped' });
      callTool(callbacks, CREATE_PROACTIVE_TIMER_TOOL_NAME, input);
      await vi.waitFor(() =>
        expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(2),
      );
      expect(
        await session.handleSubagentsRequest({
          action: 'stop',
          taskId: original.id,
        }),
      ).toMatchObject({ outcome: 'already_ended' });
      const replacement = session
        .getSubagentsSnapshot()
        .tasks.find((task) => task.id !== original.id);
      expect(replacement?.status).toBe('monitoring');
    } finally {
      session.dispose();
    }
  });
});

describe('runtime review reproductions', () => {
  it('R2-8 trusts an exact message acknowledgement instead of a conflicting active-ref snapshot in the receipt', async () => {
    const { session, adaptor, callbacks, realtime, log } = await startSession();
    try {
      let finish!: (value: PromptReceipt) => void;
      adaptor.prompt.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      callTool(callbacks, 'handoff', { task: 'Joined task' });
      await vi.waitFor(() => expect(adaptor.prompt).toHaveBeenCalledOnce());
      adaptor.queue('s1').push({
        type: 'turn_joined',
        messageId: 'message',
        jobRef: 'correct-turn',
      });
      adaptor.queue('s1').push({
        type: 'turn_complete',
        jobRef: 'correct-turn',
        summary: 'Correct result',
      });
      adaptor
        .queue('s1')
        .push({ type: 'turn_started', jobRef: 'unrelated-next-turn' });
      await vi.waitFor(() =>
        expect(log.write).toHaveBeenCalledWith(
          'backend.event',
          expect.objectContaining({
            type: 'turn_started',
            jobRef: 'unrelated-next-turn',
          }),
        ),
      );
      finish({
        status: 'accepted',
        joinedActiveTurn: true,
        joinedMessageId: 'message',
        jobRef: 'unrelated-next-turn',
      });
      await awaitReceipts(realtime, 1);
      expect(session.getSubagentsSnapshot().counts.completed).toBe(1);
      expect(session.getSubagentsSnapshot().tasks[0]).toMatchObject({
        status: 'completed',
        output: 'Correct result',
      });
      callTool(callbacks, 'session_stop', { job: 'job_1' });
      await awaitReceipts(realtime, 2);
      expect(adaptor.cancelJob).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it.each(['before', 'after'] as const)(
    'R2-8 follows the exact message ID when an undrained join is promoted %s its receipt',
    async (timing) => {
      const { session, adaptor, callbacks, realtime, log } =
        await startSession();
      try {
        let finish!: (value: PromptReceipt) => void;
        adaptor.prompt.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        callTool(callbacks, 'handoff', { task: 'Promoted task' });
        await vi.waitFor(() => expect(adaptor.prompt).toHaveBeenCalledOnce());
        const events = () => {
          adaptor
            .queue('s1')
            .push({ type: 'turn_started', jobRef: 'promoted-message' });
          adaptor.queue('s1').push({
            type: 'turn_complete',
            jobRef: 'promoted-message',
            summary: 'Promoted result',
          });
        };
        if (timing === 'before') {
          events();
          await vi.waitFor(() =>
            expect(log.write).toHaveBeenCalledWith(
              'backend.event',
              expect.objectContaining({ type: 'turn_complete' }),
            ),
          );
        }
        finish({
          status: 'accepted',
          joinedActiveTurn: true,
          joinedMessageId: 'promoted-message',
        });
        await awaitReceipts(realtime, 1);
        if (timing === 'after') events();
        await vi.waitFor(() =>
          expect(session.getSubagentsSnapshot().counts.completed).toBe(1),
        );
        expect(session.getSubagentsSnapshot().tasks[0]).toMatchObject({
          status: 'completed',
          output: 'Promoted result',
        });
      } finally {
        session.dispose();
      }
    },
  );

  it('R2-8 preserves a promised joined handle after its late acknowledgement aliases an existing task', async () => {
    const { session, adaptor, callbacks, realtime } = await startSession();
    try {
      callTool(callbacks, 'handoff', { task: 'Original task' });
      await awaitReceipts(realtime, 1);
      adaptor.promptReceipt = {
        status: 'accepted',
        joinedActiveTurn: true,
        joinedMessageId: 'late-known-join',
      };
      callTool(callbacks, 'handoff', { task: 'Additional instruction' });
      const receipts = await awaitReceipts(realtime, 2);
      expect(receipts[1]).toMatchObject({ job: 'job_2' });
      adaptor.queue('s1').push({
        type: 'turn_joined',
        messageId: 'late-known-join',
        jobRef: 'p1',
      });
      await vi.waitFor(() =>
        expect(session.getSubagentsSnapshot().tasks).toHaveLength(1),
      );
      expect(session.getSubagentsSnapshot().tasks[0]).toMatchObject({
        id: 'harness:job_1',
        request: 'Original task',
        status: 'running',
      });
      callTool(callbacks, 'session_stop', { job: 'job_2' });
      await awaitReceipts(realtime, 3);
      expect(adaptor.cancelJob).toHaveBeenCalledWith(
        { id: 's1', adaptor: 'fake' },
        'p1',
      );
      adaptor
        .queue('s1')
        .push({ type: 'turn_error', jobRef: 'p1', error: 'cancelled' });
      await vi.waitFor(() =>
        expect(session.getSubagentsSnapshot().counts.cancelled).toBe(1),
      );
      expect(session.getSubagentsSnapshot().counts.completed).toBe(0);
      expect(session.getSubagentsSnapshot().tasks).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });

  it('R2-8 reuses duplicate message acknowledgements without orphaning the first promised handle', async () => {
    const { session, adaptor, callbacks, realtime } = await startSession();
    try {
      adaptor.promptReceipt = {
        status: 'accepted',
        joinedActiveTurn: true,
        joinedMessageId: 'same-join',
      };
      callTool(callbacks, 'handoff', { task: 'First instruction' });
      await awaitReceipts(realtime, 1);
      callTool(callbacks, 'handoff', { task: 'Retry same instruction' });
      const receipts = await awaitReceipts(realtime, 2);
      expect(receipts[0]).toMatchObject({ job: 'job_1' });
      expect(receipts[1]).toMatchObject({ job: 'job_1' });
      adaptor.queue('s1').push({
        type: 'turn_joined',
        messageId: 'same-join',
        jobRef: 'external',
      });
      adaptor
        .queue('s1')
        .push({ type: 'turn_complete', jobRef: 'external', summary: 'Result' });
      await vi.waitFor(() =>
        expect(session.getSubagentsSnapshot().counts.completed).toBe(1),
      );
      expect(session.getSubagentsSnapshot().tasks).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });

  it.each(['before', 'after'] as const)(
    'R2-8 isolates concurrent message identities when exact signals arrive %s their receipts',
    async (timing) => {
      const { session, adaptor, callbacks, realtime, log } =
        await startSession();
      try {
        callTool(callbacks, 'session_create', {});
        await awaitReceipts(realtime, 1);
        const finish: Array<(value: PromptReceipt) => void> = [];
        adaptor.prompt.mockImplementation(
          () => new Promise<PromptReceipt>((resolve) => finish.push(resolve)),
        );
        for (const task of ['First task', 'Second task'])
          callTool(callbacks, 'handoff', { session: 'session_1', task });
        await vi.waitFor(() => expect(finish).toHaveLength(2));
        const signals = () => {
          for (const suffix of ['one', 'two']) {
            adaptor.queue('s1').push({
              type: 'turn_joined',
              messageId: `message-${suffix}`,
              jobRef: `ref-${suffix}`,
            });
            adaptor.queue('s1').push({
              type: 'turn_complete',
              jobRef: `ref-${suffix}`,
              summary: `Result ${suffix}`,
            });
          }
        };
        if (timing === 'before') {
          signals();
          await vi.waitFor(() =>
            expect(log.write).toHaveBeenCalledWith(
              'backend.event',
              expect.objectContaining({
                type: 'turn_complete',
                jobRef: 'ref-two',
              }),
            ),
          );
        }
        finish[1]!({
          status: 'accepted',
          joinedActiveTurn: true,
          joinedMessageId: 'message-two',
        });
        finish[0]!({
          status: 'accepted',
          joinedActiveTurn: true,
          joinedMessageId: 'message-one',
        });
        await awaitReceipts(realtime, 3);
        if (timing === 'after') signals();
        await vi.waitFor(() =>
          expect(session.getSubagentsSnapshot().counts.completed).toBe(2),
        );
        expect(
          session
            .getSubagentsSnapshot()
            .tasks.map((task) => [task.request, task.output]),
        ).toEqual(
          expect.arrayContaining([
            ['First task', 'Result one'],
            ['Second task', 'Result two'],
          ]),
        );
      } finally {
        session.dispose();
      }
    },
  );

  it.each(['before', 'after'] as const)(
    'R2-8 rejects conflicting refs for one exact message %s the receipt',
    async (timing) => {
      const { session, adaptor, callbacks, realtime, log } =
        await startSession();
      try {
        let finish!: (receipt: PromptReceipt) => void;
        adaptor.prompt.mockImplementationOnce(
          () =>
            new Promise<PromptReceipt>((resolve) => {
              finish = resolve;
            }),
        );
        callTool(callbacks, 'handoff', { task: 'Join one task' });
        await vi.waitFor(() => expect(adaptor.prompt).toHaveBeenCalledOnce());
        const signals = () => {
          for (const jobRef of ['expected-ref', 'conflicting-ref'])
            adaptor
              .queue('s1')
              .push({ type: 'turn_joined', messageId: 'message', jobRef });
        };
        if (timing === 'before') {
          signals();
          await vi.waitFor(() =>
            expect(log.write).toHaveBeenCalledWith(
              'backend.event',
              expect.objectContaining({
                type: 'turn_joined',
                jobRef: 'conflicting-ref',
              }),
            ),
          );
        }
        finish({
          status: 'accepted',
          joinedActiveTurn: true,
          joinedMessageId: 'message',
        });
        await awaitReceipts(realtime, 1);
        if (timing === 'after') signals();
        adaptor.queue('s1').push({
          type: 'turn_complete',
          jobRef: 'conflicting-ref',
          summary: 'Wrong task',
        });
        await vi.waitFor(() =>
          expect(log.write).toHaveBeenCalledWith(
            'backend.event',
            expect.objectContaining({
              type: 'turn_complete',
              jobRef: 'conflicting-ref',
            }),
          ),
        );
        expect(session.getSubagentsSnapshot().counts.completed).toBe(0);
        adaptor.queue('s1').push({
          type: 'turn_complete',
          jobRef: 'expected-ref',
          summary: 'Expected task',
        });
        await vi.waitFor(() =>
          expect(log.write).toHaveBeenCalledWith(
            'backend.event',
            expect.objectContaining({
              type: 'turn_complete',
              jobRef: 'expected-ref',
            }),
          ),
        );
        expect(session.getSubagentsSnapshot().counts.completed).toBe(
          timing === 'after' ? 1 : 0,
        );
        expect(session.getSubagentsSnapshot().tasks[0]?.output).toBe(
          timing === 'after' ? 'Expected task' : '',
        );
      } finally {
        session.dispose();
      }
    },
  );

  it.each(['matching', 'missing', 'foreign'] as const)(
    'R2-8 attributes late lifecycle events only with a %s message acknowledgement',
    async (signal) => {
      const { session, adaptor, callbacks, realtime } = await startSession();
      try {
        adaptor.promptReceipt = {
          status: 'accepted',
          joinedActiveTurn: true,
          joinedMessageId: 'our-message',
        };
        callTool(callbacks, 'handoff', { task: 'Join external work' });
        await awaitReceipts(realtime, 1);
        if (signal !== 'missing')
          adaptor.queue('s1').push({
            type: 'turn_joined',
            messageId:
              signal === 'matching' ? 'our-message' : 'foreign-message',
            jobRef: 'late-external-turn',
          });
        adaptor.queue('s1').push({
          type: 'turn_started',
          jobRef: 'late-external-turn',
        });
        adaptor.queue('s1').push({
          type: 'turn_complete',
          jobRef: 'late-external-turn',
          summary: 'Late external result',
        });
        await vi.waitFor(() =>
          expect(realtime.sendBackendContext).toHaveBeenCalledWith(
            expect.stringMatching(
              /^\[COMPLETE (job_1|session_1)\] Late external result$/,
            ),
          ),
        );
        expect(session.getSubagentsSnapshot().counts.completed).toBe(
          signal === 'matching' ? 1 : 0,
        );
        expect(session.getSubagentsSnapshot().tasks[0]).toMatchObject({
          status: signal === 'matching' ? 'completed' : 'starting',
          output: signal === 'matching' ? 'Late external result' : '',
        });
      } finally {
        session.dispose();
      }
    },
  );

  it('R2-8 reuses a known joined turn even when it completes before the ref-less receipt', async () => {
    const { session, adaptor, callbacks, realtime, log } = await startSession();
    try {
      callTool(callbacks, 'handoff', { task: 'Original task' });
      await awaitReceipts(realtime, 1);
      let finish!: (value: PromptReceipt) => void;
      adaptor.prompt.mockImplementationOnce(
        () =>
          new Promise<PromptReceipt>((resolve) => {
            finish = resolve;
          }),
      );
      callTool(callbacks, 'handoff', {
        session: 'session_1',
        task: 'Additional instruction',
      });
      await vi.waitFor(() => expect(adaptor.prompt).toHaveBeenCalledTimes(2));
      adaptor.queue('s1').push({
        type: 'turn_joined',
        messageId: 'known-join',
        jobRef: 'p1',
      });
      adaptor.queue('s1').push({
        type: 'turn_complete',
        jobRef: 'p1',
        summary: 'Original result',
      });
      await vi.waitFor(() =>
        expect(log.write).toHaveBeenCalledWith(
          'backend.event',
          expect.objectContaining({ type: 'turn_complete' }),
        ),
      );
      finish({
        status: 'accepted',
        joinedActiveTurn: true,
        joinedMessageId: 'known-join',
      });
      const receipts = await awaitReceipts(realtime, 2);
      expect(receipts[1]).toMatchObject({ job: 'job_1' });
      const snapshot = session.getSubagentsSnapshot();
      expect(snapshot.counts.completed).toBe(1);
      expect(snapshot.tasks).toHaveLength(1);
      expect(snapshot.tasks[0]).toMatchObject({
        request: 'Original task',
        status: 'completed',
        output: 'Original result',
      });
    } finally {
      session.dispose();
    }
  });

  it('R2-8 does not guess a joined receipt identity from multiple observed refs', async () => {
    const { session, adaptor, callbacks, realtime, log } = await startSession();
    try {
      let finish!: (value: PromptReceipt) => void;
      adaptor.prompt.mockImplementationOnce(
        () =>
          new Promise<PromptReceipt>((resolve) => {
            finish = resolve;
          }),
      );
      callTool(callbacks, 'handoff', { task: 'Uncertain joined task' });
      await vi.waitFor(() => expect(adaptor.prompt).toHaveBeenCalledOnce());
      for (const jobRef of ['earlier', 'later'])
        adaptor.queue('s1').push({
          type: 'turn_complete',
          jobRef,
          summary: `Result ${jobRef}`,
        });
      await vi.waitFor(() =>
        expect(log.write).toHaveBeenCalledWith(
          'backend.event',
          expect.objectContaining({ jobRef: 'later' }),
        ),
      );
      finish({ status: 'accepted', joinedActiveTurn: true });
      await awaitReceipts(realtime, 1);
      expect(session.getSubagentsSnapshot().counts.completed).toBe(0);
      expect(session.getSubagentsSnapshot().tasks[0]).toMatchObject({
        status: 'starting',
        output: '',
      });
    } finally {
      session.dispose();
    }
  });

  it('R2-8 does not reuse an already completed job from a replay during another joined submission', async () => {
    const { session, adaptor, callbacks, realtime, log } = await startSession();
    try {
      callTool(callbacks, 'handoff', { task: 'Completed earlier' });
      await awaitReceipts(realtime, 1);
      adaptor.queue('s1').push({
        type: 'turn_complete',
        jobRef: 'p1',
        summary: 'Earlier result',
      });
      await vi.waitFor(() =>
        expect(session.getSubagentsSnapshot().counts.completed).toBe(1),
      );
      let finish!: (value: PromptReceipt) => void;
      adaptor.prompt.mockImplementationOnce(
        () =>
          new Promise<PromptReceipt>((resolve) => {
            finish = resolve;
          }),
      );
      log.write.mockClear();
      callTool(callbacks, 'handoff', { task: 'Join a different task' });
      await vi.waitFor(() => expect(adaptor.prompt).toHaveBeenCalledTimes(2));
      adaptor.queue('s1').push({
        type: 'turn_complete',
        jobRef: 'p1',
        summary: 'Earlier result',
      });
      await vi.waitFor(() =>
        expect(log.write).toHaveBeenCalledWith(
          'backend.event',
          expect.objectContaining({ type: 'turn_complete' }),
        ),
      );
      finish({ status: 'accepted', joinedActiveTurn: true });
      const receipts = await awaitReceipts(realtime, 2);
      expect(receipts[1]).toMatchObject({ job: 'job_2' });
      expect(session.getSubagentsSnapshot().counts.completed).toBe(1);
      expect(session.getSubagentsSnapshot().tasks).toHaveLength(2);
      expect(session.getSubagentsSnapshot().tasks[0]).toMatchObject({
        request: 'Join a different task',
        status: 'starting',
        output: '',
      });
    } finally {
      session.dispose();
    }
  });

  it('R2-8 does not adopt a sole observed ref after overlapping submissions settle', async () => {
    const { session, adaptor, callbacks, realtime, log } = await startSession();
    try {
      callTool(callbacks, 'session_create', {});
      await awaitReceipts(realtime, 1);
      const finish: Array<(value: PromptReceipt) => void> = [];
      adaptor.prompt.mockImplementation(
        () => new Promise<PromptReceipt>((resolve) => finish.push(resolve)),
      );
      callTool(callbacks, 'handoff', {
        session: 'session_1',
        task: 'First request',
      });
      callTool(callbacks, 'handoff', {
        session: 'session_1',
        task: 'Second request',
      });
      await vi.waitFor(() => expect(finish).toHaveLength(2));
      adaptor.queue('s1').push({
        type: 'turn_complete',
        jobRef: 'external-turn',
        summary: 'Unattributed result',
      });
      await vi.waitFor(() =>
        expect(log.write).toHaveBeenCalledWith(
          'backend.event',
          expect.objectContaining({ jobRef: 'external-turn' }),
        ),
      );
      finish[0]!({ status: 'accepted', jobRef: 'known-turn' });
      await awaitReceipts(realtime, 2);
      finish[1]!({ status: 'accepted', joinedActiveTurn: true });
      await awaitReceipts(realtime, 3);
      expect(session.getSubagentsSnapshot().counts.completed).toBe(0);
      expect(session.getSubagentsSnapshot().tasks).toHaveLength(2);
      expect(
        session
          .getSubagentsSnapshot()
          .tasks.every((task) => task.output === ''),
      ).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it('R2-8 does not attribute a missing joined receipt to a different queued job that is cancelled', async () => {
    const { session, adaptor, callbacks, realtime, log } = await startSession();
    try {
      callTool(callbacks, 'handoff', { task: 'Running A' });
      await awaitReceipts(realtime, 1);
      adaptor.busy = true;
      adaptor.queue('s1').push({ type: 'turn_started', jobRef: 'p1' });
      await vi.waitFor(() =>
        expect(session.getSubagentsSnapshot().tasks[0]?.status).toBe('running'),
      );
      adaptor.promptReceipt = { status: 'queued', jobRef: 'p2' };
      callTool(callbacks, 'handoff', { task: 'Queued B' });
      await awaitReceipts(realtime, 2);
      let finish!: (value: PromptReceipt) => void;
      adaptor.prompt.mockImplementationOnce(
        () =>
          new Promise<PromptReceipt>((resolve) => {
            finish = resolve;
          }),
      );
      callTool(callbacks, 'handoff', { task: 'Join running A' });
      await vi.waitFor(() => expect(adaptor.prompt).toHaveBeenCalledTimes(3));
      adaptor.queue('s1').push({
        type: 'turn_error',
        jobRef: 'p2',
        error: 'cancelled',
      });
      await vi.waitFor(() =>
        expect(log.write).toHaveBeenCalledWith(
          'backend.event',
          expect.objectContaining({ type: 'turn_error', jobRef: 'p2' }),
        ),
      );
      finish({ status: 'accepted', joinedActiveTurn: true });
      const receipts = await awaitReceipts(realtime, 3);
      expect(receipts[2]).toMatchObject({ job: 'job_3' });
      const snapshot = session.getSubagentsSnapshot();
      expect(snapshot.tasks).toHaveLength(3);
      expect(
        snapshot.tasks.find((task) => task.id === 'harness:job_1'),
      ).toMatchObject({ status: 'running', request: 'Running A' });
      expect(
        snapshot.tasks.find((task) => task.id === 'harness:job_2'),
      ).toMatchObject({ status: 'cancelled', request: 'Queued B' });
      expect(
        snapshot.tasks.find((task) => task.id === 'harness:job_3'),
      ).toMatchObject({ status: 'starting', request: 'Join running A' });
    } finally {
      session.dispose();
    }
  });

  it('R2-8 attributes buffered external completion to a joined jobRef-less receipt', async () => {
    const { session, adaptor, callbacks, realtime, log } = await startSession();
    try {
      callTool(callbacks, 'session_create', {});
      await awaitReceipts(realtime, 1);
      let finish!: (value: PromptReceipt) => void;
      adaptor.prompt.mockImplementationOnce(
        () =>
          new Promise<PromptReceipt>((resolve) => {
            finish = resolve;
          }),
      );
      callTool(callbacks, 'handoff', {
        session: 'session_1',
        task: 'Join the externally started task',
      });
      await vi.waitFor(() => expect(adaptor.prompt).toHaveBeenCalledOnce());
      adaptor.queue('s1').push({
        type: 'turn_joined',
        messageId: 'external-join',
        jobRef: 'external-turn',
      });
      adaptor.queue('s1').push({
        type: 'turn_complete',
        jobRef: 'external-turn',
        summary: 'External result',
      });
      await vi.waitFor(() =>
        expect(log.write).toHaveBeenCalledWith(
          'backend.event',
          expect.objectContaining({ type: 'turn_complete' }),
        ),
      );
      finish({
        status: 'accepted',
        joinedActiveTurn: true,
        joinedMessageId: 'external-join',
      });
      await awaitReceipts(realtime, 2);
      await vi.waitFor(() =>
        expect(realtime.sendBackendContext).toHaveBeenCalledWith(
          expect.stringMatching(
            /^\[COMPLETE (job_1|session_1)\] External result$/,
          ),
        ),
      );
      const snapshot = session.getSubagentsSnapshot();
      expect(snapshot.counts.completed).toBe(1);
      expect(snapshot.tasks).toHaveLength(1);
      expect(snapshot.tasks[0]).toMatchObject({
        status: 'completed',
        output: 'External result',
      });
    } finally {
      session.dispose();
    }
  });

  it.each(['matching', 'missing', 'different', 'rejected', 'throws'] as const)(
    'R1-8 retains buffered external permission and completion for a %s receipt',
    async (outcome) => {
      const { session, adaptor, callbacks, realtime, log } =
        await startSession();
      try {
        callTool(callbacks, 'session_create', {});
        await awaitReceipts(realtime, 1);
        let finish!: (value: PromptReceipt) => void;
        let reject!: (error: Error) => void;
        adaptor.prompt.mockImplementationOnce(
          () =>
            new Promise<PromptReceipt>((resolve, fail) => {
              finish = resolve;
              reject = fail;
            }),
        );
        callTool(callbacks, 'handoff', {
          session: 'session_1',
          task: 'New requested task',
        });
        await vi.waitFor(() => expect(adaptor.prompt).toHaveBeenCalledOnce());
        adaptor.queue('s1').push({
          type: 'permission_request',
          jobRef: 'external-turn',
          requestId: 'external-permission',
          title: 'External task needs approval',
          options: PERMISSION_OPTIONS,
        });
        adaptor.queue('s1').push({
          type: 'turn_complete',
          jobRef: 'external-turn',
          summary: 'External result',
        });
        await vi.waitFor(() =>
          expect(log.write).toHaveBeenCalledWith(
            'backend.event',
            expect.objectContaining({ type: 'turn_complete' }),
          ),
        );
        expect(realtime.sendBackendContext).not.toHaveBeenCalled();
        if (outcome === 'throws') reject(new Error('prompt rejected'));
        else
          finish({
            status: outcome === 'rejected' ? 'rejected' : 'accepted',
            ...(outcome === 'matching' ? { jobRef: 'external-turn' } : {}),
            ...(outcome === 'different' ? { jobRef: 'new-turn' } : {}),
          });
        await awaitReceipts(realtime, 2);
        await delay(30);
        callTool(callbacks, 'respond_permission', {
          request_id: 'req_1',
          decision: 'allow',
        });
        const results = await awaitReceipts(realtime, 3);
        expect.soft(results[2]).toEqual({ status: 'delivered' });
        expect
          .soft(adaptor.respondPermission)
          .toHaveBeenCalledWith(
            { id: 's1', adaptor: 'fake' },
            'external-permission',
            'allow',
          );
        expect
          .soft(realtime.sendBackendContext)
          .toHaveBeenCalledWith(
            expect.stringMatching(
              /^\[COMPLETE (job_1|session_1)\] External result$/,
            ),
          );
        if (outcome === 'different' || outcome === 'missing') {
          expect(session.getSubagentsSnapshot().counts.completed).toBe(0);
          expect(session.getSubagentsSnapshot().tasks[0]).toMatchObject({
            request: 'New requested task',
            status: 'starting',
            output: '',
          });
        }
      } finally {
        session.dispose();
      }
    },
  );

  it.each(['external-turn', 'new-turn'])(
    'R1-8 does not resurrect a buffered permission resolved before receipt %s',
    async (jobRef) => {
      const { session, adaptor, callbacks, realtime, log } =
        await startSession();
      try {
        let finish!: (value: PromptReceipt) => void;
        adaptor.prompt.mockImplementationOnce(
          () => new Promise<PromptReceipt>((resolve) => (finish = resolve)),
        );
        callTool(callbacks, 'handoff', { task: 'New requested task' });
        await vi.waitFor(() => expect(adaptor.prompt).toHaveBeenCalledOnce());
        adaptor.queue('s1').push({
          type: 'permission_request',
          jobRef: 'external-turn',
          requestId: 'already-resolved',
          title: 'Resolved on screen',
          options: PERMISSION_OPTIONS,
        });
        adaptor.queue('s1').push({
          type: 'permission_resolved',
          requestId: 'already-resolved',
          byUs: false,
        });
        await vi.waitFor(() =>
          expect(log.write).toHaveBeenCalledWith(
            'backend.event',
            expect.objectContaining({ type: 'permission_resolved' }),
          ),
        );
        finish({ status: 'accepted', jobRef });
        await awaitReceipts(realtime, 1);
        callTool(callbacks, 'respond_permission', {
          request_id: 'req_1',
          decision: 'allow',
        });
        const results = await awaitReceipts(realtime, 2);
        expect(results[1]).toMatchObject({ status: 'error' });
        expect(adaptor.respondPermission).not.toHaveBeenCalled();
        expect(realtime.sendBackendContext).not.toHaveBeenCalledWith(
          expect.stringContaining('[PERMISSION'),
        );
        expect(session.getSubagentsSnapshot().counts.needsAttention).toBe(0);
      } finally {
        session.dispose();
      }
    },
  );

  it.each([false, true])(
    'R1-9 distinguishes provider response failure from terminal failure (fatal=%s)',
    async (fatal) => {
      const { session, adaptor, callbacks, realtime, host } =
        await startSession();
      try {
        let finish!: (value: PromptReceipt) => void;
        adaptor.prompt.mockImplementationOnce(
          () => new Promise<PromptReceipt>((resolve) => (finish = resolve)),
        );
        callbacks.onResponseCreated?.({
          callEpoch: 1,
          responseId: 'slow-response',
          authority: 'direct',
        });
        callToolForResponse(callbacks, 'slow-response', 'handoff', {
          task: 'Slow backend submission',
        });
        await vi.waitFor(() => expect(adaptor.prompt).toHaveBeenCalledOnce());
        callbacks.onError?.(
          new QwenRealtimeError(
            'provider response failed',
            'response_failed',
            fatal,
          ),
        );
        if (!fatal) {
          expect(host.failCall).not.toHaveBeenCalled();
          callbacks.onResponseDone?.({
            callEpoch: 1,
            responseId: 'slow-response',
            status: 'failed',
            authority: 'direct',
          });
        }
        realtime.submitFunctionOutput.mockReturnValue(false);
        finish({ status: 'accepted', jobRef: 'slow-job' });
        await delay(30);
        expect(host.failCall).toHaveBeenCalledTimes(fatal ? 1 : 0);
        if (fatal) {
          expect(realtime.submitFunctionOutput).not.toHaveBeenCalled();
          expect(realtime.close).toHaveBeenCalled();
        } else {
          expect(realtime.submitFunctionOutput).toHaveBeenCalledOnce();
          expect(realtime.close).not.toHaveBeenCalled();
        }
      } finally {
        session.dispose();
      }
    },
  );

  it.each(['different-response', 'cancelled', 'client-close'] as const)(
    'R1-9 does not suppress rejected tool output for %s',
    async (failure) => {
      const { session, adaptor, callbacks, realtime, host } =
        await startSession();
      try {
        let finish!: (value: PromptReceipt) => void;
        adaptor.prompt.mockImplementationOnce(
          () => new Promise<PromptReceipt>((resolve) => (finish = resolve)),
        );
        callToolForResponse(callbacks, 'slow-response', 'handoff', {
          task: 'Slow backend submission',
        });
        await vi.waitFor(() => expect(adaptor.prompt).toHaveBeenCalledOnce());
        callbacks.onResponseDone?.({
          callEpoch: 1,
          responseId:
            failure === 'different-response'
              ? 'other-response'
              : 'slow-response',
          status: failure === 'cancelled' ? 'cancelled' : 'failed',
          authority: 'direct',
        });
        if (failure === 'client-close') {
          callbacks.onClose?.({ reason: 'client' });
        }
        realtime.submitFunctionOutput.mockReturnValue(false);
        finish({ status: 'accepted', jobRef: 'slow-job' });
        await vi.waitFor(() => expect(host.failCall).toHaveBeenCalledOnce());
        expect(realtime.close).toHaveBeenCalledWith({
          discardPendingInput: true,
        });
      } finally {
        session.dispose();
      }
    },
  );

  it('R1-14 reopens backend injection after invalidated pending Proactive clears old playback', async () => {
    const harness = createProactiveHarness();
    const { session, adaptor, callbacks, realtime, host } = await startSession(
      undefined,
      {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      },
    );
    try {
      callTool(callbacks, 'handoff', { task: 'Watch for changes' });
      await awaitReceipts(realtime, 1);
      const delivery: ProactiveDelivery = {
        taskId: 'task-monitor',
        taskGeneration: 1,
        deliveryId: 'pending-invalidated',
        event: 'Pending notification',
      };
      harness.options().onEvent(delivery);
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();
      session.playbackStarted({ epoch: 1 });
      harness.options().onDeliveryInvalidated?.(delivery);
      callbacks.onResponseCreated?.({
        callEpoch: 1,
        responseId: 'late-proactive',
        authority: 'proactive',
      });
      expect(host.clearOutput).toHaveBeenCalledWith(1);
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId: 'late-proactive',
        authority: 'proactive',
        status: 'cancelled',
        cancellationReason: 'client_cancelled',
      });
      session.playbackCompleted({ epoch: 1 });
      adaptor.queue('s1').push({
        type: 'turn_complete',
        jobRef: 'p1',
        summary: 'Finished after invalidation',
      });
      await vi.waitFor(() =>
        expect(session.getSubagentsSnapshot().counts.completed).toBe(1),
      );
      await delay(1_000);
      expect(realtime.sendBackendContext).toHaveBeenCalledWith(
        '[COMPLETE job_1] Finished after invalidation',
      );
    } finally {
      session.dispose();
    }
  });

  it.each([
    'tool_continuation',
    'backend_speech',
    'direct',
    'proactive',
    'proactive_repair',
  ] as const)(
    'R1-15 retries a deferred cancel repair after %s becomes idle',
    async (authority) => {
      const harness = createProactiveHarness();
      const { session, callbacks, realtime } = await startSession(undefined, {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      });
      try {
        realtime.requestProactiveRepair.mockReturnValueOnce(false);
        callbacks.onResponseCreated?.({
          callEpoch: 1,
          responseId: 'cancel-claim',
          inputItemId: 'cancel-input',
          authority: 'direct',
        });
        callbacks.onDirectTranscript?.({
          callEpoch: 1,
          responseId: 'cancel-claim',
          inputItemId: 'cancel-input',
          entries: [
            { role: 'assistant', text: '好的，已经停止这个提醒任务了。' },
          ],
        });
        callbacks.onResponseDone?.({
          callEpoch: 1,
          responseId: 'cancel-claim',
          inputItemId: 'cancel-input',
          authority: 'direct',
          status: 'completed',
        });
        expect(realtime.requestProactiveRepair).toHaveBeenCalledOnce();
        callbacks.onResponseCreated?.({
          callEpoch: 1,
          responseId: 'blocking-response',
          authority,
        });
        callbacks.onResponseDone?.({
          callEpoch: 1,
          responseId: 'blocking-response',
          authority,
          status: 'completed',
        });
        expect(realtime.requestProactiveRepair).toHaveBeenCalledTimes(2);
      } finally {
        session.dispose();
      }
    },
  );

  it('R1-19 characterizes permanent stream errors surviving hangup but stopping on dispose', async () => {
    const adaptor = new FakeAdaptor();
    const { session, callbacks, realtime, log } = await startSession(adaptor);
    const events = vi.spyOn(adaptor, 'events').mockImplementation(() => {
      throw new Error('session not found');
    });
    vi.useFakeTimers();
    try {
      callTool(callbacks, 'handoff', { task: 'Lost backend session' });
      await awaitReceipts(realtime, 1);
      await vi.advanceTimersByTimeAsync(3_000);
      const beforeStop = events.mock.calls.length;
      await session.stop({ epoch: 1, callId: 'call-1' });
      await vi.advanceTimersByTimeAsync(100_000);
      expect(events.mock.calls.length).toBeGreaterThan(beforeStop + 5);
      expect(log.write).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({
          source: 'pump',
          message: 'session not found',
        }),
      );
      expect(session.getSubagentsSnapshot().tasks[0]?.activity).toBe(
        liveMessage('subagents.reconnecting'),
      );
      session.dispose();
      const afterDispose = events.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(events).toHaveBeenCalledTimes(afterDispose);
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it('R1-15 preserves adjacent cancel authority while waiting for the last foreground response', async () => {
    const harness = createProactiveHarness();
    const { session, callbacks, realtime } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    try {
      callTool(callbacks, CREATE_PROACTIVE_MONITOR_TOOL_NAME, {
        title: MONITOR_TASK.title,
        modalities: ['vision'],
        condition: 'The user starts slouching',
        trigger_response: 'Sit upright',
      });
      await vi.waitFor(() =>
        expect(realtime.submitFunctionOutput).toHaveBeenCalledOnce(),
      );
      realtime.requestProactiveRepair.mockReturnValueOnce(false);
      callbacks.onResponseCreated?.({
        callEpoch: 1,
        responseId: 'user-cancel',
        inputItemId: 'cancel-input',
        authority: 'direct',
      });
      callbacks.onDirectTranscript?.({
        callEpoch: 1,
        responseId: 'user-cancel',
        entries: [
          { role: 'assistant', text: '好的，已经停止这个提醒任务了。' },
        ],
      });
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId: 'user-cancel',
        inputItemId: 'cancel-input',
        authority: 'direct',
        status: 'completed',
      });
      for (const authority of ['backend_speech', 'proactive'] as const) {
        callbacks.onResponseCreated?.({
          callEpoch: 1,
          responseId: authority,
          authority,
        });
      }
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId: 'backend_speech',
        authority: 'backend_speech',
        status: 'completed',
      });
      expect(realtime.requestProactiveRepair).toHaveBeenCalledOnce();
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId: 'proactive',
        authority: 'proactive',
        status: 'completed',
      });
      expect(realtime.requestProactiveRepair).toHaveBeenCalledTimes(2);
      callbacks.onResponseCreated?.({
        callEpoch: 1,
        responseId: 'cancel-repair',
        authority: 'proactive_repair',
      });
      callToolForResponse(
        callbacks,
        'cancel-repair',
        CANCEL_PROACTIVE_TASK_TOOL_NAME,
        {},
      );
      await vi.waitFor(() =>
        expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(2),
      );
      expect(harness.scheduler.cancelTasks).toHaveBeenCalledWith({
        targetTitle: MONITOR_TASK.title,
      });
    } finally {
      session.dispose();
    }
  });

  it.each(['screen', 'camera'] as const)(
    'R1-25 keeps the full runtime visual announcement identical to prompt for %s',
    async (source) => {
      const { session, realtime } = await startSession();
      try {
        for (const mode of ['on-demand', 'live-feed'] as const) {
          const visualInput = { ...DEFAULT_VISUAL_INPUT, source, mode };
          session.setVisualSettings({
            epoch: 1,
            callId: 'call-1',
            visualInput,
          });
          const marker = buildLiveInstructions(visualInput)
            .split('\n')
            .find((line) => line.startsWith('[VISUAL_INPUT]'));
          expect(marker).toBeDefined();
          expect(realtime.sendBackendContext).toHaveBeenLastCalledWith(marker);
        }
      } finally {
        session.dispose();
      }
    },
  );
});

describe('LiveSession', () => {
  it('correlates concurrent fast backend events only after each prompt receipt supplies its stable jobRef', async () => {
    const { session, adaptor, callbacks, realtime } = await startSession();
    callTool(callbacks, 'session_create', {});
    await awaitReceipts(realtime, 1);
    const finish: Array<(receipt: PromptReceipt) => void> = [];
    adaptor.prompt.mockImplementation(
      async () => new Promise<PromptReceipt>((resolve) => finish.push(resolve)),
    );
    callTool(callbacks, 'handoff', {
      session: 'session_1',
      task: 'First request',
    });
    callTool(callbacks, 'handoff', {
      session: 'session_1',
      task: 'Second request',
    });
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    for (const jobRef of ['first', 'second']) {
      adaptor.queue('s1').push({ type: 'turn_started', jobRef });
      adaptor
        .queue('s1')
        .push({ type: 'activity', jobRef, kind: 'message', text: jobRef });
      adaptor
        .queue('s1')
        .push({ type: 'turn_complete', jobRef, summary: `Result ${jobRef}` });
    }
    await delay(5);
    expect(session.getSubagentsSnapshot().tasks).toEqual([]);
    finish[1]!({ status: 'accepted', jobRef: 'second' });
    finish[0]!({ status: 'accepted', jobRef: 'first' });
    await awaitReceipts(realtime, 3);
    expect(session.getSubagentsSnapshot().counts.completed).toBe(2);
    expect(
      session
        .getSubagentsSnapshot()
        .tasks.map((task) => [task.request, task.output]),
    ).toEqual(
      expect.arrayContaining([
        ['First request', 'Result first'],
        ['Second request', 'Result second'],
      ]),
    );
    session.dispose();
  });

  it('keeps one backend observer after hangup and publishes public activity and completion without model calls', async () => {
    const logger = new LiveLogger();
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const rig = await startSession(undefined, { logger });
    const { session, adaptor, callbacks, realtime } = rig;
    const subscriptions = vi.spyOn(adaptor, 'events');
    callTool(callbacks, 'handoff', { task: 'Run background tests' });
    await awaitReceipts(realtime, 1);
    expect(debug).toHaveBeenCalledWith(
      `subagents.job_state ${JSON.stringify({ sessionHandle: 'session_1', jobHandle: 'job_1', kind: 'harness', status: 'starting' })}`,
    );
    adaptor.queue('s1').push({ type: 'turn_started', jobRef: 'p1' });
    await vi.waitFor(() =>
      expect(session.getSubagentsSnapshot().tasks[0]?.status).toBe('running'),
    );
    await session.stop({ epoch: 1, callId: 'call-1' });
    realtime.sendBackendContext.mockClear();
    realtime.speakToUser.mockClear();
    realtime.submitFunctionOutput.mockClear();
    adaptor.queue('s1').push({
      type: 'activity',
      jobRef: 'p1',
      kind: 'message',
      text: 'Public partial output',
    });
    await vi.waitFor(() =>
      expect(session.getSubagentsSnapshot().tasks[0]?.output).toBe(
        'Public partial output',
      ),
    );
    adaptor.queue('s1').push({
      type: 'turn_complete',
      jobRef: 'p1',
      summary: 'All tests passed',
      detail: 'Final public result',
    });
    await vi.waitFor(() =>
      expect(session.getSubagentsSnapshot().counts.completed).toBe(1),
    );
    expect(session.getSubagentsSnapshot().tasks[0]?.output).toBe(
      'Final public result',
    );
    expect(realtime.sendBackendContext).not.toHaveBeenCalled();
    expect(realtime.speakToUser).not.toHaveBeenCalled();
    expect(realtime.submitFunctionOutput).not.toHaveBeenCalled();
    expect(adaptor.cancel).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      `backend.lifecycle ${JSON.stringify({ sessionHandle: 'session_1', jobHandle: 'job_1', type: 'activity', activeCall: false, buffered: false, kind: 'message', textChars: 'Public partial output'.length })}`,
    );
    expect(debug).toHaveBeenCalledWith(
      `backend.lifecycle ${JSON.stringify({ sessionHandle: 'session_1', jobHandle: 'job_1', type: 'turn_complete', activeCall: false, buffered: false, summaryChars: 'All tests passed'.length, detailChars: 'Final public result'.length })}`,
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain(
      'Run background tests',
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain(
      'Public partial output',
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain(
      'Final public result',
    );
    await session.start({
      epoch: 2,
      callId: 'call-2',
      mode: 'resume',
      visualInput: DEFAULT_VISUAL_INPUT,
    });
    expect(subscriptions).toHaveBeenCalledOnce();
    expect(session.getSubagentsSnapshot().counts.completed).toBe(1);
    const before = session.getSubagentsSnapshot().revision;
    session.dispose();
    adaptor.queue('s1').push({
      type: 'activity',
      jobRef: 'p1',
      kind: 'message',
      text: 'late event',
    });
    await delay(5);
    expect(session.getSubagentsSnapshot().revision).toBe(before);
  });

  it('does not count joined steering or unknown idle as successful tasks', async () => {
    const { session, adaptor, callbacks, realtime } = await startSession();
    callTool(callbacks, 'handoff', { task: 'Run tests' });
    await awaitReceipts(realtime, 1);
    adaptor.busy = true;
    adaptor.queue('s1').push({ type: 'turn_started', jobRef: 'p1' });
    await vi.waitFor(() =>
      expect(session.getSubagentsSnapshot().tasks[0]?.status).toBe('running'),
    );
    adaptor.promptReceipt = {
      status: 'accepted',
      jobRef: 'p1',
      joinedActiveTurn: true,
    };
    callTool(callbacks, 'handoff', { task: 'Also lint' });
    await awaitReceipts(realtime, 2);
    expect(session.getSubagentsSnapshot().tasks).toHaveLength(1);
    expect(session.getSubagentsSnapshot().tasks[0]?.request).toBe('Run tests');
    adaptor.promptReceipt = { status: 'queued', jobRef: 'p2' };
    callTool(callbacks, 'handoff', { task: 'Next task' });
    await awaitReceipts(realtime, 3);
    expect(
      session
        .getSubagentsSnapshot()
        .tasks.find((task) => task.id === 'harness:job_2')?.status,
    ).toBe('queued');
    adaptor.queue('s1').push({
      type: 'turn_complete',
      jobRef: 'unowned',
      summary: 'Not our task',
    });
    await delay(5);
    expect(session.getSubagentsSnapshot().counts.completed).toBe(0);
    adaptor.busy = false;
    callTool(callbacks, 'session_monitor', { job: 'job_1' });
    await awaitReceipts(realtime, 4);
    expect(session.getSubagentsSnapshot().counts.completed).toBe(0);
    expect(session.getSubagentsSnapshot().counts.interrupted).toBe(2);
    session.dispose();
  });

  it('keeps background lifecycle diagnostics content-free and survives a throwing logger', async () => {
    const logger = new LiveLogger();
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const { session, adaptor, callbacks, realtime, currentCallbacks } =
      await startSession(undefined, { logger });
    const secret = 'PRIVATE_BACKEND_SENTINEL';
    adaptor.promptReceipt = { status: 'accepted', jobRef: secret };
    callTool(callbacks, 'handoff', { task: secret });
    await awaitReceipts(realtime, 1);
    await session.stop({ epoch: 1, callId: 'call-1' });
    debug.mockClear();
    adaptor.queue('s1').push({
      type: 'permission_request',
      jobRef: secret,
      requestId: secret,
      title: secret,
      options: [{ optionId: secret, label: secret, kind: 'proceed' }],
      payload: { command: secret },
    });
    await vi.waitFor(() =>
      expect(session.getSubagentsSnapshot().counts.needsAttention).toBe(1),
    );
    adaptor
      .queue('s1')
      .push({ type: 'permission_resolved', requestId: secret, byUs: false });
    adaptor
      .queue('s1')
      .push({ type: 'progress', jobRef: secret, summary: secret });
    adaptor.queue('s1').push({ type: 'speak', text: secret });
    adaptor
      .queue('s1')
      .push({ type: 'turn_error', jobRef: secret, error: secret });
    await vi.waitFor(() =>
      expect(session.getSubagentsSnapshot().counts.failed).toBe(1),
    );
    const entries = debug.mock.calls
      .filter(([entry]) => entry.startsWith('backend.lifecycle '))
      .map(
        ([entry]) =>
          JSON.parse(entry.slice('backend.lifecycle '.length)) as Record<
            string,
            unknown
          >,
      );
    expect(entries.map((entry) => entry['type'])).toEqual([
      'permission_request',
      'permission_resolved',
      'progress',
      'speak',
      'turn_error',
    ]);
    expect(entries[0]).toMatchObject({
      sessionHandle: 'session_1',
      jobHandle: 'job_1',
      activeCall: false,
      permissionPending: true,
      permissionOptions: 1,
    });
    expect(entries[1]).toMatchObject({
      permissionPending: false,
      resolvedByUs: false,
    });
    expect(entries[2]).toMatchObject({ summaryChars: secret.length });
    expect(entries[3]).toMatchObject({ textChars: secret.length });
    expect(entries[4]).toMatchObject({ errorChars: secret.length });
    expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
    debug.mockImplementation(() => {
      throw new Error(secret);
    });
    await session.start({
      epoch: 2,
      callId: 'call-2',
      mode: 'resume',
      visualInput: DEFAULT_VISUAL_INPUT,
    });
    adaptor.promptReceipt = { status: 'accepted', jobRef: 'second-job' };
    callTool(currentCallbacks(), 'handoff', {
      task: 'New task after logger failure',
    });
    await awaitReceipts(realtime, 2);
    adaptor.queue('s1').push({
      type: 'turn_complete',
      jobRef: 'second-job',
      summary: 'Completed after logger failure',
    });
    await vi.waitFor(() =>
      expect(
        session
          .getSubagentsSnapshot()
          .tasks.find((task) => task.id === 'harness:job_2')?.output,
      ).toBe('Completed after logger failure'),
    );
    session.dispose();
  });

  it('records permission requests while hung up without auto-granting a standing rule', async () => {
    const logger = new LiveLogger();
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const rig = await startSession(undefined, { logger });
    const { session, adaptor, callbacks, realtime } = rig;
    callTool(callbacks, 'handoff', { task: 'Check weather' });
    await awaitReceipts(realtime, 1);
    adaptor.queue('s1').push({
      type: 'permission_request',
      jobRef: 'p1',
      requestId: 'r1',
      title: 'curl weather.example',
      options: PERMISSION_OPTIONS,
    });
    await vi.waitFor(() =>
      expect(session.getSubagentsSnapshot().tasks[0]?.status).toBe('waiting'),
    );
    callTool(callbacks, 'respond_permission', {
      request_id: 'req_1',
      decision: 'allow_always',
    });
    await awaitReceipts(realtime, 2);
    await session.stop({ epoch: 1, callId: 'call-1' });
    adaptor.respondPermission.mockClear();
    realtime.speakToUser.mockClear();
    adaptor.queue('s1').push({
      type: 'permission_request',
      jobRef: 'p1',
      requestId: 'r2',
      title: 'curl weather.example',
      options: PERMISSION_OPTIONS,
    });
    await delay(10);
    expect(adaptor.respondPermission).not.toHaveBeenCalled();
    expect(realtime.speakToUser).not.toHaveBeenCalled();
    expect(session.getSubagentsSnapshot().counts.needsAttention).toBe(1);
    expect(debug).toHaveBeenCalledWith(
      `backend.lifecycle ${JSON.stringify({ sessionHandle: 'session_1', jobHandle: 'job_1', type: 'permission_request', activeCall: false, buffered: false, permissionPending: true, permissionOptions: 2 })}`,
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain(
      'curl weather.example',
    );
    session.dispose();
  });

  it('surfaces an actionable Realtime authentication failure', async () => {
    const host = createFakeHost({
      source: 'screen',
      image: TEST_JPEG,
      width: 1280,
      height: 720,
    });
    const setProviderReachability = vi.fn();
    const error = new QwenRealtimeError(
      'API-key is blocked.',
      'InvalidApiKey',
      true,
      { kind: 'configuration', status: 401 },
    );
    const session = new LiveSession({
      host: { ...host, setProviderReachability },
      registry: new BackendRegistry([
        { adaptor: new FakeAdaptor(), isDefault: true },
      ]),
      realtime: {
        endpoint: 'https://dashscope.example.com',
        model: 'qwen3.5-omni-plus-realtime',
      },
      log: { write: vi.fn(), close: async () => {} } as unknown as SessionLog,
      openRealtime: () => Promise.reject(error),
    });

    await expect(
      session.start({
        epoch: 1,
        callId: 'call-1',
        mode: 'new',
        visualInput: DEFAULT_VISUAL_INPUT,
      }),
    ).rejects.toBe(error);
    const message =
      'Realtime authentication failed: API-key is blocked. Replace or unset DASHSCOPE_API_KEY/QWEN_LIVE_REALTIME_API_KEY (environment variables override config.json), then restart qwen-live.';
    expect(displayLiveMessage('en', host.failCall.mock.calls[0]![1]!)).toBe(
      message,
    );
    expect(
      displayLiveMessage('zh-CN', host.failCall.mock.calls[0]![1]!),
    ).toContain('身份验证失败');
    expect(setProviderReachability).toHaveBeenCalledWith({
      state: 'unavailable',
      blocker: 'provider_config',
      message: host.failCall.mock.calls[0]![1],
    });
  });

  it('preserves the authentication failure when close fires before connect rejects', async () => {
    const host = createFakeHost({
      source: 'screen',
      image: TEST_JPEG,
      width: 1280,
      height: 720,
    });
    const setProviderReachability = vi.fn();
    const error = new QwenRealtimeError(
      'API-key is blocked.',
      'InvalidApiKey',
      true,
      { kind: 'configuration', status: 401 },
    );
    const session = new LiveSession({
      host: { ...host, setProviderReachability },
      registry: new BackendRegistry([
        { adaptor: new FakeAdaptor(), isDefault: true },
      ]),
      realtime: {
        endpoint: 'https://dashscope.example.com',
        model: 'qwen3.5-omni-plus-realtime',
      },
      log: { write: vi.fn(), close: async () => {} } as unknown as SessionLog,
      openRealtime: async (_config, callbacks) => {
        callbacks?.onClose?.({ reason: 'error', error });
        throw error;
      },
    });

    await expect(
      session.start({
        epoch: 1,
        callId: 'call-1',
        mode: 'new',
        visualInput: DEFAULT_VISUAL_INPUT,
      }),
    ).rejects.toBe(error);
    const message =
      'Realtime authentication failed: API-key is blocked. Replace or unset DASHSCOPE_API_KEY/QWEN_LIVE_REALTIME_API_KEY (environment variables override config.json), then restart qwen-live.';
    expect(host.failCall).toHaveBeenCalledOnce();
    expect(displayLiveMessage('en', host.failCall.mock.calls[0]![1]!)).toBe(
      message,
    );
    expect(setProviderReachability).toHaveBeenCalledWith({
      state: 'unavailable',
      blocker: 'provider_config',
      message: host.failCall.mock.calls[0]![1],
    });
  });

  it('does not replace a fatal provider error with a final-input commit error', async () => {
    const { callbacks, host, realtime, session } = await startSession();
    let stopped: Promise<void | { error: string }> | undefined;
    host.failCall.mockImplementation((epoch: number): boolean => {
      stopped = session.stop({ epoch, callId: 'call-1' });
      return true;
    });
    callbacks.onSpeechStarted?.({ callEpoch: 1 });

    callbacks.onError?.(
      new QwenRealtimeError('Provider socket failed.', 'socket_error', true, {
        kind: 'transient',
      }),
    );

    await stopped;
    expect(host.failCall).toHaveBeenCalledWith(
      1,
      liveMessage('runtime.realtimeFailed', {
        detail: ' Provider socket failed.',
      }),
    );
    expect(realtime.commitInputAudio).not.toHaveBeenCalled();
  });

  it('start opens the realtime session with the live tool surface and walks starting → listening', async () => {
    const { config, host } = await startSession();

    expect(config.tools).toBe(LIVE_SESSION_TOOLS);
    expect(
      config.tools.find((tool) => tool.function.name === 'respond_permission')
        ?.continuesResponse,
    ).toBe(true);
    expect(config.instructions.length).toBeGreaterThan(0);
    expect(config.instructions).toContain('Never pronounce internal handles');
    expect(host.states).toEqual(['starting', 'listening']);
  });

  it('adds the Proactive prompt, tools, and scheduler only when enabled', async () => {
    const enabledHarness = createProactiveHarness();
    const enabled = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: enabledHarness.createScheduler,
    });
    const proactiveNames = PROACTIVE_SESSION_TOOLS.map(
      (tool) => tool.function.name,
    );

    expect(enabled.config.instructions).toContain('## Proactive routing');
    expect(
      enabled.config.tools
        .map((tool) => tool.function.name)
        .filter((name) => proactiveNames.includes(name)),
    ).toEqual(proactiveNames);
    expect(enabledHarness.createScheduler).toHaveBeenCalledOnce();
    expect(enabledHarness.options().realtime).toEqual({
      endpoint: 'https://dashscope.example.com',
      model: 'qwen-omni-turbo-realtime',
    });

    const disabledHarness = createProactiveHarness();
    const disabled = await startSession(undefined, {
      proactive: { ...DEFAULT_PROACTIVE_CONFIG, enabled: false },
      createProactiveScheduler: disabledHarness.createScheduler,
    });
    expect(disabled.config.instructions).not.toContain('## Proactive routing');
    expect(
      disabled.config.tools.some((tool) =>
        proactiveNames.includes(tool.function.name),
      ),
    ).toBe(false);
    expect(disabledHarness.createScheduler).not.toHaveBeenCalled();

    const omittedHarness = createProactiveHarness();
    const omitted = await startSession(undefined, {
      createProactiveScheduler: omittedHarness.createScheduler,
    });
    expect(omitted.config.instructions).not.toContain('## Proactive routing');
    expect(
      omitted.config.tools.some((tool) =>
        proactiveNames.includes(tool.function.name),
      ),
    ).toBe(false);
    expect(omittedHarness.createScheduler).not.toHaveBeenCalled();

    enabled.session.dispose();
    disabled.session.dispose();
    omitted.session.dispose();
  });

  it('closes Realtime when Proactive scheduler setup fails', async () => {
    const host = createFakeHost({
      source: 'screen',
      image: TEST_JPEG,
      width: 1280,
      height: 720,
    });
    const realtime = createFakeRealtime();
    const error = new Error('scheduler setup failed');
    const session = new LiveSession({
      host,
      registry: new BackendRegistry([
        { adaptor: new FakeAdaptor(), isDefault: true },
      ]),
      realtime: {
        endpoint: 'https://dashscope.example.com',
        model: 'qwen3.5-omni-plus-realtime',
      },
      proactive: DEFAULT_PROACTIVE_CONFIG,
      log: { write: vi.fn(), close: async () => {} } as unknown as SessionLog,
      openRealtime: async () => realtime as unknown as QwenRealtimeSession,
      createProactiveScheduler: () => {
        throw error;
      },
    });

    await expect(
      session.start({
        epoch: 1,
        callId: 'call-1',
        mode: 'new',
        visualInput: DEFAULT_VISUAL_INPUT,
      }),
    ).rejects.toBe(error);
    expect(realtime.close).toHaveBeenCalledWith({ discardPendingInput: true });
  });

  it('fans media into Proactive and captures only the current on-demand source', async () => {
    const harness = createProactiveHarness();
    const { host, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
      visualInput: { ...DEFAULT_VISUAL_INPUT, mode: 'live-feed' },
    });
    const audio = Buffer.from([1, 0, 2, 0]);

    expect(
      session.pushAudio({ epoch: 1, callId: 'call-1', pcm16: audio }),
    ).toBe(true);
    expect(realtime.pushAudio).toHaveBeenCalledWith(audio);
    expect(harness.scheduler.feedAudio).toHaveBeenCalledWith(audio);

    expect(
      session.pushImage({
        epoch: 1,
        callId: 'call-1',
        source: 'screen',
        image: TEST_JPEG,
      }),
    ).toBe(true);
    expect(realtime.pushImage).toHaveBeenCalledWith(TEST_JPEG);
    expect(harness.scheduler.feedImage).toHaveBeenCalledWith(TEST_JPEG);

    session.setVisualSettings({
      epoch: 1,
      callId: 'call-1',
      visualInput: DEFAULT_VISUAL_INPUT,
    });
    expect(harness.scheduler.resetVisualSource).not.toHaveBeenCalled();
    await expect(harness.options().captureVision?.()).resolves.toBe(TEST_JPEG);
    expect(host.captureVisualContext).toHaveBeenCalledWith('call-1', {
      persistAsset: false,
      screenScope: 'display',
    });

    let resolveCapture: ((capture: LiveVisualCapture) => void) | undefined;
    host.captureVisualContext.mockImplementationOnce(
      () =>
        new Promise<LiveVisualCapture>((resolve) => {
          resolveCapture = resolve;
        }),
    );
    const capturePending = harness.options().captureVision?.();
    session.setVisualSettings({
      epoch: 1,
      callId: 'call-1',
      visualInput: { ...DEFAULT_VISUAL_INPUT, source: 'camera' },
    });
    expect(harness.scheduler.resetVisualSource).toHaveBeenCalledOnce();
    resolveCapture?.({
      source: 'screen',
      image: TEST_JPEG,
      width: 1280,
      height: 720,
    });
    await expect(capturePending).resolves.toBeUndefined();

    session.dispose();
  });

  it('discards old-display monitor captures and resets vision on selected or resolved display changes', async () => {
    const harness = createProactiveHarness();
    const { host, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    let finish!: (capture: LiveVisualCapture) => void;
    host.captureVisualContext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = harness.options().captureVision?.();
    const displayId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    session.setVisualSettings({
      epoch: 1,
      callId: 'call-1',
      visualInput: { ...DEFAULT_VISUAL_INPUT, screenDisplayId: displayId },
    });
    expect(harness.scheduler.resetVisualSource).toHaveBeenCalledOnce();
    finish({
      source: 'screen',
      screenScope: 'display',
      displayId,
      image: TEST_JPEG,
      width: 1280,
      height: 720,
    });
    await expect(pending).resolves.toBeUndefined();
    session.setVisualSettings({
      epoch: 1,
      callId: 'call-1',
      visualInput: { ...DEFAULT_VISUAL_INPUT, mode: 'live-feed' },
    });
    harness.scheduler.resetVisualSource.mockClear();
    session.pushImage({
      epoch: 1,
      callId: 'call-1',
      source: 'screen',
      displayId,
      image: TEST_JPEG,
    });
    session.pushImage({
      epoch: 1,
      callId: 'call-1',
      source: 'screen',
      displayId: displayId.toUpperCase(),
      image: TEST_JPEG,
    });
    expect(harness.scheduler.resetVisualSource).not.toHaveBeenCalled();
    session.pushImage({
      epoch: 1,
      callId: 'call-1',
      source: 'screen',
      displayId: '11111111-2222-3333-4444-555555555555',
      image: TEST_JPEG,
    });
    expect(harness.scheduler.resetVisualSource).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('keeps camera monitor snapshots outside display capture', async () => {
    const harness = createProactiveHarness();
    const { host, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
      visualInput: { ...DEFAULT_VISUAL_INPUT, source: 'camera' },
    });
    host.captureVisualContext.mockResolvedValueOnce({
      source: 'camera',
      image: TEST_JPEG,
      width: 1280,
      height: 720,
    });
    await expect(harness.options().captureVision?.()).resolves.toBe(TEST_JPEG);
    expect(host.captureVisualContext).toHaveBeenCalledExactlyOnceWith(
      'call-1',
      { persistAsset: false },
    );
    session.dispose();
  });

  it('serializes background vision with persistent Appshot capture', async () => {
    const harness = createProactiveHarness();
    const { callbacks, host, realtime, session } = await startSession(
      undefined,
      {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      },
    );
    let resolveBackground: ((capture: LiveVisualCapture) => void) | undefined;
    host.captureVisualContext
      .mockImplementationOnce(
        () =>
          new Promise<LiveVisualCapture>((resolve) => {
            resolveBackground = resolve;
          }),
      )
      .mockResolvedValueOnce({
        source: 'screen',
        image: TEST_JPEG,
        width: 1280,
        height: 720,
        appName: 'Safari',
        accessibilityText: 'visible text',
        screenshotPath: pngPath,
      });

    const backgroundCapture = harness.options().captureVision?.();
    await vi.waitFor(() => {
      expect(host.captureVisualContext).toHaveBeenCalledTimes(1);
    });
    callTool(callbacks, 'appshot', {});
    await Promise.resolve();
    expect(host.captureVisualContext).toHaveBeenCalledTimes(1);

    resolveBackground?.({
      source: 'screen',
      image: TEST_JPEG,
      width: 1280,
      height: 720,
    });
    await expect(backgroundCapture).resolves.toBe(TEST_JPEG);
    await awaitReceipts(realtime, 1);

    expect(host.captureVisualContext.mock.calls).toEqual([
      ['call-1', { persistAsset: false, screenScope: 'display' }],
      ['call-1', { persistAsset: true }],
    ]);
    session.dispose();
  });

  it('logs a failed Proactive task and queues one speech-safe notice', async () => {
    const harness = createProactiveHarness();
    const logger = new LiveLogger();
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const { log, realtime, session } = await startSession(undefined, {
      logger,
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });

    harness
      .options()
      .onTaskFailed?.(MONITOR_TASK, 'authentication failed with secret-token');

    expect(log.write).toHaveBeenCalledWith('error', {
      source: 'proactive_task',
      taskId: 'task-monitor',
      message: 'authentication failed with secret-token',
    });
    expect(debug).toHaveBeenCalledWith(
      `proactive.task_failed ${JSON.stringify({ epoch: 1, taskId: 'task-monitor', reason: 'task_failed', errorChars: 'authentication failed with secret-token'.length })}`,
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain('secret-token');
    expect(realtime.sendBackendContext).toHaveBeenCalledWith(
      '[PROACTIVE_TASK_FAILED] “Watch posture”这项后台监控未能继续运行，请重新设置。',
    );
    expect(realtime.speakToUser).toHaveBeenCalledWith(
      '“Watch posture”这项后台监控未能继续运行，请重新设置。',
    );
    const modelVisible = [
      ...realtime.sendBackendContext.mock.calls,
      ...realtime.speakToUser.mock.calls,
    ].join(' ');
    expect(modelVisible).not.toContain('task-monitor');
    expect(modelVisible).not.toContain('secret-token');

    session.dispose();
  });

  it('maps all six Proactive tools and returns authoritative receipts', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });

    callTool(callbacks, CREATE_PROACTIVE_MONITOR_TOOL_NAME, {
      title: 'Watch posture',
      modalities: ['vision', 'audio'],
      condition: 'The user starts slouching.',
      trigger_response: 'Remind the user to sit upright.',
      repeat: true,
    });
    callTool(callbacks, CREATE_LIVE_NARRATION_TOOL_NAME, {
      title: 'Narrate the workspace',
      modalities: ['vision'],
      narration_focus: 'Meaningful workspace changes.',
      narration_style: 'Brief English narration.',
    });
    callTool(callbacks, CREATE_PROACTIVE_TIMER_TOOL_NAME, {
      title: 'Tea timer',
      duration_sec: 300,
      reminder_text: 'The tea is ready.',
    });
    callTool(callbacks, UPDATE_PROACTIVE_TASK_TOOL_NAME, {
      target_title_contains: 'posture',
      title: 'Watch desk posture',
      modalities: ['vision'],
      condition: 'The user leans too close to the screen.',
      trigger_response: 'Suggest moving back.',
      repeat: false,
    });
    callTool(callbacks, CANCEL_PROACTIVE_TASK_TOOL_NAME, {
      target_title: 'Tea timer',
    });
    callTool(callbacks, LIST_PROACTIVE_TASKS_TOOL_NAME, {});
    await vi.waitFor(() => {
      expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(6);
    });
    const toolReceipts = realtime.submitFunctionOutput.mock.calls.map(
      ([, output]) => output,
    );

    expect(harness.scheduler.createPerceptionMonitor).toHaveBeenCalledWith({
      title: 'Watch posture',
      modalities: ['vision', 'audio'],
      condition: 'The user starts slouching.',
      triggerResponse: 'Remind the user to sit upright.',
      repeat: true,
    });
    expect(harness.scheduler.createLiveNarration).toHaveBeenCalledWith({
      title: 'Narrate the workspace',
      modalities: ['vision'],
      narrationFocus: 'Meaningful workspace changes.',
      narrationStyle: 'Brief English narration.',
    });
    expect(harness.scheduler.createTimer).toHaveBeenCalledWith({
      title: 'Tea timer',
      durationSec: 300,
      reminderText: 'The tea is ready.',
    });
    expect(harness.scheduler.updateTask).toHaveBeenCalledWith({
      targetTitleContains: 'posture',
      title: 'Watch desk posture',
      modalities: ['vision'],
      condition: 'The user leans too close to the screen.',
      triggerResponse: 'Suggest moving back.',
      repeat: false,
    });
    expect(harness.scheduler.cancelTasks).toHaveBeenCalledWith({
      targetTitle: 'Tea timer',
    });

    expect(toolReceipts).toEqual([
      '画面和声音监控“Watch posture”已启动，条件是“The user starts slouching.”，触发后的回应要求是“Remind the user to sit upright.”，每次独立再次出现都会触发。',
      '画面和声音持续解说“Narrate the workspace”已启动，关注“Meaningful workspace changes.”，只在出现新事件或明显变化时更新。',
      '5分钟后的定时提醒“Tea timer”已启动，提醒内容是“The tea is ready.”。',
      '提醒任务“Watch desk posture”已更新。',
      '提醒任务“Tea timer”已停止。',
      '当前共有2项活动中的提醒任务：画面和声音监控任务“Watch posture”正在监控，条件是“The user starts slouching.”，触发后的回应要求是“Remind the user to sit upright.”，重复监控；定时提醒“Tea timer”正在计时等待，设定时长5分钟，剩余4分钟，提醒内容是“The tea is ready.”。',
    ]);
    expect(toolReceipts.join(' ')).not.toContain('task-monitor');
    expect(toolReceipts.join(' ')).not.toContain('task-timer');

    session.dispose();
  });

  it('accepts Proactive arguments wrapped in one extra JSON string', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    const args = {
      title: 'Tea timer',
      duration_sec: 300,
      reminder_text: 'The tea is ready.',
    };

    callbacks.onFunctionCall?.({
      callEpoch: 1,
      responseId: 'double-encoded-arguments',
      callId: 'double-encoded-call',
      name: CREATE_PROACTIVE_TIMER_TOOL_NAME,
      arguments: JSON.stringify(JSON.stringify(args)),
      activeTranscript: [],
    });

    await vi.waitFor(() => {
      expect(realtime.submitFunctionOutput).toHaveBeenCalledOnce();
    });
    expect(harness.scheduler.createTimer).toHaveBeenCalledWith({
      title: 'Tea timer',
      durationSec: 300,
      reminderText: 'The tea is ready.',
    });

    session.dispose();
  });

  it('scopes selector-less mutations to the next genuine direct turn', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-create',
      inputItemId: 'input-create',
      authority: 'direct',
    });
    callToolForResponse(
      callbacks,
      'direct-create',
      CREATE_PROACTIVE_MONITOR_TOOL_NAME,
      {
        title: 'Watch posture',
        modalities: ['vision'],
        condition: 'The user starts slouching.',
        trigger_response: 'Remind the user to sit upright.',
        repeat: false,
      },
    );
    await vi.waitFor(() => {
      expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(1);
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-create',
      inputItemId: 'input-create',
      status: 'completed',
      authority: 'direct',
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'create-receipt',
      authority: 'tool_continuation',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'create-receipt',
      status: 'completed',
      authority: 'tool_continuation',
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-repeat',
      inputItemId: 'input-repeat',
      authority: 'direct',
    });
    callToolForResponse(
      callbacks,
      'direct-repeat',
      UPDATE_PROACTIVE_TASK_TOOL_NAME,
      { repeat: true },
    );
    await vi.waitFor(() => {
      expect(harness.scheduler.updateTask).toHaveBeenCalledOnce();
    });
    expect(harness.scheduler.updateTask).toHaveBeenCalledWith({
      targetTitle: 'Watch posture',
      repeat: true,
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-repeat',
      inputItemId: 'input-repeat',
      status: 'completed',
      authority: 'direct',
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-cancel',
      inputItemId: 'input-cancel',
      authority: 'direct',
    });
    callToolForResponse(
      callbacks,
      'direct-cancel',
      CANCEL_PROACTIVE_TASK_TOOL_NAME,
      {},
    );
    await vi.waitFor(() => {
      expect(harness.scheduler.cancelTasks).toHaveBeenCalledOnce();
    });
    expect(harness.scheduler.cancelTasks).toHaveBeenCalledWith({
      targetTitle: 'Watch desk posture',
    });

    session.dispose();
  });

  it('preserves adjacent-task context across a provider-split microphone response', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-create-before-split',
      inputItemId: 'input-create-before-split',
      authority: 'direct',
    });
    callToolForResponse(
      callbacks,
      'direct-create-before-split',
      CREATE_PROACTIVE_MONITOR_TOOL_NAME,
      {
        title: 'Watch posture',
        modalities: ['vision'],
        condition: 'The user starts slouching.',
        trigger_response: 'Remind the user to sit upright.',
        repeat: false,
      },
    );
    await vi.waitFor(() => {
      expect(realtime.submitFunctionOutput).toHaveBeenCalledOnce();
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-create-before-split',
      inputItemId: 'input-create-before-split',
      status: 'completed',
      authority: 'direct',
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'split-preamble',
      inputItemId: 'input-split',
      authority: 'direct',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'split-preamble',
      status: 'cancelled',
      authority: 'direct',
      cancellationReason: 'superseded',
    });
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'split-tool',
      inputItemId: 'input-split',
      authority: 'direct',
    });
    callToolForResponse(
      callbacks,
      'split-tool',
      UPDATE_PROACTIVE_TASK_TOOL_NAME,
      { repeat: true },
    );

    await vi.waitFor(() => {
      expect(harness.scheduler.updateTask).toHaveBeenCalledOnce();
    });
    expect(harness.scheduler.updateTask).toHaveBeenCalledWith({
      targetTitle: 'Watch posture',
      repeat: true,
    });
    session.dispose();
  });

  it('preserves adjacent-task context when an implicit mutation fails', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-create',
      inputItemId: 'input-create',
      authority: 'direct',
    });
    callToolForResponse(
      callbacks,
      'direct-create',
      CREATE_PROACTIVE_MONITOR_TOOL_NAME,
      {
        title: 'Watch posture',
        modalities: ['vision'],
        condition: 'The user starts slouching.',
        trigger_response: 'Remind the user to sit upright.',
        repeat: false,
      },
    );
    await vi.waitFor(() => {
      expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(1);
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-create',
      inputItemId: 'input-create',
      status: 'completed',
      authority: 'direct',
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-invalid-update',
      inputItemId: 'input-invalid-update',
      authority: 'direct',
    });
    callToolForResponse(
      callbacks,
      'direct-invalid-update',
      UPDATE_PROACTIVE_TASK_TOOL_NAME,
      { repeat: false },
    );
    await vi.waitFor(() => {
      expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(2);
    });
    expect(realtime.submitFunctionOutput.mock.calls[1]?.[1]).toBe(
      '提醒任务未修改。仅对紧邻刚创建的任务设置 repeat=true 时可省略目标；其他修改必须提供 target_title 或 target_title_contains。',
    );
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-invalid-update',
      inputItemId: 'input-invalid-update',
      status: 'completed',
      authority: 'direct',
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-valid-update',
      inputItemId: 'input-valid-update',
      authority: 'direct',
    });
    callToolForResponse(
      callbacks,
      'direct-valid-update',
      UPDATE_PROACTIVE_TASK_TOOL_NAME,
      { repeat: true },
    );
    await vi.waitFor(() => {
      expect(harness.scheduler.updateTask).toHaveBeenCalledOnce();
    });
    expect(harness.scheduler.updateTask).toHaveBeenCalledWith({
      targetTitle: 'Watch posture',
      repeat: true,
    });

    session.dispose();
  });

  it('requires selector-less cancel arguments to be exactly empty', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-with-context',
      inputItemId: 'input-with-context',
      authority: 'direct',
    });
    callToolForResponse(
      callbacks,
      'direct-with-context',
      CREATE_PROACTIVE_TIMER_TOOL_NAME,
      {
        title: 'Tea timer',
        duration_sec: 300,
        reminder_text: 'The tea is ready.',
      },
    );
    await vi.waitFor(() => {
      expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(1);
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-with-context',
      inputItemId: 'input-with-context',
      status: 'completed',
      authority: 'direct',
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-invalid-cancel',
      inputItemId: 'input-invalid-cancel',
      authority: 'direct',
    });
    callToolForResponse(
      callbacks,
      'direct-invalid-cancel',
      CANCEL_PROACTIVE_TASK_TOOL_NAME,
      { all: false },
    );
    await vi.waitFor(() => {
      expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(2);
    });
    expect(harness.scheduler.cancelTasks).not.toHaveBeenCalled();

    session.dispose();
  });

  it('requests one silent repair when a completed direct reply promises Proactive work without a tool', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-missed-tool',
      inputItemId: 'input-missed-tool',
      authority: 'direct',
    });
    callbacks.onDirectTranscript?.({
      callEpoch: 1,
      responseId: 'direct-missed-tool',
      inputItemId: 'input-missed-tool',
      entries: [
        { role: 'user', text: '帮我盯着锅。' },
        { role: 'assistant', text: '好的，我会一直帮你盯着锅，冒烟就通知你。' },
      ],
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-missed-tool',
      inputItemId: 'input-missed-tool',
      status: 'completed',
      authority: 'direct',
    });

    expect(realtime.requestProactiveRepair).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('只调用一个匹配的提醒工具'),
      [
        CREATE_PROACTIVE_MONITOR_TOOL_NAME,
        CREATE_LIVE_NARRATION_TOOL_NAME,
        CREATE_PROACTIVE_TIMER_TOOL_NAME,
        UPDATE_PROACTIVE_TASK_TOOL_NAME,
        CANCEL_PROACTIVE_TASK_TOOL_NAME,
      ],
    );

    session.dispose();
  });

  it('keeps the Host out of speaking state for a text-only Proactive repair', async () => {
    const harness = createProactiveHarness();
    const { callbacks, host, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    host.setCallState.mockClear();

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'silent-proactive-repair',
      authority: 'proactive_repair',
    });

    expect(host.setCallState).not.toHaveBeenCalledWith(1, 'speaking');
    session.dispose();
  });

  it('does not infer a Proactive repair from ASR or from a response that called a mutation tool', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-asr-only',
      inputItemId: 'input-asr-only',
      authority: 'direct',
    });
    callbacks.onInputTranscriptDone?.({
      callEpoch: 1,
      itemId: 'input-asr-only',
      text: '我会一直帮你盯着锅，冒烟就通知你。',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-asr-only',
      inputItemId: 'input-asr-only',
      status: 'completed',
      authority: 'direct',
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-with-tool',
      inputItemId: 'input-with-tool',
      authority: 'direct',
    });
    callToolForResponse(
      callbacks,
      'direct-with-tool',
      CREATE_PROACTIVE_TIMER_TOOL_NAME,
      {
        title: 'Tea timer',
        duration_sec: 300,
        reminder_text: 'The tea is ready.',
      },
    );
    callbacks.onDirectTranscript?.({
      callEpoch: 1,
      responseId: 'direct-with-tool',
      inputItemId: 'input-with-tool',
      entries: [
        { role: 'assistant', text: '好的，我会在五分钟后提醒你喝茶。' },
      ],
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-with-tool',
      inputItemId: 'input-with-tool',
      status: 'completed',
      authority: 'direct',
    });

    expect(realtime.requestProactiveRepair).not.toHaveBeenCalled();
    session.dispose();
  });

  it('limits cancel repair to cancel and carries adjacent-task authority into it', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-create',
      inputItemId: 'input-create',
      authority: 'direct',
    });
    callToolForResponse(
      callbacks,
      'direct-create',
      CREATE_PROACTIVE_MONITOR_TOOL_NAME,
      {
        title: 'Watch posture',
        modalities: ['vision'],
        condition: 'The user starts slouching.',
        trigger_response: 'Remind the user to sit upright.',
        repeat: false,
      },
    );
    await vi.waitFor(() => {
      expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(1);
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-create',
      inputItemId: 'input-create',
      status: 'completed',
      authority: 'direct',
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-cancel-claim',
      inputItemId: 'input-cancel-claim',
      authority: 'direct',
    });
    callbacks.onDirectTranscript?.({
      callEpoch: 1,
      responseId: 'direct-cancel-claim',
      inputItemId: 'input-cancel-claim',
      entries: [{ role: 'assistant', text: '好的，已经停止这个提醒任务了。' }],
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-cancel-claim',
      inputItemId: 'input-cancel-claim',
      status: 'completed',
      authority: 'direct',
    });
    expect(realtime.requestProactiveRepair).toHaveBeenCalledWith(
      expect.stringContaining('只调用cancel_proactive_task'),
      [CANCEL_PROACTIVE_TASK_TOOL_NAME],
    );

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'cancel-repair',
      authority: 'proactive_repair',
    });
    callToolForResponse(
      callbacks,
      'cancel-repair',
      CANCEL_PROACTIVE_TASK_TOOL_NAME,
      {},
    );
    await vi.waitFor(() => {
      expect(harness.scheduler.cancelTasks).toHaveBeenCalledOnce();
    });
    expect(harness.scheduler.cancelTasks).toHaveBeenCalledWith({
      targetTitle: 'Watch posture',
    });

    session.dispose();
  });

  it('defers a missing-tool repair through a queued tool continuation and drops it on new speech', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    realtime.requestProactiveRepair.mockReturnValueOnce(false);

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-deferred-repair',
      inputItemId: 'input-deferred-repair',
      authority: 'direct',
    });
    callbacks.onDirectTranscript?.({
      callEpoch: 1,
      responseId: 'direct-deferred-repair',
      inputItemId: 'input-deferred-repair',
      entries: [
        { role: 'assistant', text: '好的，我会一直帮你盯着锅，冒烟就通知你。' },
      ],
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-deferred-repair',
      inputItemId: 'input-deferred-repair',
      status: 'completed',
      authority: 'direct',
    });
    expect(realtime.requestProactiveRepair).toHaveBeenCalledOnce();

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'queued-tool-continuation',
      authority: 'tool_continuation',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'queued-tool-continuation',
      status: 'completed',
      authority: 'tool_continuation',
    });
    expect(realtime.requestProactiveRepair).toHaveBeenCalledTimes(2);

    callbacks.onSpeechStarted?.({ callEpoch: 1 });
    callbacks.onInputCommitted?.({ callEpoch: 1, responsePending: true });
    realtime.requestProactiveRepair.mockClear();
    realtime.requestProactiveRepair.mockReturnValueOnce(false);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-stale-repair',
      inputItemId: 'input-stale-repair',
      authority: 'direct',
    });
    callbacks.onDirectTranscript?.({
      callEpoch: 1,
      responseId: 'direct-stale-repair',
      inputItemId: 'input-stale-repair',
      entries: [
        { role: 'assistant', text: '我会继续听着，听到咳嗽就提醒你。' },
      ],
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-stale-repair',
      inputItemId: 'input-stale-repair',
      status: 'completed',
      authority: 'direct',
    });
    callbacks.onSpeechStarted?.({ callEpoch: 1 });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'another-tool-continuation',
      status: 'completed',
      authority: 'tool_continuation',
    });
    expect(realtime.requestProactiveRepair).toHaveBeenCalledOnce();

    session.dispose();
  });

  it('cancels a deferred repair when the blocking tool continuation performs a Proactive mutation', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    realtime.requestProactiveRepair.mockReturnValueOnce(false);

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-deferred-before-mutation',
      inputItemId: 'input-deferred-before-mutation',
      authority: 'direct',
    });
    callbacks.onDirectTranscript?.({
      callEpoch: 1,
      responseId: 'direct-deferred-before-mutation',
      inputItemId: 'input-deferred-before-mutation',
      entries: [
        { role: 'assistant', text: '好的，我会一直帮你盯着锅，冒烟就通知你。' },
      ],
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-deferred-before-mutation',
      inputItemId: 'input-deferred-before-mutation',
      status: 'completed',
      authority: 'direct',
    });
    expect(realtime.requestProactiveRepair).toHaveBeenCalledOnce();

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'continuation-with-mutation',
      authority: 'tool_continuation',
    });
    callToolForResponse(
      callbacks,
      'continuation-with-mutation',
      CREATE_PROACTIVE_MONITOR_TOOL_NAME,
      {
        title: 'Watch the pot',
        modalities: ['vision'],
        condition: 'Smoke becomes visible above the pot.',
        trigger_response: 'Tell the user that the pot is smoking.',
        repeat: false,
      },
    );
    await vi.waitFor(() => {
      expect(harness.scheduler.createPerceptionMonitor).toHaveBeenCalledOnce();
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'continuation-with-mutation',
      status: 'completed',
      authority: 'tool_continuation',
    });

    expect(realtime.requestProactiveRepair).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('holds queued backend events until a Proactive repair receipt continuation finishes', async () => {
    const harness = createProactiveHarness();
    const { adaptor, callbacks, realtime, session } = await startSession(
      undefined,
      {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      },
    );
    callTool(callbacks, 'handoff', { task: 'run the tests' });
    await awaitReceipts(realtime, 1);
    realtime.sendBackendContext.mockClear();
    realtime.speakToUser.mockClear();

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-needing-repair-receipt',
      inputItemId: 'input-needing-repair-receipt',
      authority: 'direct',
    });
    callbacks.onDirectTranscript?.({
      callEpoch: 1,
      responseId: 'direct-needing-repair-receipt',
      inputItemId: 'input-needing-repair-receipt',
      entries: [
        { role: 'assistant', text: '好的，我会一直帮你盯着锅，冒烟就通知你。' },
      ],
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-needing-repair-receipt',
      inputItemId: 'input-needing-repair-receipt',
      status: 'completed',
      authority: 'direct',
    });
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'repair-with-receipt',
      authority: 'proactive_repair',
    });
    callToolForResponse(
      callbacks,
      'repair-with-receipt',
      CREATE_PROACTIVE_TIMER_TOOL_NAME,
      {
        title: 'Tea timer',
        duration_sec: 300,
        reminder_text: 'The tea is ready.',
      },
    );
    await vi.waitFor(() => {
      expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(2);
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'repair-with-receipt',
      status: 'completed',
      authority: 'proactive_repair',
    });

    adaptor.queue('s1').push({
      type: 'turn_complete',
      jobRef: 'p1',
      summary: 'all tests pass',
    });
    await delay(30);
    expect(realtime.sendBackendContext).not.toHaveBeenCalled();
    expect(realtime.speakToUser).not.toHaveBeenCalled();

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'repair-receipt-continuation',
      authority: 'tool_continuation',
    });
    await delay(30);
    expect(realtime.sendBackendContext).not.toHaveBeenCalled();
    expect(realtime.speakToUser).not.toHaveBeenCalled();

    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'repair-receipt-continuation',
      status: 'completed',
      authority: 'tool_continuation',
    });
    await vi.waitFor(() => {
      expect(realtime.sendBackendContext).toHaveBeenCalledOnce();
      expect(realtime.speakToUser).toHaveBeenCalledOnce();
    });

    session.dispose();
  });

  it('releases a Proactive repair receipt hold when new speech invalidates the continuation', async () => {
    const harness = createProactiveHarness();
    const { adaptor, callbacks, realtime, session } = await startSession(
      undefined,
      {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      },
    );
    callTool(callbacks, 'handoff', { task: 'run the tests' });
    await awaitReceipts(realtime, 1);
    realtime.sendBackendContext.mockClear();
    realtime.speakToUser.mockClear();

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-repair-before-speech',
      inputItemId: 'input-repair-before-speech',
      authority: 'direct',
    });
    callbacks.onDirectTranscript?.({
      callEpoch: 1,
      responseId: 'direct-repair-before-speech',
      inputItemId: 'input-repair-before-speech',
      entries: [
        { role: 'assistant', text: '好的，我会在五分钟后提醒你喝茶。' },
      ],
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-repair-before-speech',
      inputItemId: 'input-repair-before-speech',
      status: 'completed',
      authority: 'direct',
    });
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'repair-invalidated-by-speech',
      authority: 'proactive_repair',
    });
    callToolForResponse(
      callbacks,
      'repair-invalidated-by-speech',
      CREATE_PROACTIVE_TIMER_TOOL_NAME,
      {
        title: 'Tea timer',
        duration_sec: 300,
        reminder_text: 'The tea is ready.',
      },
    );
    await vi.waitFor(() => {
      expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(2);
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'repair-invalidated-by-speech',
      status: 'completed',
      authority: 'proactive_repair',
    });

    adaptor.queue('s1').push({
      type: 'turn_complete',
      jobRef: 'p1',
      summary: 'all tests pass',
    });
    await delay(30);
    expect(realtime.sendBackendContext).not.toHaveBeenCalled();
    expect(realtime.speakToUser).not.toHaveBeenCalled();

    callbacks.onSpeechStarted?.({ callEpoch: 1 });
    callbacks.onInputCommitted?.({ callEpoch: 1, responsePending: true });
    await vi.waitFor(() => {
      expect(realtime.sendBackendContext).toHaveBeenCalledOnce();
      expect(realtime.speakToUser).toHaveBeenCalledOnce();
    });

    session.dispose();
  });

  it('does not repair cancelled or failed direct responses', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    for (const status of ['cancelled', 'failed'] as const) {
      const responseId = `direct-${status}`;
      const inputItemId = `input-${status}`;
      callbacks.onResponseCreated?.({
        callEpoch: 1,
        responseId,
        inputItemId,
        authority: 'direct',
      });
      callbacks.onDirectTranscript?.({
        callEpoch: 1,
        responseId,
        inputItemId,
        entries: [
          {
            role: 'assistant',
            text: '好的，我会一直帮你盯着锅，冒烟就通知你。',
          },
        ],
      });
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId,
        inputItemId,
        status,
        authority: 'direct',
      });
    }

    expect(realtime.requestProactiveRepair).not.toHaveBeenCalled();
    session.dispose();
  });

  it('releases Proactive after a direct response that started before input commit', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    callbacks.onSpeechStarted?.({ callEpoch: 1 });
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'early-direct',
      authority: 'direct',
    });
    callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'late-commit',
      responsePending: false,
    });
    harness.options().onEvent({
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'late-commit-event',
      event: 'Timer is ready.',
    });
    expect(realtime.respondToProactiveEvent).not.toHaveBeenCalled();
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'early-direct',
      authority: 'direct',
      status: 'completed',
    });
    expect(realtime.respondToProactiveEvent).toHaveBeenCalledExactlyOnceWith(
      'Timer is ready.',
    );
    session.dispose();
  });

  it('keeps Proactive events FIFO until playback completes and response.done arrives', async () => {
    const harness = createProactiveHarness();
    const { callbacks, host, realtime, session } = await startSession(
      undefined,
      {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      },
    );
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-1',
      event: 'First proactive event',
    };
    const second: ProactiveDelivery = {
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'delivery-2',
      event: 'Second proactive event',
    };

    expect(harness.options().onEvent(first)).toBe(true);
    expect(harness.options().onEvent(second)).toBe(true);
    expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();
    expect(realtime.respondToProactiveEvent).toHaveBeenCalledWith(first.event);

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-1',
      authority: 'proactive',
    });
    expect(harness.scheduler.announcementStarted).toHaveBeenCalledOnce();
    expect(harness.scheduler.announcementStarted).toHaveBeenCalledWith(first);
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'proactive-1',
      audio: new Uint8Array([1, 2]),
    });
    callbacks.onOutputAudioDone?.({
      callEpoch: 1,
      responseId: 'proactive-1',
    });
    expect(host.finishOutputAudio).not.toHaveBeenCalled();

    session.playbackStarted({ epoch: 1 });
    expect(harness.scheduler.announcementStarted).toHaveBeenCalledOnce();
    expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();

    session.playbackCompleted({ epoch: 1 });
    expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();
    await delay(900);
    expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();

    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-1',
    });
    expect(host.finishOutputAudio).toHaveBeenCalledWith(1);
    expect(
      harness.scheduler.acknowledgeDelivery,
    ).toHaveBeenCalledExactlyOnceWith(first);
    await vi.waitFor(
      () => {
        expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
      },
      { timeout: 2_000 },
    );
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      2,
      second.event,
    );

    session.dispose();
  });

  it('holds queued Proactive events behind active direct playback, then delivers them FIFO', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-after-direct-1',
      event: 'First event queued during the direct answer',
    };
    const second: ProactiveDelivery = {
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'delivery-after-direct-2',
      event: 'Second event queued during the direct answer',
    };

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-playing',
      authority: 'direct',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'direct-playing',
      audio: new Uint8Array([1, 2]),
    });
    session.playbackStarted({ epoch: 1 });

    expect(harness.options().onEvent(first)).toBe(true);
    expect(harness.options().onEvent(second)).toBe(true);
    expect(realtime.respondToProactiveEvent).not.toHaveBeenCalled();

    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-playing',
      authority: 'direct',
    });
    await delay(900);
    expect(realtime.respondToProactiveEvent).not.toHaveBeenCalled();

    session.playbackCompleted({ epoch: 1 });
    await vi.waitFor(
      () => {
        expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();
      },
      { timeout: 2_000 },
    );
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      1,
      first.event,
    );

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-after-direct-1',
      authority: 'proactive',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'proactive-after-direct-1',
      audio: new Uint8Array([3, 4]),
    });
    session.playbackStarted({ epoch: 1 });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-after-direct-1',
      authority: 'proactive',
    });
    await delay(900);
    expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();

    session.playbackCompleted({ epoch: 1 });
    await vi.waitFor(
      () => {
        expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
      },
      { timeout: 2_000 },
    );
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      2,
      second.event,
    );

    session.dispose();
  });

  it('keeps the next Proactive event blocked when response.done precedes playback completion', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-1',
      event: 'First proactive event',
    };
    const second: ProactiveDelivery = {
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'delivery-2',
      event: 'Second proactive event',
    };

    harness.options().onEvent(first);
    harness.options().onEvent(second);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-1',
      authority: 'proactive',
    });
    session.playbackStarted({ epoch: 1 });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-1',
    });

    await delay(900);
    expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();
    expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();

    session.playbackCompleted({ epoch: 1 });
    expect(harness.scheduler.acknowledgeDelivery).toHaveBeenCalledWith(first);
    await vi.waitFor(
      () => {
        expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
      },
      { timeout: 2_000 },
    );
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      2,
      second.event,
    );

    session.dispose();
  });

  it('fails a Proactive delivery without Host playback ACKs and releases the next FIFO item', async () => {
    const proactive = structuredClone(DEFAULT_PROACTIVE_CONFIG);
    proactive.scheduler.repeat.maxWaitTtsSec = 0.05;
    let scheduler: ProactiveScheduler | undefined;
    const rig = await startSession(undefined, {
      proactive,
      createProactiveScheduler: (options) => {
        scheduler = new ProactiveScheduler(options);
        return scheduler;
      },
    });
    const { callbacks, host, log, realtime, session } = rig;
    if (!scheduler) throw new Error('Proactive scheduler was not created');

    scheduler.createTimer({
      title: 'First timer',
      durationSec: 0.001,
      reminderText: 'First timer finished.',
    });
    scheduler.createTimer({
      title: 'Second timer',
      durationSec: 0.001,
      reminderText: 'Second timer finished.',
    });
    await vi.waitFor(() => {
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();
    });
    const firstEvent = realtime.respondToProactiveEvent.mock.calls[0]?.[0];

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-without-host-ack',
      authority: 'proactive',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'proactive-without-host-ack',
      audio: new Uint8Array([1, 2]),
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-without-host-ack',
      status: 'completed',
      authority: 'proactive',
    });

    await delay(20);
    expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
    });

    expect(realtime.respondToProactiveEvent.mock.calls[1]?.[0]).not.toBe(
      firstEvent,
    );
    expect(realtime.cancelResponse).toHaveBeenCalledOnce();
    expect(host.clearOutput).toHaveBeenCalledOnce();
    expect(log.write).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        source: 'proactive_task',
        message: 'Proactive announcement playback acknowledgement timed out.',
      }),
    );

    session.dispose();
  });

  it('retries Proactive playback cleared by user speech after response.done', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-cleared-after-done',
      event: 'First proactive event',
    };
    const second: ProactiveDelivery = {
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'delivery-after-cleared',
      event: 'Second proactive event',
    };

    harness.options().onEvent(first);
    harness.options().onEvent(second);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-cleared-after-done',
      authority: 'proactive',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'proactive-cleared-after-done',
      audio: new Uint8Array([1, 2]),
    });
    session.playbackStarted({ epoch: 1 });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-cleared-after-done',
      status: 'completed',
      authority: 'proactive',
    });

    callbacks.onSpeechStarted?.({ callEpoch: 1 });

    expect(harness.scheduler.deferDelivery).toHaveBeenCalledWith(first);
    expect(harness.scheduler.failDelivery).not.toHaveBeenCalled();
    expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();

    callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-user',
      responsePending: true,
    });
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-after-cleared',
      authority: 'direct',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-after-cleared',
      status: 'completed',
      authority: 'direct',
    });

    expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      2,
      first.event,
    );

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-retry-after-cleared',
      authority: 'proactive',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'proactive-retry-after-cleared',
      audio: new Uint8Array([3, 4]),
    });
    session.playbackStarted({ epoch: 1 });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-retry-after-cleared',
      status: 'completed',
      authority: 'proactive',
    });
    session.playbackCompleted({ epoch: 1 });
    await vi.waitFor(
      () => {
        expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(3);
      },
      { timeout: 2_000 },
    );
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      3,
      second.event,
    );

    session.dispose();
  });

  it('ignores a late playback receipt after cleared Proactive output', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-late-playback',
      event: 'First proactive event',
    };
    const second: ProactiveDelivery = {
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'delivery-after-late-playback',
      event: 'Second proactive event',
    };

    harness.options().onEvent(first);
    harness.options().onEvent(second);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-before-late-receipt',
      authority: 'proactive',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'proactive-before-late-receipt',
      audio: new Uint8Array([1, 2]),
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-before-late-receipt',
      status: 'completed',
      authority: 'proactive',
    });
    callbacks.onSpeechStarted?.({ callEpoch: 1 });

    session.playbackStarted({ epoch: 1 });
    callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-user',
      responsePending: true,
    });
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-after-late-receipt',
      authority: 'direct',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-after-late-receipt',
      status: 'completed',
      authority: 'direct',
    });

    expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      2,
      first.event,
    );

    session.dispose();
  });

  it('fails a Proactive response without audio and releases the next FIFO item', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-failed',
      event: 'First proactive event',
    };
    const second: ProactiveDelivery = {
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'delivery-after-failure',
      event: 'Second proactive event',
    };

    harness.options().onEvent(first);
    harness.options().onEvent(second);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-failed',
      authority: 'proactive',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-failed',
      status: 'failed',
      authority: 'proactive',
    });

    expect(harness.scheduler.failDelivery).toHaveBeenCalledWith(
      first,
      expect.stringContaining('failed'),
    );
    await vi.waitFor(() => {
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
    });
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      2,
      second.event,
    );
    expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();

    session.dispose();
  });

  it('settles a failed Proactive delivery before releasing an already-drained playback cycle', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-late-failure',
      event: 'First proactive event',
    };
    const second: ProactiveDelivery = {
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'delivery-after-late-failure',
      event: 'Second proactive event',
    };

    harness.options().onEvent(first);
    harness.options().onEvent(second);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-late-failure',
      authority: 'proactive',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'proactive-late-failure',
      audio: new Uint8Array([1, 2]),
    });
    session.playbackStarted({ epoch: 1 });
    session.playbackCompleted({ epoch: 1 });

    expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();
    expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();

    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-late-failure',
      status: 'failed',
      authority: 'proactive',
    });

    expect(harness.scheduler.failDelivery).toHaveBeenCalledWith(
      first,
      expect.stringContaining('failed'),
    );
    expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();
    await vi.waitFor(
      () => {
        expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
      },
      { timeout: 2_000 },
    );
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      2,
      second.event,
    );

    session.dispose();
  });

  it('fails a completed Proactive response with no audio and never ACKs later direct playback', async () => {
    const harness = createProactiveHarness();
    const { callbacks, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    const delivery: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-no-audio',
      event: 'Proactive event without audio',
    };

    harness.options().onEvent(delivery);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-no-audio',
      authority: 'proactive',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-no-audio',
      status: 'completed',
      authority: 'proactive',
    });

    expect(harness.scheduler.failDelivery).toHaveBeenCalledWith(
      delivery,
      expect.stringContaining('without audio'),
    );
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'later-direct',
      authority: 'direct',
    });
    session.playbackStarted({ epoch: 1 });
    session.playbackCompleted({ epoch: 1 });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'later-direct',
      status: 'completed',
      authority: 'direct',
    });
    expect(
      harness.scheduler.announcementStarted,
    ).toHaveBeenCalledExactlyOnceWith(delivery);
    expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();

    session.dispose();
  });

  it('completes real Proactive audio suppressed by an existing output mute', async () => {
    const harness = createProactiveHarness();
    const { callbacks, host, realtime, session } = await startSession(
      undefined,
      {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      },
    );
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-muted',
      event: 'Muted proactive event',
    };
    const second: ProactiveDelivery = {
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'delivery-after-muted',
      event: 'Next proactive event',
    };
    host.setOutputMuted(true);

    harness.options().onEvent(first);
    harness.options().onEvent(second);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-muted',
      authority: 'proactive',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'proactive-muted',
      audio: new Uint8Array([1, 2]),
    });
    expect(host.sendOutputAudio).not.toHaveBeenCalled();
    expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();

    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-muted',
      status: 'completed',
      authority: 'proactive',
    });
    expect(harness.scheduler.acknowledgeDelivery).toHaveBeenCalledWith(first);
    expect(harness.scheduler.failDelivery).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
    });
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      2,
      second.event,
    );

    session.dispose();
  });

  it('releases active playback when output is muted and completes after response.done', async () => {
    const harness = createProactiveHarness();
    const { callbacks, host, realtime, session } = await startSession(
      undefined,
      {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      },
    );
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-muted-during-playback',
      event: 'Playing proactive event',
    };
    const second: ProactiveDelivery = {
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'delivery-after-playback-mute',
      event: 'Next proactive event',
    };

    harness.options().onEvent(first);
    harness.options().onEvent(second);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-playing-at-mute',
      authority: 'proactive',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'proactive-playing-at-mute',
      audio: new Uint8Array([1, 2]),
    });
    session.playbackStarted({ epoch: 1 });
    host.setOutputMuted(true);
    session.outputMuted({ epoch: 1 });

    expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-playing-at-mute',
      status: 'completed',
      authority: 'proactive',
    });
    expect(harness.scheduler.acknowledgeDelivery).toHaveBeenCalledWith(first);
    expect(harness.scheduler.failDelivery).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
    });
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      2,
      second.event,
    );

    session.dispose();
  });

  it('releases a completed Proactive response when its remaining playback is muted', async () => {
    const harness = createProactiveHarness();
    const { callbacks, host, realtime, session } = await startSession(
      undefined,
      {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      },
    );
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-response-done-before-mute',
      event: 'Completed response with playback still active',
    };
    const second: ProactiveDelivery = {
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'delivery-after-response-done-mute',
      event: 'Next proactive event',
    };

    harness.options().onEvent(first);
    harness.options().onEvent(second);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-response-done-before-mute',
      authority: 'proactive',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'proactive-response-done-before-mute',
      audio: new Uint8Array([1, 2]),
    });
    session.playbackStarted({ epoch: 1 });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-response-done-before-mute',
      status: 'completed',
      authority: 'proactive',
    });

    expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();
    expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(1);

    host.setOutputMuted(true);
    session.outputMuted({ epoch: 1 });

    expect(harness.scheduler.acknowledgeDelivery).toHaveBeenCalledWith(first);
    await vi.waitFor(() => {
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
    });
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      2,
      second.event,
    );

    session.dispose();
  });

  it('ignores a late playback-start receipt after mute clears foreground audio', async () => {
    const harness = createProactiveHarness();
    const { callbacks, host, realtime, session } = await startSession(
      undefined,
      {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      },
    );
    const delivery: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-after-late-playback-start',
      event: 'Delivery after muted foreground playback',
    };

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-before-mute',
      authority: 'direct',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'direct-before-mute',
      audio: new Uint8Array([1, 2]),
    });
    session.playbackStarted({ epoch: 1 });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-before-mute',
      status: 'completed',
      authority: 'direct',
    });

    host.setOutputMuted(true);
    session.outputMuted({ epoch: 1 });
    session.playbackStarted({ epoch: 1 });
    harness.options().onEvent(delivery);

    expect(realtime.respondToProactiveEvent).toHaveBeenCalledExactlyOnceWith(
      delivery.event,
    );

    session.dispose();
  });

  it.each(['failed', 'cancelled'] as const)(
    'does not turn a %s response into success merely because its audio was muted',
    async (status) => {
      const harness = createProactiveHarness();
      const { callbacks, host, session } = await startSession(undefined, {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      });
      const delivery: ProactiveDelivery = {
        taskId: 'task-monitor',
        taskGeneration: 1,
        deliveryId: `delivery-muted-${status}`,
        event: 'Muted terminal proactive event',
      };
      host.setOutputMuted(true);

      harness.options().onEvent(delivery);
      callbacks.onResponseCreated?.({
        callEpoch: 1,
        responseId: `proactive-muted-${status}`,
        authority: 'proactive',
      });
      callbacks.onOutputAudioDelta?.({
        callEpoch: 1,
        responseId: `proactive-muted-${status}`,
        audio: new Uint8Array([1, 2]),
      });
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId: `proactive-muted-${status}`,
        status,
        authority: 'proactive',
      });

      expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();
      if (status === 'cancelled') {
        await vi.waitFor(() => {
          expect(harness.scheduler.failDelivery).toHaveBeenCalledOnce();
        });
      }
      expect(harness.scheduler.failDelivery).toHaveBeenCalledWith(
        delivery,
        expect.stringContaining(status === 'failed' ? 'failed' : 'cancelled'),
      );

      session.dispose();
    },
  );

  it('fails a cancelled Proactive response even after playback completed', async () => {
    const harness = createProactiveHarness();
    const { callbacks, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    const delivery: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-cancelled-after-playback',
      event: 'Cancelled after its audio drained',
    };

    harness.options().onEvent(delivery);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-cancelled-after-playback',
      authority: 'proactive',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'proactive-cancelled-after-playback',
      audio: new Uint8Array([1, 2]),
    });
    session.playbackStarted({ epoch: 1 });
    session.playbackCompleted({ epoch: 1 });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-cancelled-after-playback',
      status: 'cancelled',
      authority: 'proactive',
      cancellationReason: 'client_cancelled',
    });

    expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();
    expect(harness.scheduler.failDelivery).toHaveBeenCalledWith(
      delivery,
      expect.stringContaining('cancelled'),
    );

    session.dispose();
  });

  it('retries a user-interrupted Proactive delivery before later FIFO items', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-interrupted',
      event: 'First proactive event',
    };
    const second: ProactiveDelivery = {
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'delivery-after-interrupt',
      event: 'Second proactive event',
    };

    harness.options().onEvent(first);
    harness.options().onEvent(second);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-interrupted',
      authority: 'proactive',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'proactive-interrupted',
      audio: new Uint8Array([1, 2]),
    });
    session.playbackStarted({ epoch: 1 });
    callbacks.onSpeechStarted?.({ callEpoch: 1 });
    callbacks.onBargeIn?.({
      callEpoch: 1,
      responseId: 'proactive-interrupted',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-interrupted',
      status: 'cancelled',
      authority: 'proactive',
      cancellationReason: 'user_interrupted',
    });

    expect(harness.scheduler.deferDelivery).toHaveBeenCalledWith(first);
    expect(harness.scheduler.failDelivery).not.toHaveBeenCalled();
    expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();

    callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-user',
      responsePending: true,
    });
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-after-interrupt',
      authority: 'direct',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-after-interrupt',
      status: 'completed',
      authority: 'direct',
    });
    expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      2,
      first.event,
    );

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-retry',
      authority: 'proactive',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'proactive-retry',
      audio: new Uint8Array([3, 4]),
    });
    session.playbackStarted({ epoch: 1 });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-retry',
      status: 'completed',
      authority: 'proactive',
    });
    session.playbackCompleted({ epoch: 1 });
    await vi.waitFor(
      () => {
        expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(3);
      },
      { timeout: 2_000 },
    );
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      3,
      second.event,
    );

    session.dispose();
  });

  it('retries a Proactive cancellation followed by VAD within the grace window in FIFO order', async () => {
    const harness = createProactiveHarness();
    vi.useFakeTimers();
    const starting = startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    await vi.advanceTimersByTimeAsync(0);
    const { callbacks, host, realtime, session } = await starting;
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'cancel-before-vad',
      event: 'Interrupted Proactive event',
    };
    const second: ProactiveDelivery = {
      ...first,
      taskId: 'task-timer',
      deliveryId: 'after-cancel-before-vad',
      event: 'Later Proactive event',
    };
    const debug = vi
      .spyOn(LiveLogger.prototype, 'debug')
      .mockImplementation(() => {});
    try {
      harness.options().onEvent(first);
      harness.options().onEvent(second);
      callbacks.onResponseCreated?.({
        callEpoch: 1,
        responseId: 'cancel-before-vad-response',
        authority: 'proactive',
      });
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId: 'cancel-before-vad-response',
        authority: 'proactive',
        status: 'cancelled',
      });
      expect(host.finishOutputAudio).toHaveBeenCalledOnce();
      expect(host.states.at(-1)).toBe('listening');
      expect(harness.scheduler.failDelivery).not.toHaveBeenCalled();
      expect(harness.scheduler.deferDelivery).not.toHaveBeenCalled();
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();
      expect(debug).toHaveBeenCalledWith(
        `proactive.cancel_grace_wait ${JSON.stringify({
          epoch: 1,
          taskId: first.taskId,
          deliveryId: first.deliveryId,
          responseId: 'cancel-before-vad-response',
          graceMs: 250,
        })}`,
      );

      vi.advanceTimersByTime(15);
      callbacks.onSpeechStarted?.({ callEpoch: 1, itemId: 'new-input' });
      expect(harness.scheduler.deferDelivery).toHaveBeenCalledExactlyOnceWith(
        first,
      );
      expect(debug).toHaveBeenCalledWith(
        `proactive.delivery_requeued ${JSON.stringify({
          epoch: 1,
          taskId: first.taskId,
          deliveryId: first.deliveryId,
          reason: 'user_interrupted',
        })}`,
      );
      vi.advanceTimersByTime(250);
      expect(harness.scheduler.failDelivery).not.toHaveBeenCalled();
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();

      callbacks.onInputCommitted?.({
        callEpoch: 1,
        itemId: 'new-input',
        responsePending: true,
      });
      callbacks.onResponseCreated?.({
        callEpoch: 1,
        responseId: 'new-direct-response',
        authority: 'direct',
      });
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId: 'new-direct-response',
        authority: 'direct',
        status: 'completed',
      });
      expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
        2,
        first.event,
      );
      expect(realtime.respondToProactiveEvent).not.toHaveBeenCalledWith(
        second.event,
      );
      callbacks.onResponseCreated?.({
        callEpoch: 1,
        responseId: 'retry-response',
        authority: 'proactive',
      });
      callbacks.onOutputAudioDelta?.({
        callEpoch: 1,
        responseId: 'retry-response',
        audio: new Uint8Array([1, 2]),
      });
      session.playbackStarted({ epoch: 1 });
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId: 'retry-response',
        authority: 'proactive',
        status: 'completed',
      });
      session.playbackCompleted({ epoch: 1 });
      vi.advanceTimersByTime(800);
      expect(
        harness.scheduler.acknowledgeDelivery,
      ).toHaveBeenCalledExactlyOnceWith(first);
      expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
        3,
        second.event,
      );
      expect(realtime.commitInputAudio).not.toHaveBeenCalled();
    } finally {
      session.dispose();
      debug.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fails an unclassified Proactive cancellation after exactly 250 ms without VAD', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'cancel-grace-expiry',
      event: 'Cancelled Proactive event',
    };
    const second = {
      ...first,
      deliveryId: 'after-grace-expiry',
      event: 'Next event',
    };
    const debug = vi
      .spyOn(LiveLogger.prototype, 'debug')
      .mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      harness.options().onEvent(first);
      harness.options().onEvent(second);
      callbacks.onResponseCreated?.({
        callEpoch: 1,
        responseId: 'grace-expiry-response',
        authority: 'proactive',
      });
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId: 'grace-expiry-response',
        authority: 'proactive',
        status: 'cancelled',
      });
      vi.advanceTimersByTime(249);
      expect(harness.scheduler.failDelivery).not.toHaveBeenCalled();
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1);
      expect(harness.scheduler.failDelivery).toHaveBeenCalledExactlyOnceWith(
        first,
        'Foreground Realtime cancelled a Proactive event.',
      );
      expect(debug).toHaveBeenCalledWith(
        `proactive.cancel_grace_expired ${JSON.stringify({
          epoch: 1,
          taskId: first.taskId,
          deliveryId: first.deliveryId,
          responseId: 'grace-expiry-response',
        })}`,
      );
      expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
        2,
        second.event,
      );
      vi.advanceTimersByTime(1_000);
      expect(harness.scheduler.failDelivery).toHaveBeenCalledOnce();
      expect(harness.scheduler.deferDelivery).not.toHaveBeenCalled();
    } finally {
      session.dispose();
      debug.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['playback_completed', 'muted'] as const)(
    'does not ACK a cancelled Proactive response when %s arrives during cancellation grace',
    async (receipt) => {
      const harness = createProactiveHarness();
      const { callbacks, host, session } = await startSession(undefined, {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      });
      const delivery: ProactiveDelivery = {
        taskId: 'task-monitor',
        taskGeneration: 1,
        deliveryId: `cancel-grace-${receipt}`,
        event: 'Cancelled event',
      };
      vi.useFakeTimers();
      try {
        harness.options().onEvent(delivery);
        callbacks.onResponseCreated?.({
          callEpoch: 1,
          responseId: 'cancel-grace-with-audio',
          authority: 'proactive',
        });
        callbacks.onOutputAudioDelta?.({
          callEpoch: 1,
          responseId: 'cancel-grace-with-audio',
          audio: new Uint8Array([1, 2]),
        });
        session.playbackStarted({ epoch: 1 });
        callbacks.onResponseDone?.({
          callEpoch: 1,
          responseId: 'cancel-grace-with-audio',
          authority: 'proactive',
          status: 'cancelled',
        });
        if (receipt === 'playback_completed')
          session.playbackCompleted({ epoch: 1 });
        else {
          host.setOutputMuted(true);
          session.outputMuted({ epoch: 1 });
        }
        expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();
        vi.advanceTimersByTime(250);
        expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();
        expect(harness.scheduler.failDelivery).toHaveBeenCalledOnce();
      } finally {
        session.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(['client_cancelled', 'superseded'] as const)(
    'does not delay or retry a Proactive cancellation attributed to %s',
    async (cancellationReason) => {
      const harness = createProactiveHarness();
      const { callbacks, session } = await startSession(undefined, {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      });
      const delivery: ProactiveDelivery = {
        taskId: 'task-monitor',
        taskGeneration: 1,
        deliveryId: cancellationReason,
        event: 'Explicitly cancelled event',
      };
      vi.useFakeTimers();
      try {
        harness.options().onEvent(delivery);
        callbacks.onResponseCreated?.({
          callEpoch: 1,
          responseId: 'explicit-cancel-response',
          authority: 'proactive',
        });
        callbacks.onResponseDone?.({
          callEpoch: 1,
          responseId: 'explicit-cancel-response',
          authority: 'proactive',
          status: 'cancelled',
          cancellationReason,
        });
        expect(harness.scheduler.failDelivery).toHaveBeenCalledOnce();
        callbacks.onSpeechStarted?.({ callEpoch: 1 });
        vi.advanceTimersByTime(250);
        expect(harness.scheduler.deferDelivery).not.toHaveBeenCalled();
        expect(harness.scheduler.failDelivery).toHaveBeenCalledOnce();
      } finally {
        session.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(['invalidate', 'dispose', 'stop', 'replace_call'] as const)(
    'clears Proactive cancellation grace on %s',
    async (action) => {
      const harness = createProactiveHarness();
      const { callbacks, currentCallbacks, realtime, session } =
        await startSession(undefined, {
          proactive: DEFAULT_PROACTIVE_CONFIG,
          createProactiveScheduler: harness.createScheduler,
        });
      const delivery: ProactiveDelivery = {
        taskId: 'task-monitor',
        taskGeneration: 1,
        deliveryId: `grace-clear-${action}`,
        event: 'Cancelled event',
      };
      vi.useFakeTimers();
      try {
        harness.options().onEvent(delivery);
        callbacks.onResponseCreated?.({
          callEpoch: 1,
          responseId: 'grace-clear-response',
          authority: 'proactive',
        });
        callbacks.onResponseDone?.({
          callEpoch: 1,
          responseId: 'grace-clear-response',
          authority: 'proactive',
          status: 'cancelled',
        });
        expect(vi.getTimerCount()).toBe(1);
        if (action === 'invalidate')
          harness.options().onDeliveryInvalidated?.(delivery);
        else if (action === 'dispose') session.dispose();
        else if (action === 'stop')
          await session.stop({ epoch: 1, callId: 'call-1' });
        else {
          const started = session.start({
            epoch: 2,
            callId: 'replacement-call',
            mode: 'new',
            visualInput: DEFAULT_VISUAL_INPUT,
          });
          await vi.advanceTimersByTimeAsync(0);
          await started;
        }
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(1_000);
        currentCallbacks().onSpeechStarted?.({
          callEpoch: action === 'replace_call' ? 2 : 1,
        });
        expect(harness.scheduler.failDelivery).not.toHaveBeenCalled();
        expect(harness.scheduler.deferDelivery).not.toHaveBeenCalled();
        expect(harness.scheduler.acknowledgeDelivery).not.toHaveBeenCalled();
        expect(realtime.cancelResponse).not.toHaveBeenCalled();
      } finally {
        session.dispose();
        vi.useRealTimers();
      }
    },
  );

  it('settles a cancelled Proactive grace before a replacement response without later clearing its audio', async () => {
    const harness = createProactiveHarness();
    const { callbacks, host, realtime, session } = await startSession(
      undefined,
      {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      },
    );
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'grace-replaced-response',
      event: 'Cancelled event',
    };
    const second = {
      ...first,
      deliveryId: 'after-replaced-response',
      event: 'Next event',
    };
    vi.useFakeTimers();
    try {
      harness.options().onEvent(first);
      harness.options().onEvent(second);
      callbacks.onResponseCreated?.({
        callEpoch: 1,
        responseId: 'cancelled-before-replacement',
        authority: 'proactive',
      });
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId: 'cancelled-before-replacement',
        authority: 'proactive',
        status: 'cancelled',
      });
      callbacks.onResponseCreated?.({
        callEpoch: 1,
        responseId: 'replacement-direct',
        authority: 'direct',
      });
      expect(harness.scheduler.failDelivery).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();
      host.clearOutput.mockClear();
      callbacks.onOutputAudioDelta?.({
        callEpoch: 1,
        responseId: 'replacement-direct',
        audio: new Uint8Array([1, 2]),
      });
      vi.advanceTimersByTime(250);
      expect(host.clearOutput).not.toHaveBeenCalled();
      expect(host.states.at(-1)).toBe('speaking');
      expect(harness.scheduler.failDelivery).toHaveBeenCalledOnce();
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledOnce();
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it('retries a Proactive request cancelled by speech before response.created', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-pending-interrupt',
      event: 'Pending proactive event',
    };
    const second: ProactiveDelivery = {
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'delivery-after-pending-interrupt',
      event: 'Later proactive event',
    };

    harness.options().onEvent(first);
    harness.options().onEvent(second);
    callbacks.onSpeechStarted?.({ callEpoch: 1 });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'cancelled-before-created',
      status: 'cancelled',
      authority: 'proactive',
      cancellationReason: 'user_interrupted',
    });
    expect(harness.scheduler.deferDelivery).toHaveBeenCalledWith(first);

    callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-user',
      responsePending: true,
    });
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-after-pending-interrupt',
      authority: 'direct',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-after-pending-interrupt',
      status: 'completed',
      authority: 'direct',
    });

    expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      2,
      first.event,
    );
    expect(realtime.respondToProactiveEvent).not.toHaveBeenCalledWith(
      second.event,
    );

    session.dispose();
  });

  it('does not replay an explicitly cancelled active Proactive delivery', async () => {
    const harness = createProactiveHarness();
    const { callbacks, realtime, session } = await startSession(undefined, {
      proactive: DEFAULT_PROACTIVE_CONFIG,
      createProactiveScheduler: harness.createScheduler,
    });
    const first: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-explicitly-cancelled',
      event: 'Cancelled proactive event',
    };
    const second: ProactiveDelivery = {
      taskId: 'task-timer',
      taskGeneration: 1,
      deliveryId: 'delivery-after-explicit-cancel',
      event: 'Next proactive event',
    };

    harness.options().onEvent(first);
    harness.options().onEvent(second);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-explicitly-cancelled',
      authority: 'proactive',
    });
    harness.options().onDeliveryInvalidated?.(first);
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'proactive-explicitly-cancelled',
      status: 'cancelled',
      authority: 'proactive',
      cancellationReason: 'client_cancelled',
    });

    expect(realtime.cancelResponse).toHaveBeenCalledOnce();
    expect(harness.scheduler.deferDelivery).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(realtime.respondToProactiveEvent).toHaveBeenCalledTimes(2);
    });
    expect(realtime.respondToProactiveEvent).toHaveBeenNthCalledWith(
      2,
      second.event,
    );

    session.dispose();
  });

  it('keeps the Host listening when invalidation cancels response.created synchronously', async () => {
    const harness = createProactiveHarness();
    const { callbacks, host, realtime, session } = await startSession(
      undefined,
      {
        proactive: DEFAULT_PROACTIVE_CONFIG,
        createProactiveScheduler: harness.createScheduler,
      },
    );
    const delivery: ProactiveDelivery = {
      taskId: 'task-monitor',
      taskGeneration: 1,
      deliveryId: 'delivery-invalidated-before-created',
      event: 'Invalidated before response.created',
    };

    harness.options().onEvent(delivery);
    harness.options().onDeliveryInvalidated?.(delivery);
    realtime.cancelResponse.mockImplementationOnce(() => {
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId: 'proactive-invalidated-before-created',
        status: 'cancelled',
        authority: 'proactive',
        cancellationReason: 'client_cancelled',
      });
      return true;
    });

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'proactive-invalidated-before-created',
      authority: 'proactive',
    });

    expect(realtime.cancelResponse).toHaveBeenCalledOnce();
    expect(host.states.at(-1)).toBe('listening');

    session.dispose();
  });

  it('logs each transcript once while draining direct transcript delivery', async () => {
    const { callbacks, log } = await startSession();

    callbacks.onInputTranscriptDone?.({
      callEpoch: 1,
      itemId: 'input_1',
      text: 'hello',
    });
    callbacks.onOutputTextDone?.({
      callEpoch: 1,
      responseId: 'resp_1',
      inputItemId: 'input_1',
      text: 'hi',
      source: 'audio_transcript',
    });
    callbacks.onDirectTranscript?.({
      callEpoch: 1,
      responseId: 'resp_1',
      inputItemId: 'input_1',
      entries: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi' },
      ],
    });

    const transcripts = log.write.mock.calls.filter(
      ([type]) => type === 'transcript.user' || type === 'transcript.assistant',
    );
    expect(transcripts).toEqual([
      ['transcript.user', { text: 'hello' }],
      ['transcript.assistant', { text: 'hi' }],
    ]);
  });

  it('keeps partial direct output that never emitted a done callback', async () => {
    const { callbacks, log } = await startSession();

    callbacks.onInputTranscriptDone?.({
      callEpoch: 1,
      itemId: 'input_1',
      text: 'hello',
    });
    callbacks.onOutputTextDelta?.({
      callEpoch: 1,
      responseId: 'resp_1',
      text: 'partial answer',
      source: 'audio_transcript',
    });
    callbacks.onDirectTranscript?.({
      callEpoch: 1,
      responseId: 'resp_1',
      inputItemId: 'input_1',
      entries: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'partial answer' },
      ],
    });

    const transcripts = log.write.mock.calls.filter(
      ([type]) => type === 'transcript.user' || type === 'transcript.assistant',
    );
    expect(transcripts).toEqual([
      ['transcript.user', { text: 'hello' }],
      ['transcript.assistant', { text: 'partial answer', direct: true }],
    ]);
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
    expect(host.captureVisualContext).toHaveBeenCalledWith('call-1', {
      persistAsset: true,
    });
    expect(realtime.submitFunctionOutput).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
    );
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

  it('returns Camera appshot through the same asset receipt path', async () => {
    const { callbacks, host, realtime } = await startSession(undefined, {
      visualInput: { ...DEFAULT_VISUAL_INPUT, source: 'camera' },
      capture: {
        source: 'camera',
        image: TEST_JPEG,
        width: 1280,
        height: 720,
        screenshotPath: pngPath,
      },
    });

    callTool(callbacks, 'appshot', {});
    const [receipt] = await awaitReceipts(realtime, 1);

    expect(host.captureVisualContext).toHaveBeenCalledWith('call-1', {
      persistAsset: true,
    });
    expect(realtime.submitFunctionOutput).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
    );
    expect(receipt).toMatchObject({
      status: 'ok',
      source: 'camera',
      width: 1280,
      height: 720,
      asset: 'asset_1',
    });
    expect(receipt).not.toHaveProperty('image_delivery');
  });

  it('fails the call when an active Realtime response rejects a tool result', async () => {
    const { callbacks, host, log, realtime } = await startSession();
    realtime.submitFunctionOutput.mockReturnValue(false);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'active-tool-response',
      authority: 'direct',
    });
    callToolForResponse(callbacks, 'active-tool-response', 'session_list', {});
    await vi.waitFor(() => {
      expect(host.failCall).toHaveBeenCalledWith(
        1,
        liveMessage('runtime.toolResultFailed'),
      );
    });

    expect(log.write).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        source: 'tool_output',
        message: 'Realtime rejected the tool result.',
      }),
    );
    expect(realtime.close).toHaveBeenCalledWith({ discardPendingInput: true });
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
      {
        handle: 'session_1',
        backend: 'fake',
        label: 'One',
        cwd: '/tmp/a',
        state: 'idle',
      },
      { handle: 'session_2', backend: 'fake', state: 'busy' },
    ]);
  });

  it('session_stop targets the exact job and awaits its terminal confirmation', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'long task' });
    await awaitReceipts(realtime, 1);

    callTool(callbacks, 'session_stop', { job: 'job_1' });
    const [, stopReceipt] = await awaitReceipts(realtime, 2);

    expect(adaptor.cancelJob).toHaveBeenCalledExactlyOnceWith(
      { id: 's1', adaptor: 'fake' },
      'p1',
    );
    expect(adaptor.cancel).not.toHaveBeenCalled();
    expect(stopReceipt).toMatchObject({
      status: 'cancelling',
      session: 'session_1',
    });

    adaptor
      .queue('s1')
      .push({ type: 'turn_error', jobRef: 'p1', error: 'cancelled' });
    await delay(10);
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
    expect(realtime.speakToUser.mock.calls[0]?.[0]).toBe(
      'The task to run the tests finished. done: all tests pass',
    );

    adaptor.promptReceipt = { status: 'accepted', jobRef: 'p2' };
    callTool(callbacks, 'handoff', { task: 'run lint' });
    await awaitReceipts(realtime, 2);
    queue.push({ type: 'turn_error', jobRef: 'p2', error: 'lint exploded' });
    await vi.waitFor(() => {
      expect(realtime.sendBackendContext).toHaveBeenCalledTimes(2);
    });
    expect(realtime.sendBackendContext.mock.calls[1]?.[0]).toMatch(
      /^\[ERROR job_2\]/,
    );
  });

  it('uses only active-epoch Host playback receipts to reopen injection', async () => {
    const { adaptor, callbacks, realtime, session } = await startSession();

    callTool(callbacks, 'handoff', { task: 'watch for changes' });
    await awaitReceipts(realtime, 1);
    const queue = adaptor.queue('s1');

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'active-response',
      authority: 'direct',
    });
    queue.push({
      type: 'turn_complete',
      jobRef: 'p1',
      summary: 'The watched change finished.',
    });
    await delay(30);
    expect(realtime.speakToUser).not.toHaveBeenCalled();

    session.playbackStarted({ epoch: 1 });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'active-response',
    });

    await delay(900);
    expect(realtime.speakToUser).not.toHaveBeenCalled();

    // A receipt from an earlier call must not release the queued item.
    session.playbackCompleted({ epoch: 0 });
    await delay(900);
    expect(realtime.speakToUser).not.toHaveBeenCalled();

    session.playbackCompleted({ epoch: 1 });
    await vi.waitFor(
      () => {
        expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
      },
      { timeout: 2_000 },
    );
    expect(realtime.sendBackendContext).toHaveBeenCalledTimes(1);
  });

  it('holds backend completion through speech stop and merges it on input commit', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'search the news' });
    await awaitReceipts(realtime, 1);
    callbacks.onSpeechStarted?.({ callEpoch: 1 });
    adaptor.queue('s1').push({
      type: 'turn_complete',
      jobRef: 'p1',
      summary: 'news found',
    });
    await delay(30);

    expect(realtime.sendBackendContext).not.toHaveBeenCalled();
    expect(realtime.speakToUser).not.toHaveBeenCalled();
    callbacks.onSpeechStopped?.({ callEpoch: 1 });
    await delay(30);
    expect(realtime.sendBackendContext).not.toHaveBeenCalled();
    expect(realtime.speakToUser).not.toHaveBeenCalled();

    callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-weather',
      responsePending: true,
    });
    await vi.waitFor(() => {
      expect(realtime.sendBackendContext).toHaveBeenCalledTimes(1);
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });
  });

  it('closes injection before an interrupted response is finalized', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'search the news' });
    await awaitReceipts(realtime, 1);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'response-old',
      authority: 'direct',
    });
    adaptor.queue('s1').push({
      type: 'turn_complete',
      jobRef: 'p1',
      summary: 'news found',
    });
    await delay(30);

    callbacks.onSpeechStarted?.({ callEpoch: 1, itemId: 'input-weather' });
    callbacks.onBargeIn?.({ callEpoch: 1, responseId: 'response-old' });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'response-old',
      status: 'cancelled',
    });
    await delay(30);
    expect(realtime.sendBackendContext).not.toHaveBeenCalled();
    expect(realtime.speakToUser).not.toHaveBeenCalled();

    callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-weather',
      responsePending: true,
    });
    await vi.waitFor(() => {
      expect(realtime.sendBackendContext).toHaveBeenCalledTimes(1);
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });
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

    // A stream replay/resubscribe must not ask for the same backend request
    // a second time.
    adaptor.queue('s1').push({
      type: 'permission_request',
      jobRef: 'p1',
      requestId: 'r1',
      title: 'Bash: rm -rf /tmp',
      options: PERMISSION_OPTIONS,
    });
    await delay(30);
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

  it('replays an unresolved permission after the user interrupts its speech', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'clean tmp' });
    await awaitReceipts(realtime, 1);
    adaptor.queue('s1').push({
      type: 'permission_request',
      jobRef: 'p1',
      requestId: 'r1',
      title: 'Bash: rm -rf /tmp',
      options: PERMISSION_OPTIONS,
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });
    realtime.sendBackendContext.mockClear();
    realtime.speakToUser.mockClear();

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'permission-speech',
      authority: 'backend_speech',
    });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'permission-speech',
      audio: new Uint8Array(48_000),
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'permission-speech',
    });
    callbacks.onSpeechStarted?.({ callEpoch: 1, itemId: 'input-answer' });
    await delay(30);
    expect(realtime.speakToUser).not.toHaveBeenCalled();

    callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-answer',
      responsePending: true,
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });
    expect(realtime.sendBackendContext.mock.calls[0]?.[0]).toContain(
      '[PERMISSION req_1]',
    );
  });

  it('replays an active permission response after barge-in', async () => {
    const { adaptor, callbacks, host, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'clean tmp' });
    await awaitReceipts(realtime, 1);
    adaptor.queue('s1').push({
      type: 'permission_request',
      jobRef: 'p1',
      requestId: 'r1',
      title: 'Bash: rm -rf /tmp',
      options: PERMISSION_OPTIONS,
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });
    realtime.speakToUser.mockClear();
    host.clearOutput.mockClear();

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'permission-speech',
      authority: 'backend_speech',
    });
    callbacks.onSpeechStarted?.({ callEpoch: 1, itemId: 'input-answer' });
    callbacks.onBargeIn?.({
      callEpoch: 1,
      responseId: 'permission-speech',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'permission-speech',
      status: 'cancelled',
    });
    expect(host.clearOutput).toHaveBeenCalledTimes(1);
    expect(realtime.speakToUser).not.toHaveBeenCalled();

    callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-answer',
      responsePending: true,
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });
  });

  it('actively reminds after a direct response leaves permission unresolved', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'clean tmp' });
    await awaitReceipts(realtime, 1);
    adaptor.queue('s1').push({
      type: 'permission_request',
      jobRef: 'p1',
      requestId: 'r1',
      title: 'Bash: rm -rf /tmp',
      options: PERMISSION_OPTIONS,
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });
    realtime.speakToUser.mockClear();

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-without-vote',
      authority: 'direct',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-without-vote',
      inputItemId: 'input-allow',
    });

    await vi.waitFor(
      () => {
        expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
      },
      { timeout: 2_000 },
    );
    expect(adaptor.respondPermission).not.toHaveBeenCalled();
  });

  it('cancels a pending reminder when a delayed permission tool call arrives', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'clean tmp' });
    await awaitReceipts(realtime, 1);
    adaptor.queue('s1').push({
      type: 'permission_request',
      jobRef: 'p1',
      requestId: 'r1',
      title: 'Bash: rm -rf /tmp',
      options: PERMISSION_OPTIONS,
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });
    realtime.speakToUser.mockClear();

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-ack',
      authority: 'direct',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-ack',
      inputItemId: 'input-allow',
    });
    await delay(500);
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-tool',
      authority: 'direct',
    });
    // Let the reminder timer fire while the delayed tool response owns the
    // response slot. The ask is now queued in Injector and must be retracted
    // by the delivered vote rather than leaking after response.done.
    await delay(600);
    callTool(callbacks, 'respond_permission', {
      request_id: 'req_1',
      decision: 'allow',
    });
    await awaitReceipts(realtime, 2);
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'direct-tool',
      inputItemId: 'input-allow',
    });
    await delay(1_100);

    expect(adaptor.respondPermission).toHaveBeenCalledTimes(1);
    expect(realtime.speakToUser).not.toHaveBeenCalled();
  });

  it('does not attach an older job permission to a newer queued job', async () => {
    const { adaptor, callbacks, realtime } = await startSession();

    callTool(callbacks, 'handoff', { task: 'first task' });
    await awaitReceipts(realtime, 1);
    adaptor.busy = true;
    adaptor.queue('s1').push({ type: 'turn_started', jobRef: 'p1' });
    adaptor.queue('s1').push({
      type: 'permission_request',
      jobRef: 'p1',
      requestId: 'r1',
      title: 'Bash: first command',
      options: PERMISSION_OPTIONS,
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });

    adaptor.promptReceipt = { status: 'queued', jobRef: 'p2' };
    callTool(callbacks, 'handoff', { task: 'second task' });
    await awaitReceipts(realtime, 2);
    callTool(callbacks, 'session_monitor', { job: 'job_2' });
    callTool(callbacks, 'session_monitor', { job: 'job_1' });
    const [, , second, first] = await awaitReceipts(realtime, 4);

    expect(second).toMatchObject({
      status: 'ok',
      state: 'busy',
      job: 'job_2',
      job_state: 'accepted',
    });
    expect(second?.['pending_permission']).toBeUndefined();
    expect(first).toMatchObject({
      status: 'ok',
      state: 'waiting_for_permission',
      job: 'job_1',
      job_state: 'waiting_for_permission',
      pending_permission: { request_id: 'req_1' },
    });
  });

  it('reports and restores a pending permission across Live calls', async () => {
    const rig = await startSession();
    const { adaptor, callbacks, realtime, session } = rig;

    callTool(callbacks, 'handoff', { task: 'check the weather' });
    await awaitReceipts(realtime, 1);
    adaptor.busy = true;
    adaptor.summaries = [
      {
        handle: { id: 's1', adaptor: adaptor.name },
        label: 'Voice chat',
        state: 'busy',
      },
    ];
    adaptor.queue('s1').push({
      type: 'permission_request',
      jobRef: 'p1',
      requestId: 'r1',
      title: 'curl weather.example',
      options: PERMISSION_OPTIONS,
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });

    callTool(callbacks, 'session_monitor', { job: 'job_1' });
    callTool(callbacks, 'session_list', {});
    const [, monitor, list] = await awaitReceipts(realtime, 3);
    expect(monitor).toMatchObject({
      state: 'waiting_for_permission',
      job_state: 'waiting_for_permission',
      pending_permission: {
        request_id: 'req_1',
        title: 'curl weather.example',
      },
    });
    expect(list?.['sessions']).toEqual([
      expect.objectContaining({
        state: 'waiting_for_permission',
        pending_permission: expect.objectContaining({ request_id: 'req_1' }),
      }),
    ]);

    await session.stop({ epoch: 1, callId: 'call-1' });
    realtime.speakToUser.mockClear();
    await session.start({
      epoch: 2,
      callId: 'call-2',
      mode: 'resume',
      visualInput: DEFAULT_VISUAL_INPUT,
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });

    callTool(rig.currentCallbacks(), 'respond_permission', {
      request_id: 'req_1',
      decision: 'allow',
    });
    const resumedReceipts = await awaitReceipts(realtime, 4);
    expect(resumedReceipts[3]).toEqual({ status: 'delivered' });
    expect(adaptor.respondPermission).toHaveBeenLastCalledWith(
      { id: 's1', adaptor: adaptor.name },
      'r1',
      'allow',
    );
  });

  it('consumes a permission request buffered between Live calls', async () => {
    const rig = await startSession();
    const { adaptor, callbacks, realtime, session } = rig;

    callTool(callbacks, 'handoff', { task: 'check the weather' });
    await awaitReceipts(realtime, 1);
    await session.stop({ epoch: 1, callId: 'call-1' });

    adaptor.queue('s1').push({
      type: 'permission_request',
      requestId: 'r-between',
      title: 'curl weather.example',
      options: PERMISSION_OPTIONS,
    });
    realtime.speakToUser.mockClear();
    await session.start({
      epoch: 2,
      callId: 'call-2',
      mode: 'resume',
      visualInput: DEFAULT_VISUAL_INPUT,
    });

    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });
    callTool(rig.currentCallbacks(), 'respond_permission', {
      request_id: 'req_1',
      decision: 'allow',
    });
    const resumedReceipts = await awaitReceipts(realtime, 2);
    expect(resumedReceipts[1]).toEqual({ status: 'delivered' });
    expect(adaptor.respondPermission).toHaveBeenLastCalledWith(
      { id: 's1', adaptor: adaptor.name },
      'r-between',
      'allow',
    );
  });

  it('does not replay a permission resolved while Live was disconnected', async () => {
    const rig = await startSession();
    const { adaptor, callbacks, realtime, session } = rig;

    callTool(callbacks, 'handoff', { task: 'check the weather' });
    await awaitReceipts(realtime, 1);
    adaptor.queue('s1').push({
      type: 'permission_request',
      requestId: 'r1',
      title: 'curl weather.example',
      options: PERMISSION_OPTIONS,
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });
    await session.stop({ epoch: 1, callId: 'call-1' });

    adaptor
      .queue('s1')
      .push({ type: 'permission_resolved', requestId: 'r1', byUs: false });
    realtime.speakToUser.mockClear();
    realtime.sendBackendContext.mockClear();
    await session.start({
      epoch: 2,
      callId: 'call-2',
      mode: 'resume',
      visualInput: DEFAULT_VISUAL_INPUT,
    });
    await delay(30);

    expect(realtime.speakToUser).not.toHaveBeenCalled();
    expect(realtime.sendBackendContext).toHaveBeenCalledOnce();
    expect(realtime.sendBackendContext.mock.calls[0]?.[0]).toContain(
      'already handled elsewhere',
    );
  });

  it('does not speak while a standing-rule vote is still in flight on resume', async () => {
    const rig = await startSession();
    const { adaptor, callbacks, realtime, session } = rig;

    callTool(callbacks, 'handoff', { task: 'check the weather' });
    await awaitReceipts(realtime, 1);
    adaptor.queue('s1').push({
      type: 'permission_request',
      requestId: 'r1',
      title: 'curl weather.example',
      options: PERMISSION_OPTIONS,
    });
    await vi.waitFor(() => {
      expect(realtime.speakToUser).toHaveBeenCalledTimes(1);
    });
    callTool(callbacks, 'respond_permission', {
      request_id: 'req_1',
      decision: 'allow_always',
    });
    await awaitReceipts(realtime, 2);
    await session.stop({ epoch: 1, callId: 'call-1' });

    let finishAutoVote: (outcome: 'delivered') => void = () => undefined;
    const autoVote = new Promise<'delivered'>((resolve) => {
      finishAutoVote = resolve;
    });
    adaptor.respondPermission.mockImplementationOnce(async () => autoVote);
    adaptor.queue('s1').push({
      type: 'permission_request',
      requestId: 'r2',
      title: 'curl weather.example',
      options: PERMISSION_OPTIONS,
    });
    realtime.speakToUser.mockClear();

    await session.start({
      epoch: 2,
      callId: 'call-2',
      mode: 'resume',
      visualInput: DEFAULT_VISUAL_INPUT,
    });
    expect(realtime.speakToUser).not.toHaveBeenCalled();
    callTool(rig.currentCallbacks(), 'session_monitor', { job: 'job_1' });
    const [, , monitor] = await awaitReceipts(realtime, 3);
    expect(monitor?.['state']).not.toBe('waiting_for_permission');
    expect(monitor?.['pending_permission']).toBeUndefined();

    finishAutoVote('delivered');
    await delay(30);
    expect(adaptor.respondPermission).toHaveBeenCalledTimes(2);
    expect(realtime.speakToUser).not.toHaveBeenCalled();
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

  it.each([true, false])(
    'retracts a queued permission ask when resolved (byUs=%s)',
    async (byUs) => {
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

      queue.push({ type: 'permission_resolved', requestId: 'r2', byUs });
      await delay(30);

      // Reopen the window: the retracted ask must not surface.
      callbacks.onResponseDone?.({ callEpoch: 1, responseId: 'resp_open' });
      await delay(50);
      expect(realtime.sendBackendContext).not.toHaveBeenCalled();
      expect(realtime.speakToUser).not.toHaveBeenCalled();
    },
  );

  it('barge-in clears the host output', async () => {
    const { callbacks, host } = await startSession();

    callbacks.onBargeIn?.({ callEpoch: 1, responseId: 'resp_x' });

    expect(host.clearOutput).toHaveBeenCalledTimes(1);
  });

  it('clears playback tail when speech starts after response.done', async () => {
    const { session, callbacks, host } = await startSession();

    // Playback receipts arrive via coordinator handlers (not realtime
    // callbacks) — call the session methods directly as daemon.ts does.
    session.playbackStarted({ epoch: 1 });
    callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'resp_tail',
      audio: new Uint8Array(48_000),
    });
    callbacks.onResponseDone?.({ callEpoch: 1, responseId: 'resp_tail' });
    callbacks.onSpeechStarted?.({ callEpoch: 1 });

    expect(host.clearOutput).toHaveBeenCalledTimes(1);
  });

  it('does not clear output twice for active-response barge-in', async () => {
    const { callbacks, host, log } = await startSession();

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'resp_active',
      authority: 'direct',
    });
    callbacks.onSpeechStarted?.({ callEpoch: 1 });
    callbacks.onBargeIn?.({ callEpoch: 1, responseId: 'resp_active' });

    expect(host.clearOutput).toHaveBeenCalledTimes(1);
    expect(log.write).toHaveBeenCalledWith('playback.cleared', {
      reason: 'speech_started',
    });
    expect(log.write).toHaveBeenCalledWith('response.cancelled', {
      responseId: 'resp_active',
    });
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

    callbacks.onInputCommitted?.({ callEpoch: 1, responsePending: true });
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
      error: liveMessage('runtime.finalInputCommit'),
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
    callbacks.onInputCommitted?.({ callEpoch: 1, responsePending: true });

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

    adaptor.promptReceipt = { status: 'accepted', jobRef: 'p2' };
    callTool(callbacks, 'handoff', { task: 'check connection' });
    await awaitReceipts(realtime, 2);
    queue.push({
      type: 'turn_error',
      jobRef: 'p2',
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
      `The task to 跑测试 finished. ${closing}`,
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

  it('queues the latest live frame until audio starts, then forwards active frames', async () => {
    const { callbacks, realtime, session } = await startSession();
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    const newerImage = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]).toString(
      'base64',
    );

    session.setVisualSettings({
      epoch: 1,
      callId: 'call-1',
      visualInput: { ...DEFAULT_VISUAL_INPUT, mode: 'live-feed' },
    });
    expect(
      session.pushImage({
        epoch: 1,
        callId: 'call-1',
        source: 'screen',
        image,
      }),
    ).toBe(true);
    expect(
      session.pushImage({
        epoch: 1,
        callId: 'call-1',
        source: 'screen',
        image: newerImage,
      }),
    ).toBe(true);
    expect(realtime.pushImage).not.toHaveBeenCalled();

    const audio = Buffer.from([1, 0]);
    expect(
      session.pushAudio({ epoch: 1, callId: 'call-1', pcm16: audio }),
    ).toBe(true);
    expect(realtime.pushAudio).toHaveBeenCalledWith(audio);
    expect(realtime.pushImage).toHaveBeenCalledWith(newerImage);
    expect(realtime.pushAudio.mock.invocationCallOrder[0]).toBeLessThan(
      realtime.pushImage.mock.invocationCallOrder[0] ?? 0,
    );

    expect(
      session.pushImage({
        epoch: 1,
        callId: 'call-1',
        source: 'screen',
        image,
      }),
    ).toBe(true);
    expect(realtime.pushImage).toHaveBeenLastCalledWith(image);

    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'resp_1',
      authority: 'direct',
    });
    const stopPending = session.stop({ epoch: 1, callId: 'call-1' });
    expect(
      session.pushImage({
        epoch: 1,
        callId: 'call-1',
        source: 'screen',
        image,
      }),
    ).toBe(true);
    expect(
      session.pushImage({
        epoch: 0,
        callId: 'old-call',
        source: 'screen',
        image,
      }),
    ).toBe(true);
    expect(realtime.pushImage).toHaveBeenCalledTimes(2);

    callbacks.onResponseDone?.({ callEpoch: 1, responseId: 'resp_1' });
    await stopPending;
  });

  it('forwards Source and Mode changes as silent realtime context', async () => {
    const { realtime, session } = await startSession();

    session.setVisualSettings({
      epoch: 1,
      callId: 'call-1',
      visualInput: {
        ...DEFAULT_VISUAL_INPUT,
        source: 'camera',
        mode: 'live-feed',
      },
    });
    session.setVisualSettings({
      epoch: 1,
      callId: 'call-1',
      visualInput: DEFAULT_VISUAL_INPUT,
    });

    expect(realtime.sendBackendContext).toHaveBeenNthCalledWith(
      1,
      '[VISUAL_INPUT] source=camera mode=live-feed.',
    );
    expect(realtime.sendBackendContext).toHaveBeenNthCalledWith(
      2,
      '[VISUAL_INPUT] source=screen mode=on-demand.',
    );
  });

  it('forwards the latest visual settings after a connection-time change', async () => {
    const adaptor = new FakeAdaptor();
    const host = createFakeHost({
      source: 'screen',
      image: TEST_JPEG,
      width: 1280,
      height: 720,
      appName: 'Safari',
      accessibilityText: 'visible text',
      screenshotPath: pngPath,
    });
    const realtime = createFakeRealtime();
    let resolveRealtime: ((session: QwenRealtimeSession) => void) | undefined;
    const openRealtime: typeof openQwenRealtimeSession = () =>
      new Promise((resolve) => {
        resolveRealtime = resolve;
      });
    const session = new LiveSession({
      host,
      registry: new BackendRegistry([{ adaptor, isDefault: true }]),
      realtime: {
        endpoint: 'https://dashscope.example.com',
        model: 'qwen-omni-turbo-realtime',
      },
      log: { write: vi.fn(), close: async () => {} } as unknown as SessionLog,
      openRealtime,
    });
    const started = session.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
      visualInput: DEFAULT_VISUAL_INPUT,
    });
    session.setVisualSettings({
      epoch: 1,
      callId: 'call-1',
      visualInput: {
        ...DEFAULT_VISUAL_INPUT,
        source: 'camera',
        mode: 'live-feed',
      },
    });

    resolveRealtime?.(realtime as unknown as QwenRealtimeSession);
    await started;

    expect(realtime.sendBackendContext).toHaveBeenCalledWith(
      '[VISUAL_INPUT] source=camera mode=live-feed.',
    );
  });

  it('routes tool calls to the owning adaptor when two backends coexist', async () => {
    const [primary, secondary] = [
      new FakeAdaptor('serve'),
      new FakeAdaptor('acp'),
    ];
    const { callbacks, realtime } = await startSession([primary, secondary]);

    // Create one session per backend.
    callTool(callbacks, 'session_create', { backend: 'acp' });
    callTool(callbacks, 'session_create', {});
    await awaitReceipts(realtime, 2);
    const [acpReceipt, defaultReceipt] = receipts(realtime).slice(0, 2);
    expect(acpReceipt?.['status']).toBe('ok');
    expect(defaultReceipt?.['status']).toBe('ok');
    expect(secondary.createSession).toHaveBeenCalledTimes(1);
    expect(primary.createSession).toHaveBeenCalledTimes(1);

    // session_list fans out across both backends with backend labels.
    primary.summaries = [
      { handle: { id: 'a', adaptor: 'serve' }, state: 'idle' },
    ];
    secondary.summaries = [
      { handle: { id: 'b', adaptor: 'acp' }, state: 'idle' },
    ];
    callTool(callbacks, 'session_list', {});
    await awaitReceipts(realtime, 3);
    const listReceipt = receipts(realtime)[2];
    expect(listReceipt?.['sessions']).toEqual([
      { handle: 'session_3', backend: 'serve', state: 'idle' },
      { handle: 'session_4', backend: 'acp', state: 'idle' },
    ]);

    // A handoff naming the acp session drives the acp adaptor only.
    callTool(callbacks, 'handoff', {
      task: 'do the thing',
      session: 'session_4',
    });
    await awaitReceipts(realtime, 4);
    expect(secondary.prompt).toHaveBeenCalledTimes(1);
    expect(primary.prompt).not.toHaveBeenCalled();
  });

  it('rejects session_create for an unknown or unavailable backend', async () => {
    const [primary, secondary] = [
      new FakeAdaptor('serve'),
      new FakeAdaptor('acp'),
    ];
    const { callbacks, realtime } = await startSession([primary, secondary]);

    callTool(callbacks, 'session_create', { backend: 'nope' });
    await awaitReceipts(realtime, 1);
    const unknown = receipts(realtime)[0];
    expect(unknown?.['status']).toBe('error');
    expect(String(unknown?.['note'])).toContain("unknown backend 'nope'");

    // The secondary reports unavailable via preflight at the registry level;
    // simulate the marked entry by making listSessions throw — the fan-out
    // must skip it without emptying the list.
    primary.summaries = [
      { handle: { id: 'a', adaptor: 'serve' }, state: 'idle' },
    ];
    secondary.summaries = [];
    secondary.listSessions = async () => {
      throw new Error('agent process exited');
    };
    callTool(callbacks, 'session_list', {});
    await awaitReceipts(realtime, 2);
    const list = receipts(realtime)[1];
    expect(list?.['status']).toBe('ok');
    expect(list?.['sessions']).toEqual([
      { handle: 'session_1', backend: 'serve', state: 'idle' },
    ]);
  });

  it('strips image blocks for an image-incapable backend and notes it', async () => {
    const adaptor = new FakeAdaptor();
    adaptor.capabilities = () => ({
      steering: 'native',
      imageInput: false,
      permissionForwarding: true,
      proactiveSpeak: false,
      sessionList: true,
      eventDelivery: 'stream',
    });
    const { callbacks, realtime } = await startSession(adaptor);

    // Register the asset first (appshot), then hand off referencing it.
    callTool(callbacks, 'appshot', {});
    callTool(
      callbacks,
      'handoff',
      { task: 'look at this', input_refs: ['asset_1'] },
      [{ role: 'user', text: 'what is on my screen' }],
    );
    await awaitReceipts(realtime, 2);
    const receipt = receipts(realtime)[1];
    expect(receipt?.['status']).toBe('accepted');
    expect(String(receipt?.['note'] ?? '')).toContain('cannot take images');
    const blocks = adaptor.prompt.mock.calls[0]?.[1] as readonly ContentBlock[];
    expect(blocks.every((block) => block.type !== 'image')).toBe(true);
  });
});

describe('LiveSession memory integration', () => {
  const memoryServices: MemoryService[] = [];
  const memoryRigs: Rig[] = [];

  async function memoryService(
    rawMemory: Record<string, unknown> = {},
    fetcher?: typeof fetch,
  ) {
    const dataDir = await mkdtemp(join(tempDir, 'memory-'));
    const configPath = join(dataDir, 'config.json');
    const raw = {
      enabled: true,
      retrieve: { useVector: false },
      updater: { enabled: false },
      ...rawMemory,
    };
    await writeFile(configPath, JSON.stringify({ memory: raw }));
    const service = new MemoryService({
      config: resolveMemoryConfig(raw, dataDir, configPath),
      dataDir,
      connection: {
        baseUrl: 'https://memory.test/v1',
        ...(fetcher ? { apiKey: 'fixture-key' } : {}),
      },
      ...(fetcher ? { fetch: fetcher } : {}),
    });
    memoryServices.push(service);
    return service;
  }

  async function startMemory(
    service: MemoryService,
    options: Omit<StartSessionOptions, 'memory'> = {},
  ) {
    const rig = await startSession(undefined, { ...options, memory: service });
    memoryRigs.push(rig);
    return rig;
  }

  function inspectMemory(service: MemoryService) {
    const store = new MemoryStore({
      directory: service.settings.dir,
      defaultId: 'default',
    });
    const db = store.database(service.state().libraryId);
    try {
      return {
        turns: db.prepare('SELECT * FROM turns ORDER BY turn_idx').all(),
        segments: db
          .prepare('SELECT * FROM dialogue_segments ORDER BY id')
          .all(),
        wm: db.prepare('SELECT * FROM wm_snapshots ORDER BY seq').all(),
        updates: db
          .prepare('SELECT * FROM updater_log ORDER BY session_id')
          .all(),
        observations: db.prepare('SELECT * FROM stm_env ORDER BY id').all(),
      };
    } finally {
      store.close();
    }
  }

  function beginDialogue(
    callbacks: QwenRealtimeCallbacks,
    inputItemId: string,
    text: string,
  ) {
    callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: inputItemId,
      responsePending: true,
    });
    callbacks.onDialogue?.({ callEpoch: 1, inputItemId, role: 'user', text });
  }

  async function waitMemoryReceipt(realtime: FakeRealtime, count: number) {
    await vi.waitFor(() =>
      expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(count),
    );
    return realtime.submitFunctionOutput.mock.calls[count - 1]?.[1];
  }

  afterEach(async () => {
    memoryRigs.splice(0).forEach((rig) => rig.session.dispose());
    await Promise.all(
      memoryServices.splice(0).map((service) => service.close()),
    );
  });

  it('loads the initial profile and four memory sections and exposes only enabled memory tools', async () => {
    const service = await memoryService();
    const store = new MemoryStore({
      directory: service.settings.dir,
      defaultId: 'default',
    });
    try {
      store
        .database('default')
        .prepare(
          'INSERT INTO ltm_entries(field, content, created_at, updated_at, src_session) VALUES(?, ?, ?, ?, ?)',
        )
        .run('name', '小王', '2026-09-05', '2026-09-05', 'past-call');
    } finally {
      store.close();
    }
    const rig = await startMemory(service);
    expect(rig.config.instructions).toContain(MEMORY_SYSTEM_PROMPT);
    expect(rig.config.instructions).toContain('小王');
    for (const section of [
      'user_profile',
      'recent',
      'retrieved',
      'personalized_user_memories',
    ])
      expect(rig.config.instructions).toContain(`<${section}>`);
    expect(rig.config.tools.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(['omnibio', 'omniretrieve']),
    );
    expect(service.state().locked).toBe(true);
    expect(rig.realtime.configure).toHaveBeenCalledWith({
      instructions: rig.config.instructions,
      tools: rig.config.tools,
    });

    const disabled = await memoryService({ enabled: false });
    const off = await startMemory(disabled);
    expect(off.config.instructions).not.toContain(
      '<personalized_user_memories>',
    );
    expect(off.config.tools.map((tool) => tool.function.name)).not.toContain(
      'omnibio',
    );
    expect(off.config.tools.map((tool) => tool.function.name)).not.toContain(
      'omniretrieve',
    );
  });

  it('records final dialogue exactly once even when an answer precedes late ASR', async () => {
    const service = await memoryService();
    const { callbacks, session } = await startMemory(service);
    callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-1',
      responsePending: true,
    });
    callbacks.onDialogue?.({
      callEpoch: 1,
      inputItemId: 'input-1',
      role: 'assistant',
      text: '辣椒留三十厘米。',
      source: 'normal',
      interrupted: true,
    });
    callbacks.onInputTranscriptDone?.({
      callEpoch: 1,
      itemId: 'input-1',
      text: '辣椒间距多少',
    });
    callbacks.onOutputTextDone?.({
      callEpoch: 1,
      responseId: 'response-1',
      text: '辣椒留三十厘米。',
      source: 'audio_transcript',
    });
    callbacks.onDialogue?.({
      callEpoch: 1,
      inputItemId: 'input-1',
      role: 'user',
      text: '辣椒间距多少',
    });
    callbacks.onDialogue?.({
      callEpoch: 1,
      inputItemId: 'input-1',
      role: 'assistant',
      text: '辣椒留三十厘米。',
      source: 'normal',
    });
    callbacks.onDialogue?.({
      callEpoch: 1,
      inputItemId: 'input-1',
      role: 'user',
      text: 'duplicate user',
    });
    session.dispose();
    const saved = inspectMemory(service);
    expect(saved.turns).toHaveLength(1);
    expect(saved.turns[0]).toMatchObject({
      user_text: '辣椒间距多少',
      asst_text: '辣椒留三十厘米。',
      interrupted: 1,
    });
    expect(saved.segments).toHaveLength(1);
    expect(saved.segments[0]?.['body']).toContain('被用户打断');
  });

  it('publishes omnibio changes before its receipt and keeps memory content out of tool logs', async () => {
    const service = await memoryService();
    const { callbacks, realtime, adaptor, log } = await startMemory(service);
    realtime.configure.mockClear();
    const fact = '用户喜欢在阳台种薄荷。';
    callTool(callbacks, 'omnibio', { operations: { add: [fact] } });
    expect(await waitMemoryReceipt(realtime, 1)).toBe(
      'Successfully updated memory.',
    );
    expect(realtime.configure.mock.calls.at(-1)?.[0].instructions).toContain(
      `0. ${fact}`,
    );
    expect(realtime.configure.mock.invocationCallOrder[0]).toBeLessThan(
      realtime.submitFunctionOutput.mock.invocationCallOrder[0]!,
    );
    expect(adaptor.prompt).not.toHaveBeenCalled();
    expect(realtime.commitInputAudio).not.toHaveBeenCalled();
    expect(JSON.stringify(log.write.mock.calls)).not.toContain(fact);
  });

  it('publishes this lookup before its receipt and clears the previous lookup when there is no match', async () => {
    const service = await memoryService();
    const { callbacks, realtime } = await startMemory(service);
    beginDialogue(callbacks, 'lookup-source', '辣椒间距多少');
    callbacks.onDialogue?.({
      callEpoch: 1,
      inputItemId: 'lookup-source',
      role: 'assistant',
      text: '辣椒留三十到四十厘米。',
      source: 'normal',
    });
    realtime.configure.mockClear();
    callTool(callbacks, 'omniretrieve', {
      query: '辣椒 间距',
      source: 'dialogue',
    });
    expect(await waitMemoryReceipt(realtime, 1)).toBe(
      'Successfully searched past conversations. 1 matched.',
    );
    expect(realtime.configure.mock.calls.at(-1)?.[0].instructions).toContain(
      '三十到四十厘米',
    );
    expect(realtime.configure.mock.invocationCallOrder[0]).toBeLessThan(
      realtime.submitFunctionOutput.mock.invocationCallOrder[0]!,
    );
    callTool(callbacks, 'omniretrieve', {
      query: '量子纠缠',
      source: 'dialogue',
    });
    expect(await waitMemoryReceipt(realtime, 2)).toBe(
      'Successfully searched past conversations. 0 matched.',
    );
    expect(realtime.configure.mock.calls.at(-1)?.[0].instructions).toContain(
      '<retrieved>\n</retrieved>',
    );
    expect(
      realtime.configure.mock.calls.at(-1)?.[0].instructions,
    ).not.toContain('三十到四十厘米');
  });

  it('removes memory context and tools when disabled, restores WM when enabled, and rejects late old-input events', async () => {
    const service = await memoryService();
    const { callbacks, realtime, session } = await startMemory(service);
    beginDialogue(callbacks, 'old-input', '我喜欢种薄荷');
    callTool(callbacks, 'omnibio', {
      operations: { add: ['用户喜欢种薄荷。'] },
    });
    await waitMemoryReceipt(realtime, 1);
    service.applyAction({ action: 'set_enabled', enabled: false });
    session.syncMemorySettings();
    const off = realtime.configure.mock.calls.at(-1)?.[0];
    expect(off?.instructions).not.toContain('<personalized_user_memories>');
    expect(off?.tools.map((tool) => tool.function.name)).not.toContain(
      'omnibio',
    );
    beginDialogue(callbacks, 'off-input', '不应记住的关闭期间发言');
    callTool(callbacks, 'omnibio', {
      operations: { add: ['disabled mutation'] },
    });
    expect(await waitMemoryReceipt(realtime, 2)).toBe(
      'Failed to update memory.',
    );
    service.applyAction({ action: 'set_enabled', enabled: true });
    session.syncMemorySettings();
    expect(realtime.configure.mock.calls.at(-1)?.[0].instructions).toContain(
      '0. 用户喜欢种薄荷。',
    );
    callbacks.onDialogue?.({
      callEpoch: 1,
      inputItemId: 'old-input',
      role: 'assistant',
      text: 'late answer from before OFF',
      source: 'normal',
    });
    callbacks.onDialogue?.({
      callEpoch: 1,
      inputItemId: 'off-input',
      role: 'user',
      text: 'late OFF transcript',
    });
    beginDialogue(callbacks, 'new-input', '我也喜欢罗勒');
    callbacks.onDialogue?.({
      callEpoch: 1,
      inputItemId: 'new-input',
      role: 'assistant',
      text: '罗勒也很适合阳台。',
      source: 'normal',
    });
    session.dispose();
    const saved = inspectMemory(service);
    expect(saved.turns.map((turn) => turn['user_text'])).toEqual([
      '我喜欢种薄荷',
      '我也喜欢罗勒',
    ]);
    expect(JSON.stringify(saved)).not.toContain('disabled mutation');
    expect(JSON.stringify(saved)).not.toContain('late answer');
    expect(JSON.stringify(saved)).not.toContain('late OFF');
  });

  it('flushes unmatched user speech and consolidates once when all teardown paths repeat', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ltm_patch":{}}' } }],
          }),
        ),
    );
    const service = await memoryService(
      { updater: { enabled: true } },
      fetcher,
    );
    const { callbacks, realtime, session } = await startMemory(service);
    beginDialogue(callbacks, 'unanswered', '我还想说最后一件事');
    callTool(callbacks, 'omnibio', { operations: { add: ['用户喜欢园艺。'] } });
    await waitMemoryReceipt(realtime, 1);
    session.dispose();
    session.dispose();
    callbacks.onClose?.({ reason: 'remote' });
    callbacks.onDialogue?.({
      callEpoch: 1,
      inputItemId: 'unanswered',
      role: 'assistant',
      text: 'late detached reply',
    });
    await service.close();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(service.state().locked).toBe(false);
    const saved = inspectMemory(service);
    expect(saved.turns).toHaveLength(1);
    expect(saved.turns[0]).toMatchObject({
      user_text: '我还想说最后一件事',
      asst_text: '',
    });
    expect(saved.updates).toHaveLength(1);
  });

  it('does not publish or accept a retrieval completed after memory was detached', async () => {
    const service = await memoryService();
    const attach = vi.spyOn(service, 'attach');
    const { callbacks, realtime, session } = await startMemory(service);
    const attachment = attach.mock.results[0]?.value;
    expect(attachment).toBeDefined();
    let finish!: (value: {
      receipt: string;
      count: number;
      changed: boolean;
    }) => void;
    vi.spyOn(attachment!, 'retrieve').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    callTool(callbacks, 'omniretrieve', {
      query: '迟到记忆',
      source: 'dialogue',
    });
    service.applyAction({ action: 'set_enabled', enabled: false });
    session.syncMemorySettings();
    realtime.configure.mockClear();
    finish({
      receipt: 'Successfully searched past conversations. 1 matched.',
      count: 1,
      changed: true,
    });
    expect(await waitMemoryReceipt(realtime, 1)).toBe(
      'Failed to search memory.',
    );
    expect(realtime.configure).not.toHaveBeenCalled();
  });

  it.each(['screen', 'camera'] as const)(
    'uses private %s on-demand window/camera captures for visual memory without display scope or persisted asset',
    async (source) => {
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '用户把眼镜放在书桌旁。' } }],
            }),
          ),
      );
      const service = await memoryService(
        { observer: { enabled: true } },
        fetcher,
      );
      const { host, adaptor, realtime } = await startMemory(service, {
        visualInput: { ...DEFAULT_VISUAL_INPUT, source },
        capture: {
          source,
          image: TEST_JPEG,
          width: 1280,
          height: 720,
          screenshotPath: pngPath,
        },
      });
      await vi.waitFor(() =>
        expect(inspectMemory(service).observations).toHaveLength(1),
      );
      expect(host.captureVisualContext).toHaveBeenCalledWith('call-1', {
        persistAsset: false,
      });
      expect(adaptor.prompt).not.toHaveBeenCalled();
      expect(realtime.pushImage).not.toHaveBeenCalled();
      expect(realtime.commitInputAudio).not.toHaveBeenCalled();
      const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
      expect(body.messages.at(-1).content[0].image_url.url).toBe(
        `data:image/jpeg;base64,${TEST_JPEG}`,
      );
    },
  );

  it('feeds live visual memory before foreground audio starts without requesting snapshots', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '用户在书桌旁阅读。' } }],
          }),
        ),
    );
    const service = await memoryService(
      { observer: { enabled: true, intervalSec: 0.02 } },
      fetcher,
    );
    const { session, host, realtime } = await startMemory(service, {
      visualInput: {
        ...DEFAULT_VISUAL_INPUT,
        source: 'camera',
        mode: 'live-feed',
      },
    });
    session.pushImage({
      epoch: 1,
      callId: 'call-1',
      source: 'camera',
      image: TEST_JPEG,
    });
    await vi.waitFor(() =>
      expect(inspectMemory(service).observations).toHaveLength(1),
    );
    expect(host.captureVisualContext).not.toHaveBeenCalled();
    expect(realtime.pushImage).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalled();
    session.dispose();
  });

  it('rejects an old-source private capture when the source changes while capture is pending', async () => {
    const service = await memoryService();
    const attach = vi.spyOn(service, 'attach');
    const { session, host } = await startMemory(service, {
      visualInput: { ...DEFAULT_VISUAL_INPUT, source: 'camera' },
    });
    const capture = attach.mock.calls[0]?.[0].captureVision;
    expect(capture).toBeTypeOf('function');
    let finish!: (value: LiveVisualCapture) => void;
    host.captureVisualContext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = capture!();
    session.setVisualSettings({
      epoch: 1,
      callId: 'call-1',
      visualInput: DEFAULT_VISUAL_INPUT,
    });
    finish({ source: 'camera', image: TEST_JPEG, width: 1280, height: 720 });
    expect(await pending).toBeUndefined();
    expect(await capture!()).toEqual({ source: 'screen', image: TEST_JPEG });
    expect(host.captureVisualContext).toHaveBeenCalledWith('call-1', {
      persistAsset: false,
    });
  });
});
