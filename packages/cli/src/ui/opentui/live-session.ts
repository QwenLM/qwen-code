/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live-client wiring (P1d): builds a real agent-loop event source from a
 * qwen-code `Config` and maps it onto the neutral `StreamEvent` so the OpenTUI
 * backend renders a LIVE conversation (requires valid API credentials at run
 * time). Without credentials this throws and callers fall back to
 * resume/scripted modes.
 *
 * The optional `AbortSignal` is forwarded to `client.sendMessageStream` so the
 * UI can interrupt the live stream (Esc); the generator then rejects with the
 * abort error and the caller settles the UI state.
 *
 * Experimental: part of PR #8677; the legacy ink TUI remains the default until
 * feature parity + regression are complete.
 */

import { appendFileSync } from 'node:fs';
import type {
  AgentResultDisplay,
  Config,
  ToolCallConfirmationDetails,
  ToolResultDisplay,
} from '@qwen-code/qwen-code-core';
import {
  ApprovalMode,
  clampInlineMediaPart,
  compactToolResultDisplayForHistory,
  CoreToolScheduler,
  didWriteProjectContextFile,
  formatFullTurnVisionNotice,
  formatVisionBridgeNotice,
  getErrorMessage,
  getFullTurnVisionModelSelector,
  hasImageParts,
  isShellProgressData,
  normalizeParts,
  parseAndFormatApiError,
  refreshMemoryInstruction,
  runVisionBridge,
  SendMessageType,
  shouldRunVisionBridge,
  splitImageParts,
  ToolNames,
} from '@qwen-code/qwen-code-core';
import type { Part, PartListUnion } from '@google/genai';
import {
  createEventMapper,
  extractFileDiff,
  renderResultDisplay,
  type OpenTuiStreamEvent,
} from './event-adapter.js';
import { isAtCommand } from '../utils/commandUtils.js';
import { handleAtCommand } from '../hooks/atCommandProcessor.js';
import { ToolCallStatus, type IndividualToolCallDisplay } from '../types.js';

interface LooseCompletedCall {
  request: { callId: string; name?: string; args?: unknown };
  status: string;
  response?: {
    responseParts?: Part[];
    resultDisplay?: unknown;
    error?: unknown;
  };
}

/** Options the backend passes through to the live turn. */
export interface LivePromptOptions {
  /** Per-turn model override (submit_prompt's modelOverride parity). */
  modelOverride?: string;
  /**
   * "Enter to steer" parity: called at each tool boundary (after tools ran,
   * before their results go back to the model). Returned texts are resolved
   * the way ink resolves a steered message — `@path` expansion, then the
   * prompt-side vision bridge — and appended after the functionResponse parts
   * as genuine user content (the original's drainSteerAtBoundary sampling-
   * boundary drain). Skipped when the turn is aborted (messages then stay
   * queued).
   */
  drainSteering?: () => string[];
  /**
   * Puts drained steering texts back at the front of the queue (ink's
   * `midTurnRestoreRef`). Resolution is all-or-nothing — an abort anywhere in
   * it sends nothing to the model, so every text that left `drainSteering`
   * comes back here rather than vanishing with the turn.
   */
  restoreSteering?: (texts: readonly string[]) => void;
  /**
   * Scheduler-level confirmation requests the permission flow did not
   * auto-approve (ask_user_question in every mode; edit/exec in DEFAULT).
   * The backend renders the matching dialog and resolves the call through
   * `confirmationDetails.onConfirm` — without this the waiting call would
   * never settle and the turn would silently die ("skipped").
   */
  onWaitingCall?: (call: {
    callId: string;
    name: string;
    confirmationDetails: ToolCallConfirmationDetails;
  }) => void;
  /**
   * ink parity (useGeminiStream refreshContextFilesOnWriteRef): when the
   * submitting slash command marked the turn (e.g. a skill that edits
   * GEMINI.md), check each completed tool batch for a context-file write and
   * refresh the memory instruction so the model sees the new content.
   */
  refreshContextFilesOnWrite?: boolean;
  /**
   * Raw composer text for `UserPromptSubmit` provenance (`submitted_prompt`).
   * Core only honours it on a UserQuery, so it rides the first turn and the
   * tool-result continuations below omit it by construction — matching the
   * documented rule that continuations carry no provenance.
   */
  submittedPrompt?: string;
  /**
   * PromptId minted by the backend (`nextLivePromptId`) at submit time so
   * the user item and this request share the checkpoint key. Omitted → one
   * is minted here (first turn of a session, …).
   */
  promptId?: string;
}

