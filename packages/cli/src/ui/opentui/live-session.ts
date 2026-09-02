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
  compactToolResultDisplayForHistory,
  CoreToolScheduler,
  didWriteProjectContextFile,
  isShellProgressData,
  parseAndFormatApiError,
  refreshMemoryInstruction,
  SendMessageType,
  ToolNames,
} from '@qwen-code/qwen-code-core';
import type { Part, PartListUnion } from '@google/genai';
import {
  createEventMapper,
  extractFileDiff,
  renderResultDisplay,
  type OpenTuiStreamEvent,
} from './event-adapter.js';

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
   * before their results go back to the model). Returned texts are appended
   * after the functionResponse parts as genuine user content, exactly like
   * the original's drainSteerAtBoundary sampling-boundary drain. Skipped
   * when the turn is aborted (messages then stay queued).
   */
  drainSteering?: () => string[];
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
    getModelName: () => options?.modelOverride ?? config.getModel(),
    getMaxSessionTurns: () => config.getMaxSessionTurns(),
  });
  const abort = signal ?? new AbortController().signal;
  const dbg = process.env['QWEN_OPENTUI_DEBUG'];

  // The ink app drives tool EXECUTION via useReactToolScheduler: the client
  // only yields `tool_call_request` and ends the turn, then the UI schedules
  // the tool and submits the functionResponses to continue. Replicate that
  // loop here so tools actually run under OpenTUI (drain -> schedule ->
  // submit results -> drain again).
  let nextPrompt: PartListUnion = prompt;
  let first = true;
  const waitingSeen = new Set<string>();
  for (;;) {
    const sendOptions = first
      ? {
          type: SendMessageType.UserQuery,
          ...(options?.modelOverride
            ? { modelOverride: options.modelOverride }
            : {}),
          ...(options?.submittedPrompt
            ? { submittedPrompt: options.submittedPrompt }
            : {}),
        }
      : {
          type: SendMessageType.ToolResult,
          ...(options?.modelOverride
            ? { modelOverride: options.modelOverride }
            : {}),
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
      for (const text of options?.drainSteering?.() ?? []) {
        if (text) responseParts.push({ text });
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
