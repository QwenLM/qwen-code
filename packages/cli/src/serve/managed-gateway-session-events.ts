/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createReadStream } from 'node:fs';
import { appendFile, mkdir, stat, truncate } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  ManagedGatewayPromptRequest,
  ManagedPromptStatus,
} from './managed-prompt-types.js';

export type ManagedGatewaySessionEventType =
  | 'accepted'
  | 'runtime_starting'
  | 'runtime_ready'
  | 'runtime_failed'
  | 'runtime_released'
  | 'agent_started'
  | 'assistant_thought'
  | 'assistant_delta'
  | 'tool_requested'
  | 'tool_started'
  | 'tool_completed'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'stream_gap';

export interface ManagedGatewaySessionEvent {
  readonly id: number;
  readonly at: number;
  readonly sessionId: string;
  readonly promptId: string;
  readonly type: ManagedGatewaySessionEventType;
  readonly data?: unknown;
}

export interface ManagedGatewaySessionStatus {
  readonly sessionId: string;
  readonly promptId: string;
  readonly phase:
    | 'admitted'
    | 'runtime_starting'
    | 'agent_running'
    | 'waiting_runtime'
    | 'tool_running'
    | 'cancelling'
    | 'cancelled'
    | 'completed'
    | 'failed';
  readonly runtimeState: 'unknown' | 'starting' | 'ready' | 'failed';
  readonly runtimeReady: boolean;
  readonly admittedAt: number;
  readonly updatedAt: number;
  readonly createdAt: number;
  readonly title: string;
  readonly workspaceCwd: string;
  readonly failure?: { readonly code: string; readonly message: string };
}

interface SessionState {
  request: ManagedGatewayPromptRequest;
  phase: ManagedGatewaySessionStatus['phase'];
  runtimeState: ManagedGatewaySessionStatus['runtimeState'];
  runtimePromptId?: string;
  createdAt: number;
  title: string;
  admittedAt: number;
  updatedAt: number;
  failure?: { code: string; message: string };
  promptIds: Set<string>;
  events: ManagedGatewaySessionEvent[];
  eventBytes: number;
  nextEventId: number;
  waiters: Set<() => void>;
}

interface JournalRecord {
  v: 1;
  event: ManagedGatewaySessionEvent;
  request?: ManagedGatewayPromptRequest;
}

const MAX_EVENTS_PER_SESSION = 2048;
const MAX_EVENT_BYTES = 768 * 1024;
const MAX_EVENT_BYTES_PER_SESSION = 1024 * 1024;
const MAX_RETAINED_SESSIONS = 64;
const MAX_JOURNAL_RECORD_BYTES = 3 * 1024 * 1024;
const terminal = (state: SessionState) =>
  ['completed', 'failed', 'cancelled'].includes(state.phase);

function sessionIdentity(request: ManagedGatewayPromptRequest): unknown {
  return [
    request.tenantId,
    request.workspaceId,
    request.workspaceCwd,
    request.sessionId,
    request.managedClientId,
  ];
}

async function* journalRecords(
  filePath: string,
): AsyncGenerator<{ record: JournalRecord; bytes: number }> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let pending = '';
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const bytes = Buffer.byteLength(line, 'utf8') + 1;
        if (bytes > MAX_JOURNAL_RECORD_BYTES)
          throw new Error('Managed presentation record is too large.');
        const record = JSON.parse(line) as JournalRecord;
        const event = record?.event;
        if (
          record?.v !== 1 ||
          !event ||
          !Number.isSafeInteger(event.id) ||
          event.id < 1 ||
          !Number.isSafeInteger(event.at) ||
          typeof event.sessionId !== 'string' ||
          typeof event.promptId !== 'string'
        ) {
          throw new Error('Invalid Managed presentation record.');
        }
        yield { record, bytes };
      }
      if (Buffer.byteLength(pending, 'utf8') > MAX_JOURNAL_RECORD_BYTES)
        throw new Error('Managed presentation record is too large.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    stream.destroy();
  }
}

export class ManagedGatewaySessionEvents {
  private readonly sessions = new Map<string, SessionState>();
  private disposed = false;
  private filePath?: string;
  private writeTail: Promise<void> = Promise.resolve();
  private writeError?: unknown;
  private readonly persistedEventIds = new Map<string, number>();