/**
 * Shift+Tab cycle order (core approval-mode.ts order:
 * [plan, default, auto-edit, auto, yolo]).
 */
export const APPROVAL_MODE_CYCLE: readonly ApprovalMode[] = [
  ApprovalMode.PLAN,
  ApprovalMode.DEFAULT,
  ApprovalMode.AUTO_EDIT,
  ApprovalMode.AUTO,
  ApprovalMode.YOLO,
];

/** Next mode in the Shift+Tab cycle (unset mode cycles from DEFAULT). */
export function nextApprovalMode(
  current: ApprovalMode | undefined,
): ApprovalMode {
  const idx = APPROVAL_MODE_CYCLE.indexOf(current ?? ApprovalMode.DEFAULT);
  return APPROVAL_MODE_CYCLE[(idx + 1) % APPROVAL_MODE_CYCLE.length];
}

/** A scheduler call parked in `awaiting_approval`, tracked by the backend. */
export interface WaitingCallInfo {
  callId: string;
  name: string;
  confirmationDetails: ToolCallConfirmationDetails;
}

// ink useGeminiStream EDIT_TOOL_NAMES parity (AUTO_EDIT auto-approves edits only).
const EDIT_TOOL_NAMES = new Set([
  ToolNames.EDIT,
  'replace', // legacy alias, may still arrive from older providers
  ToolNames.WRITE_FILE,
  ToolNames.NOTEBOOK_EDIT,
]);

/**
 * Waiting calls an approval-mode switch auto-confirms with ProceedOnce (ink
 * useGeminiStream handleApprovalModeChange parity): YOLO approves every
 * waiting call, AUTO_EDIT only edit tools; calls flagged hideAlwaysAllow
 * (explicit-interaction / PM ask rules) are never auto-approved. Other mode
 * switches auto-approve nothing.
 */
export function selectAutoApprovals(
  newMode: ApprovalMode,
  waiting: readonly WaitingCallInfo[],
): WaitingCallInfo[] {
  if (newMode !== ApprovalMode.YOLO && newMode !== ApprovalMode.AUTO_EDIT) {
    return [];
  }
  let calls = waiting.filter((call) => {
    const details = call.confirmationDetails;
    return !('hideAlwaysAllow' in details && details.hideAlwaysAllow === true);
  });
  if (newMode === ApprovalMode.AUTO_EDIT) {
    calls = calls.filter((call) => EDIT_TOOL_NAMES.has(call.name));
  }
  return calls;
}

// Cross-turn prompt counter for the ink-parity promptId
// (`sessionId########promptCount`, useGeminiStream.ts:3287).
let promptCount = 0;

/** Test/demo seam: reset the module prompt counter. */
export function resetPromptCountForTesting(): void {
  promptCount = 0;
}

/**
 * Ink-parity promptId (`sessionId########promptCount`): minted once per turn
 * at submit time so the echoed user item and the model request share the key
 * file checkpoints are recorded under.
 */
export function nextLivePromptId(config: Config): string {
  const id = `${config.getSessionId()}########${promptCount}`;
  promptCount += 1;
  return id;
}

/** Compact token count for task-end stats (matches the scripted demo form). */
function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Single-consumer async queue: lets the scheduler's output callbacks enqueue
 * neutral events while the generator is awaiting tool completion, so live
 * tool output streams instead of arriving in one lump at the end.
 */
