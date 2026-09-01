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
 *   it against the daemon-issued clientId for the session distinguishes "we
 *   answered" from "someone answered in WebShell". The issued id comes back
 *   on the create/attach response; self-made ids are rejected by the
 *   daemon's client registration guard, so every per-session call echoes
 *   the issued one. Sessions adopted via `session_list` never receive an
 *   issued id, so the adaptor also records every requestId it voted on and
 *   attributes a resolution for one of those to itself.
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
  ): Promise<{
    sessionId: string;
    hasActivePrompt?: boolean;
    clientId?: string;
  }>;
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
  updateSessionMetadata(
    sessionId: string,
    metadata: { displayName?: string },
    clientId?: string,
  ): Promise<{ displayName?: string }>;
}

export interface QwenCodeAdaptorOptions {
  /** qwen serve base URL, e.g. `http://127.0.0.1:4170`. */
  baseUrl: string;
  token?: string;
  /** Default cwd for new sessions; falls back to the daemon's workspaceCwd. */
  defaultCwd?: string;
  /** Stable client identity used for permission-vote attribution. */
  clientId?: string;
  /**
   * Backend name (what the voice model sees in session_list). Defaults to
   * 'qwen-code'; a configured name lets two qwen-code backends coexist
   * without colliding in the registry's byName map or the scoped-id keys.
   */
  name?: string;
  /** Injection seam for unit tests. */
  client?: DaemonClientLike;
}

interface SessionState {
  busy: boolean;
  activeJobRef?: string;
  /** Daemon-issued client id for this session; echoed on every call. */
  clientId?: string;
  /** Accumulated assistant text for the current turn. */
  turnBuffer: string;
  /** Options captured per pending permission request, for decision mapping. */
  permissionOptions: Map<string, readonly PermissionOption[]>;
  /**
   * Permission requestIds this adaptor voted on. Sessions adopted via
   * session_list carry no daemon-issued clientId, so originator comparison
   * alone can never attribute our own vote — this set is the fallback.
   * Entries are removed when the request resolves.
   */
  ownVotes: Set<string>;
  closed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map one wire permission option to the adaptor's kind + escalation.
 *
 * qwen serve stamps every option with the ACP structured `kind`
 * (`allow_once` | `allow_always` | `reject_once` | `reject_always` — see
 * `toPermissionOptions` in packages/cli acp-integration/permissionUtils.ts);
 * that is authoritative when present. An unknown structured kind fails
 * closed to 'other'. The word heuristics run only when the backend omitted
 * the field entirely.
 */
function classifyOption(
  optionId: string,
  name: string | undefined,
  wireKind: string | undefined,
): { kind: PermissionOptionKind; escalation?: 'once' | 'always' } {
  switch (wireKind) {
    case 'allow_once':
      return { kind: 'proceed', escalation: 'once' };
    case 'allow_always':
      return { kind: 'proceed', escalation: 'always' };
    case 'reject_once':
      return { kind: 'reject', escalation: 'once' };
    case 'reject_always':
      return { kind: 'reject', escalation: 'always' };
    default:
      break;
  }
  // Fail closed: a structured kind we do not understand must not be votable
  // through a bare "allow"/"deny".
  if (wireKind !== undefined) return { kind: 'other' };
  // Fallback for backends that omit the structured kind. Snake/kebab ids
  // ("proceed_once") must split into words — `\b` treats an underscore as a
  // word character and would never match inside them.
  const haystack = `${optionId} ${name ?? ''}`
    .toLowerCase()
    .replace(/[_-]/g, ' ');
  const escalation = /\balways\b/.test(haystack)
    ? ('always' as const)
    : /\bonce\b/.test(haystack)
      ? ('once' as const)
      : undefined;
  // Word boundaries matter: a bare /no/ would match inside "notify" and
  // misroute an allow vote to a reject option.
  if (/\b(allow|proceed|approve|yes|accept)\b/.test(haystack)) {
    return { kind: 'proceed', ...(escalation ? { escalation } : {}) };
  }
  if (/\b(deny|reject|refuse|no|cancel)\b/.test(haystack)) {
    return { kind: 'reject', ...(escalation ? { escalation } : {}) };
  }
  return { kind: 'other' };
}

/**
 * The narrowest option of the wanted kind. A bare voice "allow" must take
 * the one-shot grant, never persist an always-allow rule (serve offers
 * [proceed_always_project, proceed_always_user, proceed_once, cancel] —
 * first-match would pick the project-wide rule).
 */
function pickLeastEscalating(
  options: readonly PermissionOption[],
  wanted: PermissionOptionKind,
): PermissionOption | undefined {
  const rank = (option: PermissionOption): number =>
    option.escalation === 'once' ? 0 : option.escalation === undefined ? 1 : 2;
  let best: PermissionOption | undefined;
  for (const candidate of options) {
    if (candidate.kind !== wanted) continue;
    if (best === undefined || rank(candidate) < rank(best)) best = candidate;
  }
  return best;
}

/**
 * Compose the human-readable permission title. Control sequences are
 * stripped (the title flows verbatim into the spoken ask and keys the
 * broker's standing rule — raw ESC/OSC bytes must not reach speech or
 * anchor a trust grant), but NOT truncated to the first line: the
 * standing-rule key must span the whole command.
 */
function describeToolCall(toolCall: unknown): string {
  if (!isRecord(toolCall)) return 'a tool call';
  const name = typeof toolCall['name'] === 'string' ? toolCall['name'] : '';
  const command =
    typeof toolCall['command'] === 'string' ? toolCall['command'] : '';
  const title = typeof toolCall['title'] === 'string' ? toolCall['title'] : '';
  const detail = stripControlSequences(command || title);
  if (name && detail) return `${name}: ${detail}`;
  return name || detail || 'a tool call';
}

/**
 * Remove terminal control sequences without the first-line cut that
 * sanitizeTitleLine applies — the permission key needs the whole command.
 * Mirrors the same sequence families (OSC, CSI, SS2/SS3/DCS, C0/DEL/C1).
 */
function stripControlSequences(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[NOP]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ' ')
  );
}

