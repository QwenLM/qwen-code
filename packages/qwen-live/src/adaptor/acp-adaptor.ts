/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives any ACP agent (JSON-RPC over stdio) as a backend. One child
 * process multiplexes every session this adaptor created; qwen-code's own
 * `qwen --acp` mode is the primary target, but nothing here is qwen
 * specific except the explicitly named ext methods.
 *
 * Protocol facts this adaptor is built on:
 * - `session/prompt` PREEMPTS: a second prompt while one is in flight
 *   aborts the running turn. Every send therefore funnels through one
 *   `sendPromptNow()` (guarded by an assertion) — either directly when
 *   idle or from the single turn-end continuation.
 * - Steering is PULLED by the agent: qwen-code calls the client ext
 *   method `craft/drainMidTurnQueue` between tool batches (2s timeout;
 *   a -32601 reply or three consecutive timeouts permanently disables
 *   draining for the session). Our drain handler answers synchronously
 *   from local state, so we can never trip that latch. Until the agent
 *   has drained once, steering honestly reports 'queued'.
 * - `session/request_permission` is an inbound RPC: park the resolver
 *   until the user answers aloud. The reply MUST select an offered
 *   optionId (the agent validates); pick the least-escalating one.
 * - Sessions live in the child's memory (no resume in this adaptor), so
 *   a crashed child recovers nothing: every session is closed, and the
 *   next createSession respawns under a new generation.
 *
 * Dropped update kinds (voice-noise policy, same as the serve adaptor's
 * projection): agent_thought_chunk, plan, tool_call_update. Unknown
 * discriminators are ignored silently — agents may emit their own.
 *
 * Ext-method name constants are duplicated from
 * packages/acp-bridge/src/status.ts by design: qwen-live must not depend
 * on acp-bridge or the channels packages.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Writable } from 'node:stream';