  static async open(filePath: string): Promise<ManagedGatewaySessionEvents> {
    const store = new ManagedGatewaySessionEvents();
    store.filePath = filePath;
    await mkdir(path.dirname(filePath), { recursive: true });
    let validBytes = 0;
    for await (const { record, bytes } of journalRecords(filePath)) {
      validBytes += bytes;
      let state = store.sessions.get(record.event.sessionId);
      if (record.event.type === 'accepted') {
        if (
          !record.request ||
          record.request.sessionId !== record.event.sessionId ||
          record.request.messageId !== record.event.promptId
        )
          throw new Error('Managed presentation binding is missing.');
        if (
          state &&
          !isDeepStrictEqual(
            sessionIdentity(state.request),
            sessionIdentity(record.request),
          )
        )
          throw new Error('Managed presentation binding changed.');
        if (!state) {
          store.prune();
          state = store.newState(record.request, record.event.at);
          store.sessions.set(record.event.sessionId, state);
        } else {
          state.request = structuredClone(record.request);
        }
      }
      if (!state || record.event.id !== state.nextEventId)
        throw new Error('Managed presentation cursor is inconsistent.');
      store.apply(state, record.event);
      store.persistedEventIds.set(record.event.sessionId, record.event.id);
    }
    const size = await stat(filePath)
      .then((value) => value.size)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
    if (size > validBytes) await truncate(filePath, validBytes);
    for (const state of store.sessions.values()) {
      state.runtimeState = 'unknown';
      delete state.runtimePromptId;
    }
    store.filePath = filePath;
    return store;
  }

  flush(): Promise<void> {
    return this.writeTail;
  }

  ensure(
    request: ManagedGatewayPromptRequest,
    admittedAt = Date.now(),
  ): ManagedGatewaySessionStatus {
    if (this.disposed || this.writeError)
      throw new Error('Managed Gateway Session events are unavailable.');
    let state = this.sessions.get(request.sessionId);
    if (state) {
      if (
        !isDeepStrictEqual(
          sessionIdentity(state.request),
          sessionIdentity(request),
        )
      )
        throw new Error(
          `Managed Gateway Session '${request.sessionId}' was reused with a different identity.`,
        );
      if (state.request.messageId === request.messageId) {
        if (!isDeepStrictEqual(state.request.prompt, request.prompt))
          throw new Error('Managed Prompt identity was reused.');
        return this.snapshot(state);
      }
      if (!terminal(state))
        throw new Error(
          `Managed Gateway Session '${request.sessionId}' already has an active turn.`,
        );
      state.request = structuredClone(request);
    } else {
      this.prune();
      state = this.newState(request, admittedAt);
      this.sessions.set(request.sessionId, state);
    }
    this.append(
      state,
      'accepted',
      {
        sessionId: request.sessionId,
        promptId: request.messageId,
        prompt: request.prompt,
      },
      admittedAt,
    );
    return this.snapshot(state);
  }

  recover(
    request: ManagedGatewayPromptRequest,
    status: ManagedPromptStatus,
  ): void {
    const previous = this.sessions.get(request.sessionId);
    if (
      previous &&
      previous.request.messageId !== request.messageId &&
      previous.promptIds.has(request.messageId)
    )
      return;
    this.ensure(request, status.admittedAt);
    const state = this.sessions.get(request.sessionId)!;
    if (status.outcome && !terminal(state)) {
      if (status.outcome === 'completed') this.complete(request);
      else if (status.outcome === 'cancelled') this.cancelled(request);
      else
        this.fail(request, {
          code: 'managed_gateway_interrupted',
          message: 'The previous turn did not complete.',
        });
    } else if (status.cancelRequested && !terminal(state)) {
      this.cancelling(request);
    }
  }

  authorize(
    sessionId: string,
    managedClientId: string,
  ): ManagedGatewaySessionStatus | undefined {
    const state = this.sessions.get(sessionId);
    return state?.request.managedClientId === managedClientId
      ? this.snapshot(state)
      : undefined;
  }

  list(managedClientId: string): ManagedGatewaySessionStatus[] {
    return [...this.sessions.values()]
      .filter((state) => state.request.managedClientId === managedClientId)
      .map((state) => this.snapshot(state));
  }