/**
 * Slice the last `max` UTF-16 units, snapping the cut off a split surrogate
 * pair: a cut landing between the halves would lead with a lone low
 * surrogate that renders/speaks as U+FFFD.
 */
function tailSlice(text: string, max: number): string {
  let start = text.length - max;
  const unit = text.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff) start += 1;
  return text.slice(start);
}

function clampTail(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `…${tailSlice(trimmed, max)}`;
}

/**
 * One clean line for a tool-call title: first line only, terminal control
 * sequences stripped. Minimal inline of core's stripTerminalControlSequences
 * (packages/core utils/terminalSafe.ts) — the monolith's voice consumer
 * applied the same guard before titles reached the realtime model
 * (live-session-coordinator.ts), and neither acp-bridge nor the daemon
 * sanitizes upstream.
 */
function sanitizeTitleLine(title: string): string {
  const firstLine = title.split(/\r?\n/, 1)[0] ?? '';
  return (
    firstLine
      // OSC: ESC ] ... (BEL | ST)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      // CSI: ESC [ params intermediates final
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // SS2/SS3/DCS leaders
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[NOP]/g, '')
      // Remaining C0 controls + DEL + C1 controls
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
      .trim()
  );
}

export class QwenCodeAdaptor implements BackendAdaptor {
  readonly name: string;

  private readonly client: DaemonClientLike;
  private readonly options: QwenCodeAdaptorOptions;
  private readonly sessions = new Map<string, SessionState>();
  /** Every cwd sessions were created in; listSessions unions across them. */
  private readonly sessionCwds = new Set<string>();
  private workspaceCwd: string | undefined;