import { Readable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
import { LiveLogger } from '../logger.js';
import {
  clampTail,
  classifyOption,
  describeToolCall,
  isRecord,
  MAX_DETAIL_CHARS,
  MAX_SUMMARY_CHARS,
  pickLeastEscalating,
  sanitizeTitleLine,
  tailSlice,
} from './adaptor-utils.js';
import type {
  BackendAdaptor,
  BackendCapabilities,
  BackendEvent,
  BackendHandle,
  ContentBlock,
  PermissionDecision,
  PermissionOption,
  PermissionOptionKind,
  PromptReceipt,
  SessionSummary,
} from './types.js';
import { AsyncEventQueue } from './async-event-queue.js';

const INIT_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 2_000;
const MAX_PENDING_PROMPTS = 8;
const DRAIN_BATCH = 10;

// Duplicated from packages/acp-bridge/src/status.ts (see header note).
const DRAIN_MID_TURN_QUEUE_METHOD = 'craft/drainMidTurnQueue';
const LIVE_CONVERSATION_METHOD = 'qwen/control/session/live-conversation';
const SPEAK_TO_USER_METHOD = 'qwen/control/live/speak-to-user';

/**
 * Structural subset of ClientSideConnection used here. Unit tests inject
 * a fake; production builds the real connection from the spawned child.
 */
export interface AcpConnectionLike {
  initialize(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  authenticate(params: Record<string, unknown>): Promise<unknown>;
  newSession(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  prompt(params: Record<string, unknown>): Promise<{ stopReason?: string }>;
  cancel(params: Record<string, unknown>): Promise<void>;
  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  setSessionMode(params: Record<string, unknown>): Promise<unknown>;
}

export interface AcpAdaptorOptions {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  defaultCwd?: string;
  logger?: LiveLogger;
  /** Test seam: build the connection instead of spawning. */
  connect?: (
    client: Client,
    onExit: (info: { code: number | null; signal: string | null }) => void,
  ) => Promise<AcpConnectionLike>;
}

interface ParkedPermission {
  resolve: (response: Record<string, unknown>) => void;
  options: readonly PermissionOption[];
}

interface AcpSessionState {
  /** Generation of the connection this session belongs to. */
  generation: number;
  closed: boolean;
  busy: boolean;
  activeJobRef?: string;
  turnBuffer: string;
  steerQueue: string[];
  pendingPrompts: Array<{ jobRef: string; blocks: ContentBlock[] }>;
  parkedPermissions: Map<string, ParkedPermission>;
  label?: string;
  cwd?: string;
  queue: AsyncEventQueue<BackendEvent>;
}

export class AcpAdaptor implements BackendAdaptor {
  readonly name: string;

  private readonly options: AcpAdaptorOptions;
  private readonly logger: LiveLogger;
  private readonly sessions = new Map<string, AcpSessionState>();
  private connection?: AcpConnectionLike;
  private child?: ChildProcess;
  /** Increments on every respawn; dead-generation handles are rejected. */
  private generation = 0;
  private turnSeq = 0;
  private permSeq = 0;
  /** Flip on first inbound drain; resets on respawn. See header. */
  private drainObserved = false;
  private imageInput = false;
  private proactiveSpeak = false;
  private closing = false;

  constructor(options: AcpAdaptorOptions) {
    this.name = options.name;
    this.options = options;
    this.logger = options.logger ?? new LiveLogger('error');
  }

  capabilities(): BackendCapabilities {
    return {
      // 'native' only once the agent has actually drained once; before
      // that (and on non-qwen agents, forever) steering degrades to
      // queue-until-idle — reporting 'native' would be a lie the voice
      // model's joinedActiveTurn receipts would repeat.
      steering: this.drainObserved ? 'native' : 'queued',
      imageInput: this.imageInput,
      permissionForwarding: true,
      proactiveSpeak: this.proactiveSpeak,
      sessionList: true,
      eventDelivery: 'stream',
    };
  }

  async preflight(): Promise<void> {
    await this.ensureChild();
  }

  async createSession(opts?: {
    cwd?: string;
    label?: string;
  }): Promise<BackendHandle> {
    const conn = await this.ensureChild();
    const cwd = opts?.cwd ?? this.options.cwd ?? this.options.defaultCwd;
    if (cwd === undefined) {
      throw new Error(
        `acp backend '${this.name}' needs a cwd: set defaultCwd or pass one`,
      );
    }
    let response: Record<string, unknown>;
    try {
      response = await conn.newSession({
        cwd,
        mcpServers: [],
      });
    } catch (error) {
      // Fresh agents require authentication before the first session;
      // env vars alone do not set the persisted state. Retry once.
      if (!isAuthRequired(error)) {
        throw error;
      }
      await conn.authenticate({ methodId: 'openai' });
      response = await conn.newSession({ cwd, mcpServers: [] });
    }
    const sessionId = response['sessionId'];
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error(`acp backend '${this.name}' returned no sessionId`);
    }
    const state = this.trackSession(sessionId, this.generation);
    state.label = opts?.label;
    state.cwd = cwd;
    // qwen-code's ACP sessions default to AUTO approval (silent allows);
    // the voice product exists to surface permission asks aloud, so pin
    // the session to the asking mode. Non-qwen agents answer -32601 and
    // keep their own default.
    try {
      await conn.setSessionMode({ sessionId, modeId: 'default' });
    } catch {
      /* agent has no set_mode; its default stands */
    }
    // Best effort: qwen-code swaps in live voice instructions when this
    // succeeds; other agents answer -32601 and we simply stay off.
    void this.activateLiveConversation(conn, sessionId);
    return { id: sessionId, adaptor: this.name };
  }

  async listSessions(): Promise<SessionSummary[]> {
    // Tracked-only: sessions live in the child's memory and there is no
    // portable enumeration across agents.
    return [...this.sessions.entries()].flatMap(([id, state]) => [
      {
        handle: { id, adaptor: this.name },
        ...(state.label ? { label: state.label } : {}),
        ...(state.cwd ? { cwd: state.cwd } : {}),
        state: state.closed
          ? ('closed' as const)
          : state.busy
            ? ('busy' as const)
            : ('idle' as const),
      },
    ]);
  }

  async prompt(
    handle: BackendHandle,
    blocks: readonly ContentBlock[],
    opts?: { steer?: boolean },
  ): Promise<PromptReceipt> {
    const state = this.sessions.get(handle.id);
    if (!state || state.generation !== this.generation || state.closed) {
      return {
        status: 'rejected',
        note: 'that session ended when its coding agent exited; create a new session',
      };
    }
    const texts = blocks.filter(
      (block): block is Extract<ContentBlock, { type: 'text' }> =>
        block.type === 'text',
    );
    const hasImages = blocks.some((block) => block.type === 'image');

    if (!state.busy) {
      const jobRef = this.mintJobRef();
      void this.sendPromptNow(state, jobRef, blocks);
      return { status: 'accepted', jobRef };
    }
    // Busy: never send directly (it would preempt the running turn).
    if (opts?.steer && !hasImages && this.drainObserved) {
      for (const text of texts) state.steerQueue.push(text.text);
      return {
        status: 'accepted',
        joinedActiveTurn: true,
        jobRef: state.activeJobRef,
        note: 'joined the currently running task',
      };
    }
    if (state.pendingPrompts.length >= MAX_PENDING_PROMPTS) {
      return {
        status: 'rejected',
        note: 'the session is busy and its queue is full; wait or stop the current task first',
      };
    }
    const jobRef = this.mintJobRef();
    state.pendingPrompts.push({ jobRef, blocks: [...blocks] });
    return {
      status: 'queued',
      jobRef,
      note: 'queued as the next task in that session',
    };
  }

  events(
    handle: BackendHandle,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<BackendEvent> {
    const state = this.sessions.get(handle.id);
    if (!state) throw new Error(`unknown session ${handle.id}`);
    return state.queue.subscribe({
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  isBusy(handle: BackendHandle): boolean {
    return this.sessions.get(handle.id)?.busy === true;
  }

  async cancel(handle: BackendHandle): Promise<void> {
    const state = this.sessions.get(handle.id);
    const conn = this.connection;
    if (!state || state.generation !== this.generation || !conn) return;
    // The instruction was addressed to the dying turn; queued prompts
    // survive (same contract as the serve adaptor).
    state.steerQueue = [];
    for (const [requestId, parked] of state.parkedPermissions) {
      parked.resolve({ outcome: { outcome: 'cancelled' } });
      state.parkedPermissions.delete(requestId);
      state.queue.push({ type: 'permission_resolved', requestId, byUs: false });
    }
    await conn.cancel({ sessionId: handle.id });
  }

  async respondPermission(
    handle: BackendHandle,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<'delivered' | 'already_resolved'> {
    const state = this.sessions.get(handle.id);
    const parked = state?.parkedPermissions.get(requestId);
    if (!state || !parked) return 'already_resolved';
    let response: Record<string, unknown>;
    if (decision === 'cancel') {
      response = { outcome: { outcome: 'cancelled' } };
    } else {
      const wanted: PermissionOptionKind =
        decision === 'allow' ? 'proceed' : 'reject';
      const option = pickLeastEscalating(parked.options, wanted);
      response = option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    }
    state.parkedPermissions.delete(requestId);
    parked.resolve(response);
    // ACP has no separate resolution event; our own vote is definitionally
    // ours.
    state.queue.push({ type: 'permission_resolved', requestId, byUs: true });
    return 'delivered';
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const state of this.sessions.values()) {
      this.closeSessionState(
        state,
        'the qwen-live daemon is shutting down',
        false,
      );
    }
    const child = this.child;
    this.connection = undefined;
    this.child = undefined;
    if (child?.kill) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, KILL_GRACE_MS);
        timer.unref?.();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
    }
  }

  // -- internals -----------------------------------------------------------

  private mintJobRef(): string {
    this.turnSeq += 1;
    return `turn-${this.turnSeq}`;
  }

  private trackSession(id: string, generation: number): AcpSessionState {
    let state = this.sessions.get(id);
    if (!state) {
      state = {
        generation,
        closed: false,
        busy: false,
        turnBuffer: '',
        steerQueue: [],
        pendingPrompts: [],
        parkedPermissions: new Map(),
        queue: new AsyncEventQueue<BackendEvent>(),
      };
      this.sessions.set(id, state);
    }
    return state;
  }

  /**
   * The single send path. An in-flight turn means a bug elsewhere — a
   * second prompt would silently preempt and abort the running turn.
   */
  private async sendPromptNow(
    state: AcpSessionState,
    jobRef: string,
    blocks: readonly ContentBlock[],
  ): Promise<void> {
    const conn = this.connection;
    if (!conn || state.generation !== this.generation || state.closed) return;
    if (state.busy) {
      throw new Error('sendPromptNow called while a turn is in flight');
    }
    state.busy = true;
    state.activeJobRef = jobRef;
    state.turnBuffer = '';
    state.queue.push({ type: 'turn_started', jobRef });
    try {
      const response = await conn.prompt({
        sessionId: this.sessionIdOf(state),
        prompt: blocks.map((block) =>
          block.type === 'image'
            ? {
                type: 'image',
                data: Buffer.from(block.data).toString('base64'),
                mimeType: block.mimeType,
              }
            : { type: 'text', text: block.text },
        ),
      });
      this.onTurnEnd(state, jobRef, response.stopReason);
    } catch (error) {
      // The exit handler already reported the child's death; do not
      // double-report it as a turn error.
      if (state.closed) return;
      this.onTurnEnd(state, jobRef, undefined, error);
    }
    this.continueAfterTurn(state);
  }

  private onTurnEnd(
    state: AcpSessionState,
    jobRef: string,
    stopReason: string | undefined,
    error?: unknown,
  ): void {
    state.busy = false;
    const detail = state.turnBuffer.trim();
    state.turnBuffer = '';
    state.activeJobRef = undefined;
    if (error !== undefined) {
      const message =
        error instanceof Error ? error.message : String(error ?? 'failed');
      state.queue.push({ type: 'turn_error', jobRef, error: message });
      return;
    }
    switch (stopReason) {
      case 'end_turn':
        state.queue.push({
          type: 'turn_complete',
          jobRef,
          summary: clampTail(detail, MAX_SUMMARY_CHARS),
          ...(detail ? { detail } : {}),
        });
        return;
      case 'cancelled':
        // live-session maps this literal to the calm cancelled-complete.
        state.queue.push({ type: 'turn_error', jobRef, error: 'cancelled' });
        return;
      case 'refusal':
        state.queue.push({
          type: 'turn_error',
          jobRef,
          error: 'the agent declined to continue the task',
        });
        return;
      case 'max_tokens':
      case 'max_turn_requests':
        state.queue.push({
          type: 'turn_error',
          jobRef,
          error:
            'the task stopped early (token or turn limit); ask to continue it',
        });
        return;
      default:
        state.queue.push({
          type: 'turn_error',
          jobRef,
          error: `the turn ended unexpectedly (${String(stopReason)})`,
        });
    }
  }

  /**
   * The turn-end continuation: deliver whatever accumulated while busy.
   * Undrained steer texts lead the next prompt; a queued prompt follows
   * (or the steer texts stand alone) under the pending prompt's
   * pre-minted jobRef. This is why a joinedActiveTurn receipt is never
   * lost — the instruction degrades to next-turn delivery, the same
   * contract the serve adaptor implements.
   */
  private continueAfterTurn(state: AcpSessionState): void {
    if (state.closed || state.generation !== this.generation) return;
    const steers = state.steerQueue.splice(0);
    const next = state.pendingPrompts.shift();
    if (!steers.length && !next) return;
    const jobRef = next?.jobRef ?? this.mintJobRef();
    const blocks: ContentBlock[] = steers.map((text) => ({
      type: 'text' as const,
      text,
    }));
    if (next) blocks.push(...next.blocks);
    void this.sendPromptNow(state, jobRef, blocks);
  }

  private sessionIdOf(state: AcpSessionState): string {
    for (const [id, candidate] of this.sessions) {
      if (candidate === state) return id;
    }
    throw new Error('session state not registered');
  }

  private async ensureChild(): Promise<AcpConnectionLike> {
    if (this.connection) return this.connection;
    if (this.closing) {
      throw new Error(`acp backend '${this.name}' is closed`);
    }
    this.generation += 1;
    this.drainObserved = false;
    this.imageInput = false;
    this.proactiveSpeak = false;
    const client = this.buildClient();
    let conn: AcpConnectionLike;
    let exited: Promise<never> | undefined;
    if (this.options.connect) {
      conn = await this.options.connect(client, (info) =>
        this.onChildExit(info.code, info.signal),
      );
    } else {
      const { connection, child, exitPromise } = this.spawnChild(client);
      conn = connection;
      this.child = child;
      exited = exitPromise;
    }
    // Race the handshake against both a timeout and child exit — a
    // crash-on-boot must fail in milliseconds, not after 10s.
    const racers: Array<Promise<unknown>> = [
      conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'qwen-live', version: '0.1.0' },
      }),
      this.handshakeDeadline(),
    ];
    if (exited) racers.push(exited);
    const initialized = (await Promise.race(racers)) as Record<string, unknown>;
    const caps = isRecord(initialized['agentCapabilities'])
      ? initialized['agentCapabilities']
      : {};
    const promptCaps = isRecord(caps['promptCapabilities'])
      ? caps['promptCapabilities']
      : {};
    this.imageInput = promptCaps['image'] === true;
    const authMethods = Array.isArray(initialized['authMethods'])
      ? initialized['authMethods']
      : [];
    const hasOpenAi = authMethods.some(
      (method) => isRecord(method) && method['id'] === 'openai',
    );
    if (hasOpenAi) {
      // Non-fatal: the -32000 retry at newSession is the backstop.
      try {
        await conn.authenticate({ methodId: 'openai' });
      } catch {
        /* retried on demand */
      }
    }
    this.connection = conn;
    return conn;
  }

  private handshakeDeadline(): Promise<never> {
    return new Promise((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`acp backend '${this.name}' did not initialize`));
      }, INIT_TIMEOUT_MS);
      timer.unref?.();
    });
  }

  private spawnChild(client: Client): {
    connection: AcpConnectionLike;
    child: ChildProcess;
    exitPromise: Promise<never>;
  } {
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd ?? this.options.defaultCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...this.options.env,
        // Without this the qwen CLI re-execs itself and the stdio pipes
        // attach to a process that immediately exits.
        QWEN_CODE_NO_RELAUNCH: 'true',
      },
    });
    const stdout = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const stdin = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const connection = new ClientSideConnection(
      () => client,
      ndJsonStream(stdin, stdout),
    );
    // stderr is human diagnostics, not protocol.
    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim().slice(0, 500);
      if (line) this.logger.info?.(`[acp ${this.name}] ${line}`);
    });
    // The exit promise feeds the handshake race: a child that dies before
    // initialize completes must fail preflight immediately.
    const exitPromise = new Promise<never>((_, reject) => {
      child.once('exit', (code, signal) => {
        reject(
          new Error(
            `acp backend '${this.name}' exited before initializing (code ${String(code)}, signal ${String(signal)})`,
          ),
        );
        this.onChildExit(code, signal);
      });
    });
    return { connection, child, exitPromise };
  }

  private onChildExit(code: number | null, signal: string | null): void {
    if (this.closing) return;
    this.connection = undefined;
    this.child = undefined;
    const detail = `the coding agent process exited unexpectedly (code ${String(code)}, signal ${String(signal)})`;
    for (const state of this.sessions.values()) {
      if (state.generation !== this.generation || state.closed) continue;
      this.closeSessionState(state, detail, true);
    }
  }

  private closeSessionState(
    state: AcpSessionState,
    detail: string,
    busyError: boolean,
  ): void {
    for (const [requestId, parked] of state.parkedPermissions) {
      parked.resolve({ outcome: { outcome: 'cancelled' } });
      state.parkedPermissions.delete(requestId);
      state.queue.push({ type: 'permission_resolved', requestId, byUs: false });
    }
    if (busyError && state.busy && state.activeJobRef) {
      state.queue.push({
        type: 'turn_error',
        jobRef: state.activeJobRef,
        error: detail,
      });
    }
    state.closed = true;
    state.busy = false;
    state.steerQueue = [];
    state.pendingPrompts = [];
    state.queue.push({ type: 'session_closed' });
    state.queue.end();
  }

  private async activateLiveConversation(
    conn: AcpConnectionLike,
    sessionId: string,
  ): Promise<void> {
    try {
      await conn.extMethod(LIVE_CONVERSATION_METHOD, {
        sessionId,
        active: true,
      });
      this.proactiveSpeak = true;
    } catch {
      // Not a qwen agent (or an older one) — stay off, speak-to-user
      // simply never arrives.
    }
  }

  private buildClient(): Client {
    return {
      sessionUpdate: async (params: unknown) => {
        this.onSessionUpdate(params);
      },
      requestPermission: async (params: unknown) =>
        new Promise((resolve) => {
          this.onRequestPermission(params, resolve);
        }),
      extMethod: async (method: string, params: Record<string, unknown>) =>
        this.onExtMethod(method, params),
      extNotification: async () => {},
    } as unknown as Client;
  }

  private onSessionUpdate(params: unknown): void {
    if (!isRecord(params)) return;
    const sessionId = params['sessionId'];
    if (typeof sessionId !== 'string') return;
    const state = this.sessions.get(sessionId);
    if (!state || state.closed) return;
    const update = isRecord(params['update']) ? params['update'] : {};
    const kind = update['sessionUpdate'];
    if (kind === 'agent_message_chunk') {
      const content = isRecord(update['content']) ? update['content'] : {};
      const text = content['text'];
      if (typeof text === 'string') {
        state.turnBuffer = `${state.turnBuffer}${text}`;
        if (state.turnBuffer.length > MAX_DETAIL_CHARS) {
          state.turnBuffer = tailSlice(state.turnBuffer, MAX_DETAIL_CHARS);
        }
      }
      return;
    }
    if (kind === 'tool_call') {
      const title = update['title'];
      const summary = typeof title === 'string' ? sanitizeTitleLine(title) : '';
      state.queue.push({
        type: 'progress',
        ...(state.activeJobRef ? { jobRef: state.activeJobRef } : {}),
        summary: summary || 'running a tool',
      });
      return;
    }
    // agent_thought_chunk, plan, tool_call_update, a2ui, and anything else
    // an agent dreams up: silently ignored (see header).
  }

  private onRequestPermission(
    params: unknown,
    resolve: (response: Record<string, unknown>) => void,
  ): void {
    if (!isRecord(params)) {
      resolve({ outcome: { outcome: 'cancelled' } });
      return;
    }
    const sessionId = params['sessionId'];
    const state =
      typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
    if (!state || state.closed) {
      resolve({ outcome: { outcome: 'cancelled' } });
      return;
    }
    const rawOptions = Array.isArray(params['options'])
      ? params['options']
      : [];
    const options: PermissionOption[] = [];
    for (const raw of rawOptions) {
      if (!isRecord(raw)) continue;
      const optionId = raw['optionId'];
      if (typeof optionId !== 'string') continue;
      const name = typeof raw['name'] === 'string' ? raw['name'] : undefined;
      const wireKind =
        typeof raw['kind'] === 'string' ? raw['kind'] : undefined;
      const classified = classifyOption(optionId, name, wireKind);
      options.push({
        optionId,
        ...(name ? { label: name } : {}),
        kind: classified.kind,
        ...(classified.escalation ? { escalation: classified.escalation } : {}),
      });
    }
    this.permSeq += 1;
    const requestId = `perm-${this.permSeq}`;
    state.parkedPermissions.set(requestId, {
      resolve,
      options,
    });
    state.queue.push({
      type: 'permission_request',
      ...(state.activeJobRef ? { jobRef: state.activeJobRef } : {}),
      requestId,
      title: describeToolCall(params['toolCall']),
      options,
      payload: params,
    });
  }

  private async onExtMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // The drain handler runs before any unknown-method rejection and can
    // never throw: a -32601 (or a slow reply) would permanently disable
    // the agent's mid-turn queue.
    if (method === DRAIN_MID_TURN_QUEUE_METHOD) {
      this.drainObserved = true;
      const sessionId = params['sessionId'];
      const state =
        typeof sessionId === 'string'
          ? this.sessions.get(sessionId)
          : undefined;
      if (!state) return { messages: [], hasQueuedPrompt: false };
      const messages = state.steerQueue.splice(0, DRAIN_BATCH);
      return {
        messages,
        hasQueuedPrompt: state.pendingPrompts.length > 0,
      };
    }
    if (method === SPEAK_TO_USER_METHOD) {
      const sessionId = params['callerSessionId'];
      const text = params['message'];
      const state =
        typeof sessionId === 'string'
          ? this.sessions.get(sessionId)
          : undefined;
      if (state && !state.closed && typeof text === 'string') {
        state.queue.push({ type: 'speak', text });
      }
      return {};
    }
    throw Object.assign(new Error(`method not found: ${method}`), {
      code: -32601,
    });
  }
}

function isAuthRequired(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error['code'] === -32000 ||
      String(error['message'] ?? '')
        .toLowerCase()
        .includes('auth'))
  );
}