  async transcript(
    sessionId: string,
    managedClientId: string,
    before?: number,
    limit = 100,
  ): Promise<{
    events: ManagedGatewaySessionEvent[];
    olderCursor?: string;
    lastEventId: number;
  }> {
    await this.flush();
    const state = this.sessions.get(sessionId);
    if (!state || state.request.managedClientId !== managedClientId)
      throw new Error('Managed Session not found.');
    const lastEventId = this.filePath
      ? (this.persistedEventIds.get(sessionId) ?? 0)
      : state.nextEventId - 1;
    const events: ManagedGatewaySessionEvent[] = [];
    let bytes = 0;
    let older = false;
    const accept = (event: ManagedGatewaySessionEvent) => {
      if (
        event.sessionId !== sessionId ||
        event.id > lastEventId ||
        (before !== undefined && event.id >= before)
      )
        return;
      events.push(event);
      bytes += Buffer.byteLength(JSON.stringify(event));
      while (
        events.length > limit ||
        (events.length > 1 && bytes > MAX_EVENT_BYTES_PER_SESSION)
      ) {
        bytes -= Buffer.byteLength(JSON.stringify(events.shift()!));
        older = true;
      }
    };
    if (this.filePath) {
      for await (const { record } of journalRecords(this.filePath))
        accept(record.event);
    } else {
      for (const event of state.events) accept(event);
      older ||= (events[0]?.id ?? 1) > 1;
    }
    return {
      events: structuredClone(events),
      ...(older && events[0] ? { olderCursor: String(events[0].id) } : {}),
      lastEventId,
    };
  }

  markRuntimeLost(
    request: ManagedGatewayPromptRequest,
    released: boolean,
  ): void {
    const state = this.sessions.get(request.sessionId);
    if (
      !state ||
      this.disposed ||
      state.request.messageId !== request.messageId
    )
      return;
    this.append(state, released ? 'runtime_released' : 'runtime_failed');
  }

  markRuntimeStarting(request: ManagedGatewayPromptRequest): void {
    const state = this.required(request);
    state.runtimePromptId = request.messageId;
    this.append(state, 'runtime_starting');
  }

  markRuntimeReady(request: ManagedGatewayPromptRequest): void {
    const state = this.bound(request);
    if (state.runtimePromptId && state.runtimePromptId !== request.messageId)
      return;
    this.append(state, 'runtime_ready');
  }

  markRuntimeFailed(request: ManagedGatewayPromptRequest): void {
    const state = this.bound(request);
    if (state.runtimePromptId && state.runtimePromptId !== request.messageId)
      return;
    this.append(state, 'runtime_failed', {
      message: 'Runtime warmup failed; a later turn may retry.',
    });
  }

  markAgentStarted(
    request: ManagedGatewayPromptRequest,
    round: number,
    agentDefinitionId: string,
  ): void {
    this.append(this.required(request), 'agent_started', {
      round,
      agentDefinitionId,
    });
  }

  appendAssistantThought(
    request: ManagedGatewayPromptRequest,
    text: string,
  ): void {
    if (text)
      this.append(this.required(request), 'assistant_thought', { text });
  }

  appendAssistantDelta(
    request: ManagedGatewayPromptRequest,
    text: string,
  ): void {
    if (text) this.append(this.required(request), 'assistant_delta', { text });
  }

  markToolRequested(
    request: ManagedGatewayPromptRequest,
    toolCallId: string,
    toolName: string,
  ): void {
    this.append(this.required(request), 'tool_requested', {
      toolCallId,
      toolName,
    });
  }

  markToolStarted(
    request: ManagedGatewayPromptRequest,
    toolCallId: string,
    toolName: string,
    input: unknown,
  ): void {
    this.append(this.required(request), 'tool_started', {
      toolCallId,
      toolName,
      ...this.summary('input', input),
    });
  }

  markToolCompleted(
    request: ManagedGatewayPromptRequest,
    toolCallId: string,
    toolName: string,
    failed: boolean,
    output?: unknown,
  ): void {
    this.append(this.required(request), 'tool_completed', {
      toolCallId,
      toolName,
      failed,
      ...(output === undefined ? {} : this.summary('output', output)),
    });
  }

  complete(request: ManagedGatewayPromptRequest): void {
    this.append(this.required(request), 'completed', {
      sessionId: request.sessionId,
      promptId: request.messageId,
    });
  }
  cancelling(request: ManagedGatewayPromptRequest): void {
    const state = this.required(request);
    if (!terminal(state) && state.phase !== 'cancelling')
      this.append(state, 'cancelling');
  }
  cancelled(request: ManagedGatewayPromptRequest): void {
    const state = this.required(request);
    if (!terminal(state)) this.append(state, 'cancelled');
  }
  fail(
    request: ManagedGatewayPromptRequest,
    failure: { readonly code: string; readonly message: string },
  ): void {
    const state = this.required(request);
    if (!terminal(state)) this.append(state, 'failed', failure);
  }