  constructor(options: QwenCodeAdaptorOptions) {
    this.options = options;
    this.name = options.name ?? ADAPTOR_NAME;
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
      const detail = error instanceof Error ? error.message : String(error);
      const status =
        isRecord(error) && typeof error['status'] === 'number'
          ? error['status']
          : undefined;
      if (status !== undefined) {
        // The daemon answered — it is running but refused the request.
        // A "start it" hint would send the operator hunting for a daemon
        // that already exists.
        throw new Error(
          `qwen serve at ${this.options.baseUrl} responded with HTTP ` +
            `${status} and refused the request: ${detail}. ` +
            'Check the auth token and base URL.',
        );
      }
      throw new Error(
        `qwen serve is not reachable at ${this.options.baseUrl}: ` +
          `${detail}. ` +
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
    if (cwd !== undefined) this.sessionCwds.add(cwd);
    const state = this.trackSession(session.sessionId, {
      busy: session.hasActivePrompt === true,
      // The daemon issues the authoritative per-client id on create/attach;
      // every later call for this session must echo it (a self-made id is
      // rejected by the daemon's client registration guard). Older daemons
      // omit it — those calls stay anonymous.
      ...(typeof session.clientId === 'string'
        ? { clientId: session.clientId }
        : {}),
    });
    if (opts?.label !== undefined) {
      // The daemon session's displayName is what listSessions (here and in
      // every other client) reports back — the requested label is useless
      // unless it is applied to the daemon session itself.
      await this.client.updateSessionMetadata(
        session.sessionId,
        { displayName: opts.label },
        state.clientId,
      );
    }
    return { id: session.sessionId, adaptor: ADAPTOR_NAME };
  }

  async listSessions(): Promise<SessionSummary[]> {
    const defaultCwd = this.options.defaultCwd ?? this.workspaceCwd;
    const cwds = new Set<string>();
    if (defaultCwd !== undefined) cwds.add(defaultCwd);
    for (const cwd of this.sessionCwds) cwds.add(cwd);
    const summaries = new Map<string, SessionSummary>();
    for (const cwd of cwds) {
      // The daemon catalog accumulates sessions from every client and the
      // SDK defaults to a 20-row first page; 1000 is the server-side clamp.
      const sessions = await this.client.listWorkspaceSessions(cwd, {
        pageSize: 1000,
      });
      for (const raw of sessions) {
        const sessionId = raw['sessionId'];
        if (typeof sessionId !== 'string' || summaries.has(sessionId)) {
          continue;
        }
        const tracked = this.sessions.get(sessionId);
        const label = raw['displayName'];
        const hasActivePrompt = raw['hasActivePrompt'];
        summaries.set(sessionId, {
          handle: { id: sessionId, adaptor: ADAPTOR_NAME },
          ...(typeof label === 'string' ? { label } : {}),
          cwd,
          state: tracked
            ? tracked.closed
              ? ('closed' as const)
              : tracked.busy
                ? ('busy' as const)
                : ('idle' as const)
            : // Untracked (e.g. after a qwen-live restart): the wire record
              // itself says whether a prompt is running.
              typeof hasActivePrompt === 'boolean'
              ? hasActivePrompt
                ? ('busy' as const)
                : ('idle' as const)
              : ('unknown' as const),
        });
      }
    }
    return [...summaries.values()];
  }

  async prompt(
    handle: BackendHandle,
    blocks: readonly ContentBlock[],
    opts?: { steer?: boolean },
  ): Promise<PromptReceipt> {
    const state = this.trackSession(handle.id);

    if (opts?.steer && state.busy) {
      // Mid-turn injection is text-only on the wire; a handoff carrying
      // image attachments must go through a full prompt so the images are
      // not silently dropped — the fall-through below queues it as the
      // session's next turn.
      const hasImages = blocks.some((block) => block.type === 'image');
      if (!hasImages) {
        const message = blocks
          .filter(
            (block): block is Extract<ContentBlock, { type: 'text' }> =>
              block.type === 'text',
          )
          .map((block) => block.text)
          .join('\n\n');
        let steered: { accepted: boolean; messageId?: string } | undefined;
        try {
          steered = await this.client.enqueueMidTurnMessage(
            handle.id,
            message,
            state.clientId !== undefined ? { clientId: state.clientId } : {},
          );
        } catch (error) {
          // The mid-turn route 400s on over-long messages; the identical
          // payload is admissible as a queued full prompt, so fall through
          // instead of failing the handoff. Anything else is a real error.
          if (!(isRecord(error) && error['status'] === 400)) throw error;
        }
        if (steered?.accepted) {
          return {
            status: 'accepted',
            joinedActiveTurn: true,
            ...(state.activeJobRef !== undefined
              ? { jobRef: state.activeJobRef }
              : {}),
            note: 'joined the currently running task',
          };
        }
      }
      // Either the turn ended between our busy check and the injection, or
      // the payload needs a full prompt: fall through — that is exactly the
      // "queued as the next turn" tier.
    }

    const prompt = await this.buildPromptBlocks(handle.id, blocks);
    let accepted: Record<string, unknown>;
    try {
      accepted = await this.client.promptNonBlocking(
        handle.id,
        { prompt },
        undefined,
        state.clientId,
      );
    } catch (error) {
      // Queue-full comes in two shapes: DaemonHttpError carries a top-level
      // 503 status; the SDK's client-side guard throws
      // DaemonPendingPromptLimitError (no status field).
      if (
        isRecord(error) &&
        (error['status'] === 503 ||
          error['name'] === 'DaemonPendingPromptLimitError')
      ) {
        return {
          status: 'rejected',
          note: 'the session is busy and its queue is full; wait or stop the current task first',
        };
      }
      throw error;
    }
    const promptId = accepted['promptId'];
    const jobRef = typeof promptId === 'string' ? promptId : undefined;
    // Only advance activeJobRef when this prompt actually starts the
    // session's turn: a busy-session fallback (image steer, over-long text
    // 400) queues behind the running turn, and overwriting the ref here
    // would make a later accepted steer report the QUEUED prompt's id as
    // the running turn's jobRef. pending_prompt_started establishes it
    // when the queued prompt eventually runs.
    const wasBusy = state.busy;
    state.busy = true;
    if (!wasBusy && jobRef !== undefined) state.activeJobRef = jobRef;
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
      ...(state.clientId !== undefined ? { clientId: state.clientId } : {}),
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
    await this.client.cancel(handle.id, this.sessions.get(handle.id)?.clientId);
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
      const option = pickLeastEscalating(options, wanted);
      response = option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    }
    // Record the vote BEFORE the HTTP round-trip: the daemon publishes the
    // SSE permission_resolved before the vote response returns, so waiting
    // for `delivered` can lose the race against our own event pump — and on
    // adopted sessions the own-vote record is the only byUs signal.
    state.ownVotes.add(requestId);
    let delivered: boolean;
    try {
      delivered = await this.client.respondToSessionPermission(
        handle.id,
        requestId,
        response,
        state.clientId,
      );
    } catch (error) {
      state.ownVotes.delete(requestId);
      throw error;
    }
    if (delivered) {
      state.permissionOptions.delete(requestId);
    } else {
      // Someone else settled it first; our vote did not count.
      state.ownVotes.delete(requestId);
    }
    return delivered ? 'delivered' : 'already_resolved';
  }

