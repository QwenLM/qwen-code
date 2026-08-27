/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BackendAdaptor implementation that drives a running `qwen serve` daemon
 * over its REST/SSE surface via the official `@qwen-code/sdk` DaemonClient.
 *
 * Notes anchored to daemon behavior this adaptor relies on:
 * - `POST /session/:id/prompt` answers 202 with a `promptId` — that is the
 *   admission receipt the orchestrator's handoff tool returns on.
 * - `agent_message_chunk` / `tool_call` live inside
 *   `session_update.data.update.sessionUpdate`, not as top-level types.
 * - `POST /session/:id/mid-turn-message` hardcodes reject-if-idle, which is
 *   exactly the probe `prompt({steer:true})` needs: accepted means the
 *   instruction joined the running turn, rejected means the session went
 *   idle and a normal prompt is the right fallback.
 * - `permission_resolved.originatorClientId` names the *voter*, so comparing
 *   it against our own clientId distinguishes "we answered" from "someone
 *   answered in WebShell".
 */

import { DaemonClient } from '@qwen-code/sdk';
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

const ADAPTOR_NAME = 'qwen-code';

/** Feature tags this adaptor refuses to run without (all `since: v1`). */
const REQUIRED_FEATURES = [
  'session_create',
  'session_prompt',
  'session_events',
  'session_cancel',
  'session_permission_vote',
  'session_mid_turn_message_mutation',
] as const;

/** Keep receipts and summaries bounded; backends can produce huge turns. */
const MAX_SUMMARY_CHARS = 4_000;
const MAX_DETAIL_CHARS = 48_000;

/**
 * Structural subset of DaemonClient used by this adaptor. Unit tests inject
 * a fake; production passes a real DaemonClient (or omits it to have one
 * constructed from `baseUrl`/`token`).
 */
export interface DaemonClientLike {
  capabilities(): Promise<{
    features?: readonly string[];
    workspaceCwd?: string;
  }>;
  createOrAttachSession(
    req: Record<string, unknown>,
    clientId?: string,
  ): Promise<{ sessionId: string; hasActivePrompt?: boolean }>;
  listWorkspaceSessions(
    workspaceCwd: string,
    options?: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>>;
  promptNonBlocking(
    sessionId: string,
    req: Record<string, unknown>,
    signal?: AbortSignal,
    clientId?: string,
  ): Promise<Record<string, unknown>>;
  subscribeEvents(
    sessionId: string,
    opts?: Record<string, unknown>,
  ): AsyncGenerator<{
    id?: number;
    v: 1;
    type: string;
    data: unknown;
    promptId?: string;
    originatorClientId?: string;
  }>;
  enqueueMidTurnMessage(
    sessionId: string,
    message: string,
    opts?: Record<string, unknown>,
  ): Promise<{ accepted: boolean; messageId?: string }>;
  cancel(sessionId: string, clientId?: string): Promise<void>;
  respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: Record<string, unknown>,
    clientId?: string,
  ): Promise<boolean>;
  uploadSessionAttachment(
    sessionId: string,
    data: Blob,
    name: string,
    mimeType: string,
    opts?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  closeSession(sessionId: string, clientId?: string): Promise<void>;
}

export interface QwenCodeAdaptorOptions {
  /** qwen serve base URL, e.g. `http://127.0.0.1:4170`. */
  baseUrl: string;
  token?: string;
  /** Default cwd for new sessions; falls back to the daemon's workspaceCwd. */
  defaultCwd?: string;
  /** Stable client identity used for permission-vote attribution. */
  clientId?: string;
  /** Injection seam for unit tests. */
  client?: DaemonClientLike;
  logger?: (line: string) => void;
}

interface SessionState {
  busy: boolean;
  activeJobRef?: string;
  /** Accumulated assistant text for the current turn. */
  turnBuffer: string;
  /** Options captured per pending permission request, for decision mapping. */
  permissionOptions: Map<string, readonly PermissionOption[]>;
  closed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifyOption(
  optionId: string,
  label: string | undefined,
): PermissionOptionKind {
  const haystack = `${optionId} ${label ?? ''}`.toLowerCase();
  if (/(allow|proceed|approve|yes|accept)/.test(haystack)) return 'proceed';
  if (/(deny|reject|refuse|no|cancel)/.test(haystack)) return 'reject';
  return 'other';
}

function describeToolCall(toolCall: unknown): string {
  if (!isRecord(toolCall)) return 'a tool call';
  const name = typeof toolCall['name'] === 'string' ? toolCall['name'] : '';
  const command =
    typeof toolCall['command'] === 'string' ? toolCall['command'] : '';
  const title = typeof toolCall['title'] === 'string' ? toolCall['title'] : '';
  const detail = command || title;
  if (name && detail) return `${name}: ${detail}`;
  return name || detail || 'a tool call';
}

function clampTail(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `…${trimmed.slice(trimmed.length - max)}`;
}

export class QwenCodeAdaptor implements BackendAdaptor {
  readonly name = ADAPTOR_NAME;