function createEventQueue<T>() {
  const buffer: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(item: T) {
      if (closed) return;
      buffer.push(item);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async next(): Promise<T | undefined> {
      for (;;) {
        if (buffer.length > 0) return buffer.shift();
        if (closed) return undefined;
        // Registration happens synchronously before the await yields, so a
        // push can never land between the empty check and the waiter.
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/**
 * One `@path` read as the tool card ink renders through `handleAtCommand`'s
 * `addItem` (a `tool_group` history item): start → result → end, so the card
 * is already settled when it lands and a failed read explains itself.
 */
function atMentionCardEvents(
  display: IndividualToolCallDisplay,
): OpenTuiStreamEvent[] {
  const events: OpenTuiStreamEvent[] = [
    {
      type: 'tool-start',
      id: display.callId,
      tool: display.name,
      title: display.description,
    },
  ];
  const text = renderResultDisplay(display.resultDisplay);
  if (text)
    events.push({ type: 'tool-result', id: display.callId, display: text });
  const failed = display.status === ToolCallStatus.Error;
  events.push({
    type: 'tool-end',
    id: display.callId,
    success: !failed,
    summary: failed ? 'error' : 'ok',
  });
  return events;
}

/**
 * ink parity (use-llm-stream `processQuery` for a fresh turn): `@path`
 * mentions are expanded where the prompt enters the stream, never at the
 * composer, so the transcript keeps what the user typed and queued text that
 * survives to become the next turn is expanded by the time it reaches the
 * model. Text drained mid-turn goes through the same expansion —
 * {@link resolveSteeredPromptParts} adds the read deadline ink puts on that
 * hop ({@link expandAtMentions}'s caller waits indefinitely).
 *
 * `events` carries the read cards even when the expansion declines — the one
 * decline is a failed read, and ink reports it instead of sending the
 * unexpanded text.
 */
async function expandAtMentions(
  config: Config,
  query: string,
  signal: AbortSignal,
): Promise<{
  parts: PartListUnion;
  events: OpenTuiStreamEvent[];
  declined: boolean;
}> {
  const result = await handleAtCommand({
    query,
    config,
    onDebugMessage: (message) => config.getDebugLogger().debug(message),
    messageId: Date.now(),
    signal,
  });
  const events = (result.toolDisplays ?? []).flatMap(atMentionCardEvents);
  if (!result.shouldProceed || result.processedQuery === null) {
    return { parts: query, events, declined: true };
  }
  return { parts: result.processedQuery, events, declined: false };
}

/**
 * The per-turn model override as the vision bridge sees it — ink's two coupled
 * refs. A trailing NUL on `current` marks the bridge's own full-turn pick;
 * `inline` means the override came from `submit_prompt` and wins over the
 * bridge for the whole turn.
 */
interface TurnModelOverride {
  current: string | undefined;
  inline: boolean;
}

/**
 * ink parity (`applyVisionBridgeIfNeeded`): with a vision bridge configured and
 * a primary model that cannot read images, an image must be converted before it
 * reaches the model — never forwarded as raw `inlineData`. The shape follows the
 * other non-ink port of this hop (acp-integration
 * `Session.#applyBridgeConversionsIfNeeded`) rather than ink's React hook.
 *
 * `null` parts mean "do not send this": the turn stops (fresh hop) or the
 * message is dropped (steering hop), exactly as ink declines.
 */
async function applyPromptVisionBridge(
  config: Config,
  parts: PartListUnion,
  signal: AbortSignal,
  turnModel: TurnModelOverride,
): Promise<{ parts: PartListUnion | null; events: OpenTuiStreamEvent[] }> {
  const events: OpenTuiStreamEvent[] = [];
  // Every skip path hands back the caller's own parts, untouched and
  // unnormalized — ink does, so a plain text prompt keeps its shape.
  if (!hasImageParts(parts)) return { parts, events };
  if (turnModel.current?.endsWith('\0') || turnModel.inline) {
    return { parts, events };
  }
  if (!shouldRunVisionBridge(config)) return { parts, events };
  if (signal.aborted) return { parts: null, events };

  const fullTurnModel = config.getDefaultVisionBridgeModel();
  if (fullTurnModel?.agentCapable) {
    // The whole turn moves to the image-capable model, so the images stay.
    const fullTurnParts = normalizeParts(parts).map((part) =>
      clampInlineMediaPart(part),
    );
    if (!hasImageParts(fullTurnParts)) return { parts: fullTurnParts, events };
    turnModel.current = getFullTurnVisionModelSelector(fullTurnModel);
    // ink shows this as a `vision_notice` row; OpenTUI has no separate notice
    // kind, so it rides the info row the bridge's own text already fills.
    events.push({
      type: 'info',
      text: formatFullTurnVisionNotice(fullTurnModel),
    });
    return { parts: fullTurnParts, events };
  }

  const bridgeResult = await runVisionBridge({ config, parts, signal });
  // One notice either way: the egress disclosure on success, the reason when
  // the attempt failed or cancelled after images had already been sent.
  if (bridgeResult.status !== 'skipped' || bridgeResult.egressOccurred) {
    events.push({
      type: bridgeResult.status === 'failed' ? 'error' : 'info',
      text: formatVisionBridgeNotice(bridgeResult),
    });
  }
  if (signal.aborted) return { parts: null, events };
  if (bridgeResult.applied && bridgeResult.parts != null) {
    return { parts: normalizeParts(bridgeResult.parts), events };
  }
  // No usable replacement: drop the images and proceed on the remaining text.
  const textOnly = splitImageParts(parts).nonImageParts;
  return { parts: textOnly.length > 0 ? textOnly : null, events };
}

/** Rejects as soon as `signal` fires, so a read that ignores it cannot park the boundary. */
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const rejectWithAbort = () =>
      reject(
        signal.reason ?? new Error('Mid-turn @ command resolution aborted'),
      );
    if (signal.aborted) rejectWithAbort();
    else signal.addEventListener('abort', rejectWithAbort, { once: true });
  });
}

// ink's MID_TURN_AT_COMMAND_RESOLVE_TIMEOUT_MS: a hung read must not hold the
// sampling boundary open indefinitely.
const MID_TURN_STEER_READ_TIMEOUT_MS = 10_000;

interface SteeredPromptResolution {
  /** User content for the model, segments joined by a blank line as ink joins them. */
  parts: Part[];
  /** Read cards and bridge notices — discarded when the hop is restored. */
  events: OpenTuiStreamEvent[];
  /**
   * Texts to put back at the front of the queue. All of them or none: ink
   * discards the resolved parts when an abort lands, so nothing can go out
   * twice.
   */
  restore: string[];
}

/**
 * ink parity (`resolveSteeredMessages`): what the composer queued mid-turn is
 * resolved the same way an idle submission is — `@path` expansion, then the
 * prompt-side vision bridge — before it rides to the model as steering.
 *
 * Not ported, on purpose: ink's slash interception at this boundary (its goal
 * command has no OpenTUI counterpart) and its two-phase recording, which
 * defers the read cards until the messages are committed. Here the cards go out
 * as they are produced, and an abort drops the whole hop instead.
 */
async function resolveSteeredPromptParts(
  config: Config,
  texts: readonly string[],
  signal: AbortSignal,
  turnModel: TurnModelOverride,
): Promise<SteeredPromptResolution> {
  const restore = (): SteeredPromptResolution => ({
    parts: [],
    events: [],
    restore: [...texts],
  });
  const events: OpenTuiStreamEvent[] = [];
  const segments: Part[][] = [];

  for (const message of texts) {
    if (signal.aborted) return restore();
    let resolved: PartListUnion = [{ text: message }];
    if (isAtCommand(message)) {
      const deadline = new AbortController();
      const readSignal = AbortSignal.any([signal, deadline.signal]);
      const timer = setTimeout(() => {
        deadline.abort(new Error('Mid-turn @ command resolution timed out'));
      }, MID_TURN_STEER_READ_TIMEOUT_MS);
      let expanded: Awaited<ReturnType<typeof expandAtMentions>>;
      try {
        expanded = await Promise.race([
          expandAtMentions(config, message, readSignal),
          abortRejection(readSignal),
        ]);
      } catch (error) {
        const reason = getErrorMessage(error);
        config.getDebugLogger().debug(`Mid-turn @ command failed: ${reason}`);
        if (signal.aborted) return restore();
        events.push({
          type: 'warning',
          text: `Could not attach file: ${reason}`,
        });
        continue;
      } finally {
        clearTimeout(timer);
      }
      events.push(...expanded.events);
      if (expanded.declined) {
        if (signal.aborted) return restore();
        continue;
      }
      resolved = expanded.parts;
    }

    const bridged = await applyPromptVisionBridge(
      config,
      resolved,
      signal,
      turnModel,
    );
    events.push(...bridged.events);
    if (bridged.parts === null) {
      if (signal.aborted) return restore();
      continue;
    }
    const messageParts = normalizeParts(bridged.parts);
    if (messageParts.length > 0) segments.push(messageParts);
  }

  const parts: Part[] = [];
  for (const segment of segments) {
    if (parts.length > 0) parts.push({ text: '\n\n' });
    parts.push(...segment);
  }
  return { parts, events, restore: [] };
}

/**
 * Sends one user prompt through the real client and yields neutral events.
 * The caller (backend) drains this into the streaming model.
 *
 * The prompt is forwarded as a full `PartListUnion` (string or part list,
 * multimodal parts included) — exactly what `submit_prompt` outcomes carry —
 * and an optional per-turn `modelOverride` travels through
 * `SendMessageOptions` the way useGeminiStream feeds it.
 */
export async function* livePromptEvents(
  config: Config,
  prompt: PartListUnion,
  signal?: AbortSignal,
  options?: LivePromptOptions,
): AsyncGenerator<OpenTuiStreamEvent> {
  try {
    await config.initialize();
  } catch {
    /* already initialized by command loading / startup */
  }
  const client = config.getGeminiClient();
  const promptId = options?.promptId ?? nextLivePromptId(config);
  const abort = signal ?? new AbortController().signal;
  // Read per boundary rather than once: the vision bridge can pick a full-turn
  // model mid-turn, and the rest of the turn then stays on it (ink parity).
  const turnModel: TurnModelOverride = {
    current: options?.modelOverride,
    inline: options?.modelOverride !== undefined,
  };
  const map = createEventMapper({
    // ink handleErrorEvent parity: auth-aware formatting. The Ctrl+Y retry
    // hint travels on the error event's `hint` field (ErrorMessage renders
    // it inline in secondary color).
    formatError: (error) => {
      try {
        return parseAndFormatApiError(
          error,
          config.getContentGeneratorConfig()?.authType,
        );
      } catch {
        return error instanceof Error ? error.message : String(error);
      }
    },
    getModelName: () => turnModel.current ?? config.getModel(),
    getMaxSessionTurns: () => config.getMaxSessionTurns(),
  });
  const dbg = process.env['QWEN_OPENTUI_DEBUG'];

  // The ink app drives tool EXECUTION via useReactToolScheduler: the client
  // only yields `tool_call_request` and ends the turn, then the UI schedules
  // the tool and submits the functionResponses to continue. Replicate that
  // loop here so tools actually run under OpenTUI (drain -> schedule ->
  // submit results -> drain again).
  let nextPrompt: PartListUnion = prompt;
  // Provenance marks user-typed text: the composer submit and the follow-on
  // turn built from the mid-turn queue both carry it. A slash command's
  // generated `submit_prompt` payload does not, and ink never expands that
  // one (processQuery returns it before its own isAtCommand check).
  if (
    typeof prompt === 'string' &&
    options?.submittedPrompt !== undefined &&
    isAtCommand(prompt)
  ) {
    const expanded = await expandAtMentions(config, prompt, abort);
    for (const ev of expanded.events) yield ev;
    // A failed read reports itself on the card above; ink drops the
    // submission rather than sending the unexpanded text to the model.
    if (expanded.declined) return;
    nextPrompt = expanded.parts;
  }
  // ink runs the bridge on every query it hands the model
  // (`prepareQueryForLlm`), so an image attached at the composer converts here.
  const bridged = await applyPromptVisionBridge(
    config,
    nextPrompt,
    abort,
    turnModel,
  );
  for (const ev of bridged.events) yield ev;
  if (bridged.parts === null) return;
  nextPrompt = bridged.parts;
  let first = true;
  const waitingSeen = new Set<string>();
  for (;;) {
    const sendOptions = first
      ? {
          type: SendMessageType.UserQuery,
          ...(turnModel.current ? { modelOverride: turnModel.current } : {}),
          ...(options?.submittedPrompt
            ? { submittedPrompt: options.submittedPrompt }
            : {}),
        }
      : {
          type: SendMessageType.ToolResult,
          ...(turnModel.current ? { modelOverride: turnModel.current } : {}),
        };
    first = false;
    const pending: Array<{ callId: string; name: string; args?: unknown }> = [];
    const stream = client.sendMessageStream(
      nextPrompt,
      abort,
      promptId,
      sendOptions,
    );
    for await (const ev of stream) {
      if (dbg) {
        try {
          appendFileSync(
            '/tmp/opentui-events.log',
            `${(ev as { type?: string }).type}\n`,
          );
        } catch {
          /* ignore */
        }
      }
      if ((ev as { type?: string }).type === 'tool_call_request') {
        pending.push(
          (ev as { value: { callId: string; name: string; args?: unknown } })
            .value,
        );
      }
      for (const neutral of map(ev)) yield neutral;
    }
    if (pending.length === 0 || abort.aborted) return;

    // Live output bridge (ink outputUpdateHandler parity): scheduler output
    // chunks are mapped to neutral events and yielded WHILE the tools run.
    const live = createEventQueue<OpenTuiStreamEvent>();
    const taskStarted = new Set<string>();
    const taskToolsSeen = new Map<string, Set<string>>();
    const mapOutputChunk = (
      callId: string,
      chunk: ToolResultDisplay,
    ): OpenTuiStreamEvent[] => {
      // Shell liveness heartbeats are for headless consumers; the TUI
      // already shows a spinner (ink useReactToolScheduler parity).
      if (isShellProgressData(chunk)) return [];
      const agent = chunk as AgentResultDisplay | null;
      if (
        agent &&
        typeof agent === 'object' &&
        agent.type === 'task_execution'
      ) {
        // Subagent progress → task card events (stream-script.ts shape).
        const out: OpenTuiStreamEvent[] = [];
        if (!taskStarted.has(callId)) {
          taskStarted.add(callId);
          taskToolsSeen.set(callId, new Set());
          out.push({
            type: 'task-start',
            id: callId,
            name: agent.subagentName,
            description: agent.taskDescription,
          });
        }
        const seen = taskToolsSeen.get(callId);
        for (const tc of agent.toolCalls ?? []) {
          if (seen?.has(tc.callId)) continue;
          seen?.add(tc.callId);
          out.push({
            type: 'task-progress',
            id: callId,
            line: `↳ ${tc.description || tc.name}`,
          });
        }
        if (agent.status !== 'running' && agent.status !== 'background') {
          const stats = agent.executionSummary;
          out.push({
            type: 'task-end',
            id: callId,
            tools: stats?.totalToolCalls ?? agent.toolCalls?.length ?? 0,
            seconds: Math.round((stats?.totalDurationMs ?? 0) / 100) / 10,
            tokens: formatTokenCount(
              stats?.totalTokens ?? agent.tokenCount ?? 0,
            ),
          });
        }
        return out;
      }
      const display = renderResultDisplay(
        compactToolResultDisplayForHistory(chunk),
      );
      return display
        ? [{ type: 'tool-output', id: callId, delta: display }]
        : [];
    };

    let completed: LooseCompletedCall[] = [];
    // callIds whose real invocation description already went out (one per
    // call, ink mapToDisplay parity).
    const descriptionSeen = new Set<string>();
    const scheduler = new CoreToolScheduler({
      config,
      getPreferredEditor: () => undefined,
      onEditorClose: () => {},
      outputUpdateHandler: (callId, chunk) => {
        for (const ev of mapOutputChunk(callId, chunk)) live.push(ev);
      },
      onToolCallsUpdate: (calls) => {
        // Real invocation descriptions (ink mapToDisplay): the card title is
        // the tool's own getDescription() off the tracked call's invocation,
        // not a hand-rolled args guess. Pushed once per callId, as soon as
        // the scheduler builds the invocation (validating onward).
        for (const c of calls) {
          const callId = c.request.callId;
          if (descriptionSeen.has(callId)) continue;
          const invocation = 'invocation' in c ? c.invocation : undefined;
          if (!invocation) continue;
          descriptionSeen.add(callId);
          live.push({
            type: 'tool-description',
            id: callId,
            description: invocation.getDescription(),
          });
        }
        if (!options?.onWaitingCall) return;
        // Mirror the calls still awaiting approval: one that left the state
        // (resolved, or bounced back by a PreToolUse 'ask' hook under the
        // same callId) must be able to surface its dialog again.
        const awaiting = new Set(
          calls
            .filter((c) => c.status === 'awaiting_approval')
            .map((c) => c.request.callId),
        );
        for (const id of waitingSeen) {
          if (!awaiting.has(id)) waitingSeen.delete(id);
        }
        for (const c of calls) {
          if (c.status !== 'awaiting_approval') continue;
          const callId = c.request.callId;
          if (waitingSeen.has(callId)) continue;
          waitingSeen.add(callId);
          options.onWaitingCall({
            callId,
            name: c.request.name,
            confirmationDetails: c.confirmationDetails,
          });
        }
      },
      onAllToolCallsComplete: async (calls) => {
        completed = calls as unknown as LooseCompletedCall[];
        live.close();
      },
    });
    void scheduler.schedule(pending as never, abort);
    for (;;) {
      const ev = await live.next();
      if (ev === undefined) break;
      yield ev;
    }

    const responseParts: Part[] = [];
    for (const call of completed) {
      const resp = call.response;
      // FileDiff results ride as structured payloads so the tool card renders
      // colored diff lines (ink DiffResultRenderer parity) instead of the
      // flattened unified-diff text.
      const diff = extractFileDiff(resp?.resultDisplay);
      if (diff) {
        yield {
          type: 'tool-result',
          id: call.request.callId,
          display: '',
          diff,
        };
      } else {
        const display = renderResultDisplay(resp?.resultDisplay);
        if (display)
          yield { type: 'tool-result', id: call.request.callId, display };
      }
      const failed = call.status === 'error' || call.status === 'cancelled';
      yield {
        type: 'tool-end',
        id: call.request.callId,
        success: !failed,
        summary:
          call.status === 'cancelled'
            ? 'cancelled'
            : call.status === 'error'
              ? 'error'
              : 'ok',
      };
      if (resp?.responseParts) responseParts.push(...resp.responseParts);
    }
    // Sampling boundary: drained steering rides after the tool responses as
    // genuine user content (original useGeminiStream mid-turn drain).
    if (!abort.aborted) {
      const texts = (options?.drainSteering?.() ?? []).filter((text) => text);
      if (texts.length > 0) {
        const steered = await resolveSteeredPromptParts(
          config,
          texts,
          abort,
          turnModel,
        );
        if (steered.restore.length > 0) {
          options?.restoreSteering?.(steered.restore);
        }
        for (const ev of steered.events) yield ev;
        responseParts.push(...steered.parts);
      }
    }
    // Context-file write check (ink useGeminiStream parity): a slash command
    // flagged the turn with refreshContextFilesOnWrite; if this batch wrote a
    // context file (GEMINI.md/…), refresh the memory instruction before the
    // next model pass so the updated context is already in the system prompt.
    if (options?.refreshContextFilesOnWrite && completed.length > 0) {
      const candidates = completed.map((call) => ({
        toolName: call.request.name ?? '',
        args: call.request.args as Record<string, unknown> | undefined,
        status: call.status,
      }));
      if (didWriteProjectContextFile(candidates, config.getProjectRoot())) {
        await refreshMemoryInstruction(config, {
          logContext: 'opentui context-file memory tool batch',
        });
      }
    }
    if (responseParts.length === 0) return;
    nextPrompt = responseParts;
  }
}