  async close(): Promise<void> {
    this.sessions.clear();
  }

  // -- internals -----------------------------------------------------------

  private trackSession(
    sessionId: string,
    seed?: Partial<Pick<SessionState, 'busy' | 'clientId'>>,
  ): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        busy: seed?.busy ?? false,
        turnBuffer: '',
        permissionOptions: new Map(),
        ownVotes: new Set(),
        closed: false,
      };
      this.sessions.set(sessionId, state);
    } else if (seed?.busy !== undefined) {
      state.busy = seed.busy;
    }
    if (seed?.clientId !== undefined) state.clientId = seed.clientId;
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
              state.turnBuffer = tailSlice(state.turnBuffer, MAX_DETAIL_CHARS);
            }
          }
          return [];
        }
        if (kind === 'tool_call') {
          const title = update['title'];
          const summary =
            typeof title === 'string' ? sanitizeTitleLine(title) : '';
          return [
            {
              type: 'progress',
              ...(envelope.promptId !== undefined
                ? { jobRef: envelope.promptId }
                : {}),
              summary: summary || 'running a tool',
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
        const jobRef = envelope.promptId ?? state.activeJobRef;
        const rawOptions = Array.isArray(data['options'])
          ? data['options']
          : [];
        const options: PermissionOption[] = rawOptions.flatMap((raw) => {
          if (!isRecord(raw) || typeof raw['optionId'] !== 'string') return [];
          // Wire shape (ACP PermissionOption): optionId + name + kind.
          const name =
            typeof raw['name'] === 'string' ? raw['name'] : undefined;
          const wireKind =
            typeof raw['kind'] === 'string' ? raw['kind'] : undefined;
          const classified = classifyOption(raw['optionId'], name, wireKind);
          return [
            {
              optionId: raw['optionId'],
              ...(name !== undefined ? { label: name } : {}),
              kind: classified.kind,
              ...(classified.escalation !== undefined
                ? { escalation: classified.escalation }
                : {}),
            },
          ];
        });
        state.permissionOptions.set(requestId, options);
        return [
          {
            type: 'permission_request',
            ...(jobRef !== undefined ? { jobRef } : {}),
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
        // The daemon's originator stamp is authoritative when present:
        // another client (WebShell) can resolve the request while our own
        // vote is still mid-round-trip, and the short-circuit below would
        // otherwise attribute THEIR resolution to us (skipping the spoken
        // ask retraction). ownVotes only covers anonymous resolutions —
        // adopted sessions carry no issued clientId to compare against.
        const votedByUs = state.ownVotes.delete(requestId);
        return [
          {
            type: 'permission_resolved',
            requestId,
            byUs:
              envelope.originatorClientId !== undefined
                ? state.clientId !== undefined &&
                  envelope.originatorClientId === state.clientId
                : votedByUs,
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