  private readonly client: DaemonClientLike;
  private readonly options: QwenCodeAdaptorOptions;
  private readonly sessions = new Map<string, SessionState>();
  private workspaceCwd: string | undefined;

  constructor(options: QwenCodeAdaptorOptions) {
    this.options = options;
    this.client =
      options.client ??
      (new DaemonClient({
        baseUrl: options.baseUrl,
        ...(options.token ? { token: options.token } : {}),
      }) as unknown as DaemonClientLike);
  }

  capabilities(): BackendCapabilities {
    return {
      steering: 'native',
      imageInput: true,
      permissionForwarding: true,
      // Session-to-session messaging (proactive speak) is milestone M3.
      proactiveSpeak: false,
      sessionList: true,
      eventDelivery: 'stream',
    };
  }

  async preflight(): Promise<void> {
    let caps: Awaited<ReturnType<DaemonClientLike['capabilities']>>;
    try {
      caps = await this.client.capabilities();
    } catch (error) {
      throw new Error(
        `qwen serve is not reachable at ${this.options.baseUrl}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'Start it with `qwen serve` before launching qwen-live.',
      );
    }
    const features = new Set(caps.features ?? []);
    const missing = REQUIRED_FEATURES.filter((f) => !features.has(f));
    if (missing.length > 0) {
      throw new Error(
        `qwen serve at ${this.options.baseUrl} is missing required ` +
          `capabilities: ${missing.join(', ')}. Upgrade qwen-code.`,
      );
    }
    this.workspaceCwd = caps.workspaceCwd;
  }

  async createSession(opts?: {
    cwd?: string;
    label?: string;
  }): Promise<BackendHandle> {
    const cwd = opts?.cwd ?? this.options.defaultCwd ?? this.workspaceCwd;
    const session = await this.client.createOrAttachSession(
      {
        ...(cwd !== undefined ? { workspaceCwd: cwd } : {}),
        sessionScope: 'thread',
        sourceType: 'qwen-live',
      },
      this.options.clientId,
    );
    this.trackSession(session.sessionId, {
      busy: session.hasActivePrompt === true,
    });
    return { id: session.sessionId, adaptor: ADAPTOR_NAME };
  }

  async listSessions(): Promise<SessionSummary[]> {
    const cwd = this.options.defaultCwd ?? this.workspaceCwd;
    if (cwd === undefined) return [];
    const sessions = await this.client.listWorkspaceSessions(cwd, {});
    return sessions.flatMap((raw) => {
      const sessionId = raw['sessionId'];
      if (typeof sessionId !== 'string') return [];
      const tracked = this.sessions.get(sessionId);
      const label = raw['displayName'];
      return [
        {
          handle: { id: sessionId, adaptor: ADAPTOR_NAME },
          ...(typeof label === 'string' ? { label } : {}),
          cwd,
          state: tracked
            ? tracked.closed
              ? ('closed' as const)
              : tracked.busy
                ? ('busy' as const)
                : ('idle' as const)
            : ('unknown' as const),
        },
      ];
    });
  }

  async prompt(
    handle: BackendHandle,
    blocks: readonly ContentBlock[],
    opts?: { steer?: boolean },
  ): Promise<PromptReceipt> {
    const state = this.trackSession(handle.id);

    if (opts?.steer && state.busy) {
      const message = blocks
        .filter(
          (block): block is Extract<ContentBlock, { type: 'text' }> =>
            block.type === 'text',
        )
        .map((block) => block.text)
        .join('\n\n');
      const steered = await this.client.enqueueMidTurnMessage(
        handle.id,
        message,
      );
      if (steered.accepted) {
        return {
          status: 'accepted',
          joinedActiveTurn: true,
          ...(state.activeJobRef !== undefined
            ? { jobRef: state.activeJobRef }
            : {}),
          note: 'joined the currently running task',
        };
      }
      // The turn ended between our busy check and the injection: fall
      // through to a normal prompt, which is exactly the "queued as the
      // next turn" tier.
    }

    const prompt = await this.buildPromptBlocks(handle.id, blocks);
    let accepted: Record<string, unknown>;
    try {
      accepted = await this.client.promptNonBlocking(
        handle.id,
        { prompt },
        undefined,
        this.options.clientId,
      );
    } catch (error) {
      if (isRecord(error) && error['status'] === 503) {
        return {
          status: 'rejected',
          note: 'the session is busy and its queue is full; wait or stop the current task first',
        };
      }
      throw error;
    }
    const promptId = accepted['promptId'];
    const jobRef = typeof promptId === 'string' ? promptId : undefined;
    state.busy = true;
    if (jobRef !== undefined) state.activeJobRef = jobRef;
    return {
      status: opts?.steer ? 'queued' : 'accepted',
      ...(jobRef !== undefined ? { jobRef } : {}),
      ...(opts?.steer
        ? { note: 'queued as the next task in that session' }
        : {}),
    };
  }

  async *events(
    handle: BackendHandle,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<BackendEvent> {
    const state = this.trackSession(handle.id);
    const stream = this.client.subscribeEvents(handle.id, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      clientId: this.options.clientId,
    });
    for await (const envelope of stream) {
      const events = this.normalize(state, envelope);
      for (const event of events) {
        yield event;
        if (event.type === 'session_closed') return;
      }
    }
  }

  isBusy(handle: BackendHandle): boolean {
    return this.sessions.get(handle.id)?.busy === true;
  }

  async cancel(handle: BackendHandle): Promise<void> {
    await this.client.cancel(handle.id, this.options.clientId);
  }

  async respondPermission(
    handle: BackendHandle,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<'delivered' | 'already_resolved'> {
    const state = this.trackSession(handle.id);
    const options = state.permissionOptions.get(requestId) ?? [];
    let response: Record<string, unknown>;
    if (decision === 'cancel') {
      response = { outcome: { outcome: 'cancelled' } };
    } else {
      const wanted: PermissionOptionKind =
        decision === 'allow' ? 'proceed' : 'reject';
      const option = options.find((candidate) => candidate.kind === wanted);
      response = option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    }
    const delivered = await this.client.respondToSessionPermission(
      handle.id,
      requestId,
      response,
      this.options.clientId,
    );
    if (delivered) state.permissionOptions.delete(requestId);
    return delivered ? 'delivered' : 'already_resolved';
  }

  async close(): Promise<void> {
    this.sessions.clear();
  }

  // -- internals -----------------------------------------------------------

  private trackSession(
    sessionId: string,
    seed?: Partial<Pick<SessionState, 'busy'>>,
  ): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        busy: seed?.busy ?? false,
        turnBuffer: '',
        permissionOptions: new Map(),
        closed: false,
      };
      this.sessions.set(sessionId, state);
    } else if (seed?.busy !== undefined) {
      state.busy = seed.busy;
    }
    return state;
  }

  private async buildPromptBlocks(
    sessionId: string,
    blocks: readonly ContentBlock[],
  ): Promise<Array<Record<string, unknown>>> {
    const prompt: Array<Record<string, unknown>> = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        prompt.push({ type: 'text', text: block.text });
        continue;
      }
      // Image: upload as a session attachment and reference it, so the
      // prompt body stays small and the daemon owns the bytes.
      const reference = await this.client.uploadSessionAttachment(
        sessionId,
        new Blob([block.data as BlobPart], { type: block.mimeType }),
        block.name ?? 'attachment',
        block.mimeType,
      );
      prompt.push(reference);
    }
    return prompt;
  }

  private normalize(
    state: SessionState,
    envelope: {
      type: string;
      data: unknown;
      promptId?: string;
      originatorClientId?: string;
    },
  ): BackendEvent[] {
    const data = isRecord(envelope.data) ? envelope.data : {};
    switch (envelope.type) {
      case 'pending_prompt_started': {
        state.busy = true;
        state.turnBuffer = '';
        const jobRef = envelope.promptId ?? state.activeJobRef;
        if (jobRef !== undefined) state.activeJobRef = jobRef;
        return [
          { type: 'turn_started', ...(jobRef !== undefined ? { jobRef } : {}) },
        ];
      }
      case 'session_update': {
        const update = isRecord(data['update']) ? data['update'] : undefined;
        if (!update) return [];
        const kind = update['sessionUpdate'];
        if (kind === 'agent_message_chunk') {
          const content = isRecord(update['content'])
            ? update['content']
            : undefined;
          const text = content?.['text'];
          if (typeof text === 'string') {
            state.turnBuffer = `${state.turnBuffer}${text}`;
            if (state.turnBuffer.length > MAX_DETAIL_CHARS) {
              state.turnBuffer = state.turnBuffer.slice(-MAX_DETAIL_CHARS);
            }
          }
          return [];
        }
        if (kind === 'tool_call') {
          const title = update['title'];
          return [
            {
              type: 'progress',
              ...(envelope.promptId !== undefined
                ? { jobRef: envelope.promptId }
                : {}),
              summary: typeof title === 'string' ? title : 'running a tool',
            },
          ];
        }
        return [];
      }
      case 'turn_complete': {
        state.busy = false;
        const jobRef = envelope.promptId ?? state.activeJobRef;
        state.activeJobRef = undefined;
        const detail = state.turnBuffer.trim();
        state.turnBuffer = '';
        return [
          {
            type: 'turn_complete',
            ...(jobRef !== undefined ? { jobRef } : {}),
            summary: clampTail(detail, MAX_SUMMARY_CHARS),
            ...(detail ? { detail } : {}),
          },
        ];
      }
      case 'turn_error':
      case 'prompt_cancelled': {
        state.busy = false;
        const jobRef = envelope.promptId ?? state.activeJobRef;
        state.activeJobRef = undefined;
        state.turnBuffer = '';
        const message = data['message'] ?? data['error'];
        return [
          {
            type: 'turn_error',
            ...(jobRef !== undefined ? { jobRef } : {}),
            error:
              envelope.type === 'prompt_cancelled'
                ? 'cancelled'
                : typeof message === 'string'
                  ? message
                  : 'the task failed',
          },
        ];
      }
      case 'permission_request': {
        const requestId = data['requestId'];
        if (typeof requestId !== 'string') return [];
        const rawOptions = Array.isArray(data['options'])
          ? data['options']
          : [];
        const options: PermissionOption[] = rawOptions.flatMap((raw) => {
          if (!isRecord(raw) || typeof raw['optionId'] !== 'string') return [];
          const label =
            typeof raw['label'] === 'string' ? raw['label'] : undefined;
          return [
            {
              optionId: raw['optionId'],
              ...(label !== undefined ? { label } : {}),
              kind: classifyOption(raw['optionId'], label),
            },
          ];
        });
        state.permissionOptions.set(requestId, options);
        return [
          {
            type: 'permission_request',
            requestId,
            title: describeToolCall(data['toolCall']),
            options,
            payload: data,
          },
        ];
      }
      case 'permission_resolved':
      case 'permission_already_resolved': {
        const requestId = data['requestId'];
        if (typeof requestId !== 'string') return [];
        state.permissionOptions.delete(requestId);
        return [
          {
            type: 'permission_resolved',
            requestId,
            byUs:
              this.options.clientId !== undefined &&
              envelope.originatorClientId === this.options.clientId,
          },
        ];
      }
      case 'session_died':
      case 'session_closed': {
        state.closed = true;
        state.busy = false;
        return [{ type: 'session_closed' }];
      }
      default:
        return [];
    }
  }
}