  async *subscribe(
    sessionId: string,
    managedClientId: string,
    afterEventId: number | undefined,
    signal: AbortSignal,
  ): AsyncIterable<ManagedGatewaySessionEvent> {
    const state = this.sessions.get(sessionId);
    if (!state || state.request.managedClientId !== managedClientId) return;
    let cursor = afterEventId;
    while (!signal.aborted && !this.disposed) {
      await this.flush();
      const oldest = state.events[0]?.id;
      if (
        (oldest === undefined &&
          state.nextEventId > 1 &&
          (cursor ?? 0) < state.nextEventId - 1) ||
        (cursor !== undefined &&
          (cursor > state.nextEventId - 1 ||
            (oldest !== undefined && cursor < oldest - 1)))
      ) {
        yield {
          id:
            oldest !== undefined && (cursor ?? 0) < oldest - 1
              ? oldest - 1
              : state.nextEventId - 1,
          at: Date.now(),
          sessionId,
          promptId: state.request.messageId,
          type: 'stream_gap',
          data: { oldestAvailableEventId: oldest },
        };
        return;
      }
      const persisted = this.filePath
        ? (this.persistedEventIds.get(sessionId) ?? 0)
        : state.nextEventId - 1;
      const events = state.events.filter(
        (event) =>
          event.id <= persisted && (cursor === undefined || event.id > cursor),
      );
      for (const event of events) {
        if (signal.aborted) return;
        cursor = event.id;
        yield structuredClone(event);
        if (event.type === 'stream_gap') return;
      }
      if (terminal(state)) {
        if ((cursor ?? 0) >= state.nextEventId - 1) return;
        continue;
      }
      if (events.length > 0) continue;
      await this.waitForChange(state, signal);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.sessions.values()) this.wake(state);
    this.sessions.clear();
  }

  private newState(
    request: ManagedGatewayPromptRequest,
    at: number,
  ): SessionState {
    const title =
      request.prompt
        .map((block) =>
          'text' in block && typeof block.text === 'string' ? block.text : '',
        )
        .join(' ')
        .trim()
        .slice(0, 120) || 'Managed Agent';
    return {
      request: structuredClone(request),
      phase: 'admitted',
      runtimeState: 'unknown',
      createdAt: at,
      title,
      admittedAt: at,
      updatedAt: at,
      promptIds: new Set(),
      events: [],
      eventBytes: 0,
      nextEventId: 1,
      waiters: new Set(),
    };
  }

  private required(request: ManagedGatewayPromptRequest): SessionState {
    this.ensure(request);
    return this.sessions.get(request.sessionId)!;
  }

  private bound(request: ManagedGatewayPromptRequest): SessionState {
    const state = this.sessions.get(request.sessionId);
    if (
      !state ||
      !isDeepStrictEqual(
        sessionIdentity(state.request),
        sessionIdentity(request),
      )
    )
      throw new Error(
        `Managed Gateway Session '${request.sessionId}' has no matching event binding.`,
      );
    return state;
  }

  private summary(
    field: 'input' | 'output',
    value: unknown,
  ): Record<string, unknown> {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const limit = 16 * 1024;
    return {
      [field]:
        field === 'input' && text.length <= limit
          ? value
          : text.slice(0, limit),
      ...(text.length > limit ? { truncated: true } : {}),
    };
  }

  private append(
    state: SessionState,
    type: ManagedGatewaySessionEventType,
    data?: unknown,
    at = Date.now(),
  ): void {
    if (this.writeError)
      throw new Error('Managed presentation persistence failed.');
    let event: ManagedGatewaySessionEvent = {
      id: state.nextEventId,
      at,
      sessionId: state.request.sessionId,
      promptId: state.request.messageId,
      type,
      ...(data === undefined ? {} : { data: structuredClone(data) }),
    };
    if (
      type !== 'accepted' &&
      Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES
    )
      event = {
        ...event,
        type: 'stream_gap',
        data: { reason: 'event_too_large' },
      };
    if (this.filePath) {
      const record: JournalRecord = {
        v: 1,
        event,
        ...(type === 'accepted'
          ? { request: structuredClone(state.request) }
          : {}),
      };
      const serialized = `${JSON.stringify(record)}\n`;
      const filePath = this.filePath;
      this.writeTail = this.writeTail.then(async () => {
        await appendFile(filePath, serialized, {
          encoding: 'utf8',
          mode: 0o600,
          flush: true,
        });
        this.persistedEventIds.set(event.sessionId, event.id);
      });
      void this.writeTail.catch((error: unknown) => {
        this.writeError = error;
        this.wake(state);
      });
    }
    this.apply(state, event);
    this.wake(state);
  }

  private apply(state: SessionState, event: ManagedGatewaySessionEvent): void {
    const data = event.data as Record<string, unknown> | undefined;
    switch (event.type) {
      case 'accepted':
        state.promptIds.add(event.promptId);
        state.runtimeState = 'unknown';
        state.phase = 'admitted';
        state.admittedAt = event.at;
        delete state.failure;
        break;
      case 'runtime_starting':
        state.runtimeState = 'starting';
        state.runtimePromptId = event.promptId;
        break;
      case 'runtime_ready':
        state.runtimeState = 'ready';
        break;
      case 'runtime_released':
        state.runtimeState = 'unknown';
        break;
      case 'runtime_failed':
        state.runtimeState = 'failed';
        break;
      case 'agent_started':
        if (!terminal(state) && state.phase !== 'cancelling')
          state.phase = 'agent_running';
        break;
      case 'tool_requested':
        if (
          !terminal(state) &&
          state.phase !== 'cancelling' &&
          state.runtimeState !== 'ready'
        )
          state.phase = 'waiting_runtime';
        break;
      case 'tool_started':
        if (!terminal(state) && state.phase !== 'cancelling')
          state.phase = 'tool_running';
        break;
      case 'cancelling':
        if (!terminal(state)) state.phase = 'cancelling';
        break;
      case 'completed':
        state.phase = 'completed';
        break;
      case 'cancelled':
        state.phase = 'cancelled';
        break;
      case 'failed':
        state.phase = 'failed';
        state.failure = {
          code: String(data?.['code'] ?? 'managed_gateway_failed'),
          message: String(data?.['message'] ?? 'Managed Gateway turn failed.'),
        };
        break;
      case 'tool_completed':
      case 'assistant_delta':
      case 'assistant_thought':
      case 'stream_gap':
        break;
      default:
        throw new Error('Invalid Managed presentation event type.');
    }
    state.nextEventId = event.id + 1;
    state.updatedAt = event.at;
    state.events.push(event);
    state.eventBytes += Buffer.byteLength(JSON.stringify(event));
    while (
      state.events.length > MAX_EVENTS_PER_SESSION ||
      state.eventBytes > MAX_EVENT_BYTES_PER_SESSION
    )
      state.eventBytes -= Buffer.byteLength(
        JSON.stringify(state.events.shift()!),
      );
  }

  private waitForChange(
    state: SessionState,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        signal.removeEventListener('abort', wake);
        state.waiters.delete(wake);
        resolve();
      };
      state.waiters.add(wake);
      signal.addEventListener('abort', wake, { once: true });
    });
  }
  private wake(state: SessionState): void {
    for (const waiter of state.waiters) waiter();
    state.waiters.clear();
  }
  private snapshot(state: SessionState): ManagedGatewaySessionStatus {
    return structuredClone({
      sessionId: state.request.sessionId,
      promptId: state.request.messageId,
      phase: state.phase,
      runtimeState: state.runtimeState,
      runtimeReady: state.runtimeState === 'ready',
      admittedAt: state.admittedAt,
      updatedAt: state.updatedAt,
      createdAt: state.createdAt,
      title: state.title,
      workspaceCwd: state.request.workspaceCwd,
      ...(state.failure ? { failure: state.failure } : {}),
    });
  }
  private prune(): void {
    if (this.sessions.size < MAX_RETAINED_SESSIONS) return;
    const oldest = [...this.sessions.entries()]
      .filter(([, state]) => terminal(state) && state.events.length > 0)
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (!oldest) return;
    if (this.filePath) {
      oldest[1].events = [];
      oldest[1].eventBytes = 0;
    } else this.sessions.delete(oldest[0]);
  }
}
