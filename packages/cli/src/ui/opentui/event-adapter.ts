/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * P1d integration seam: maps qwen-code's real agent-loop stream events
 * (`ServerGeminiStreamEvent`, packages/core) onto the framework-neutral
 * `StreamEvent` consumed by the OpenTUI backend / `ui/model/streaming-model`.
 *
 * Pure + framework-agnostic (no UI-framework imports); unit-testable without
 * a renderer. The OpenTUI backend drains these into the neutral model; the
 * ink path keeps using `useGeminiStream` unchanged.
 *
 * Lossless tool mapping: tool args, result content (resultDisplay) and
 * confirmation requests are carried through as the `tool-args` / `tool-result`
 * / `confirm` events (the neutral model's union is extended locally because
 * this slice may only touch opentui/**).
 */

import type {
  ChatCompressionInfo,
  RetryInfo,
  ServerGeminiStreamEvent,
} from '@qwen-code/qwen-code-core';
import type { StreamEvent } from '../model/streaming-model.js';

/**
 * Neutral-model union extension: tool detail events the backend folds into
 * tool cards (args preview, result content, approval state), plus turn
 * segmentation and inline images.
 */
export type OpenTuiStreamEvent =
  | StreamEvent
  | { type: 'tool-args'; id: string; args: string }
  | {
      type: 'tool-result';
      id: string;
      display: string;
      /** Structured FileDiff payload: rendered as colored diff lines in the
       * tool card instead of the flattened `display` text (ink
       * DiffResultRenderer parity). */
      diff?: { fileDiff: string; fileName: string };
    }
  | { type: 'confirm'; id: string; tool: string; title: string }
  /**
   * Turn segmentation marker (core `finished` / one-shot notices): closes
   * the streaming assistant block WITHOUT settling tool cards or dropping
   * the streaming state. `done` remains the only turn-end event.
   */
  | { type: 'segment-end' }
  /** Inline image from model content (`inlineData` part). */
  | { type: 'image'; mimeType: string; data: string };

/**
 * Optional runtime context for notices that need config-derived values.
 * All fields are optional so the mapper stays usable without a Config
 * (scripted streams, tests).
 */
export interface EventMapperContext {
  /**
   * Formats an `error` event payload for display (ink parity:
   * parseAndFormatApiError + auth-type hints). Falls back to the raw
   * error message when absent.
   */
  formatError?: (error: unknown) => string;
  /** Active model name for the chat-compression notice. */
  getModelName?: () => string;
  /** Configured max session turns for the MaxSessionTurns notice. */
  getMaxSessionTurns?: () => number;
}

/** One-line compact JSON for tool-call args (empty object → undefined). */
export function formatToolArgs(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args || Object.keys(args).length === 0) return undefined;
  return JSON.stringify(args);
}

/** Narrows a ToolResultDisplay to its FileDiff shape, if it is one. */
export function extractFileDiff(
  display: unknown,
): { fileDiff: string; fileName: string } | null {
  if (typeof display !== 'object' || display === null) return null;
  const o = display as Record<string, unknown>;
  if (typeof o['fileDiff'] !== 'string') return null;
  return {
    fileDiff: o['fileDiff'],
    fileName: typeof o['fileName'] === 'string' ? o['fileName'] : '',
  };
}

/** Stringifies a ToolResultDisplay (string | FileDiff | structured) losslessly. */
export function renderResultDisplay(display: unknown): string {
  if (display == null) return '';
  if (typeof display === 'string') return display;
  if (typeof display === 'object') {
    const o = display as Record<string, unknown>;
    if (typeof o['fileDiff'] === 'string') {
      const name =
        typeof o['fileName'] === 'string' && o['fileName']
          ? `${o['fileName']}\n`
          : '';
      return name + o['fileDiff'];
    }
    // AnsiOutputDisplay (live shell output): flatten the token grid to text.
    if (Array.isArray(o['ansiOutput'])) {
      return (o['ansiOutput'] as Array<Array<{ text?: string }>>)
        .map((line) => line.map((t) => t.text ?? '').join(''))
        .join('\n');
    }
    if (typeof o['summary'] === 'string') return o['summary'];
    if (typeof o['message'] === 'string') return o['message'];
  }
  return JSON.stringify(display, null, 2);
}

/**
 * Non-STOP finish reasons → user-facing notice (ink useGeminiStream
 * handleFinishedEvent parity; FINISH_REASON_UNSPECIFIED and STOP are
 * silent).
 */
const FINISH_REASON_NOTICES: Record<string, string | undefined> = {
  MAX_TOKENS: 'Response truncated due to token limits.',
  SAFETY: 'Response stopped due to safety reasons.',
  RECITATION: 'Response stopped due to recitation policy.',
  LANGUAGE: 'Response stopped due to unsupported language.',
  BLOCKLIST: 'Response stopped due to forbidden terms.',
  PROHIBITED_CONTENT: 'Response stopped due to prohibited content.',
  SPII: 'Response stopped due to sensitive personally identifiable information.',
  OTHER: 'Response stopped for other reasons.',
  MALFORMED_FUNCTION_CALL: 'Response stopped due to malformed function call.',
  IMAGE_SAFETY: 'Response stopped due to image safety violations.',
  IMAGE_PROHIBITED_CONTENT: 'Response stopped due to image prohibited content.',
  IMAGE_RECITATION: 'Response stopped due to image recitation policy.',
  IMAGE_OTHER: 'Response stopped due to other image-related reasons.',
  NO_IMAGE: 'Response stopped due to no image.',
  UNEXPECTED_TOOL_CALL: 'Response stopped due to unexpected tool call.',
};

/**
 * Stateful mapper: one server event may yield 0..n neutral events. Tracks the
 * thinking→content transition so the model collapses the thought block before
 * the answer starts streaming, and the last rendered goal text so repeated
 * goal snapshots do not spam identical lines.
 */
export function createEventMapper(
  context?: EventMapperContext,
): (ev: ServerGeminiStreamEvent) => OpenTuiStreamEvent[] {
  let sawThought = false;
  let thoughtClosed = false;
  let toolSeq = 0;
  let lastGoalText: string | null = null;

  return (ev: ServerGeminiStreamEvent): OpenTuiStreamEvent[] => {
    const out: OpenTuiStreamEvent[] = [];
    const closeThought = () => {
      if (sawThought && !thoughtClosed) {
        out.push({ type: 'thinking-end' });
        thoughtClosed = true;
      }
    };
    // One-shot notices get their own assistant block: close the streaming
    // one first (fold `segment-end`), then emit the text.
    const notice = (text: string) => {
      out.push({ type: 'segment-end' });
      out.push({ type: 'text', delta: text });
    };
    const goalNotice = (text: string | null) => {
      if (!text || text === lastGoalText) return;
      lastGoalText = text;
      notice(text);
    };

    switch (ev.type) {
      case 'thought': {
        const v = ev.value as { subject?: string; description?: string };
        const delta = v.description ?? '';
        if (delta) {
          sawThought = true;
          thoughtClosed = false;
          out.push({ type: 'thinking', delta });
        }
        break;
      }
      case 'content': {
        closeThought();
        const parts = (
          ev as {
            parts?: Array<{
              text?: string;
              inlineData?: { data?: string; mimeType?: string };
            }>;
          }
        ).parts;
        if (parts) {
          for (const p of parts) {
            if (p.text && p.text.length > 0) {
              out.push({ type: 'text', delta: p.text });
            } else if (p.inlineData?.data) {
              out.push({
                type: 'image',
                mimeType: p.inlineData.mimeType ?? 'image/png',
                data: p.inlineData.data,
              });
            }
          }
        } else {
          const value = ev.value as string;
          if (value) out.push({ type: 'text', delta: value });
        }
        break;
      }
      case 'tool_call_request': {
        closeThought();
        const v = ev.value as {
          callId: string;
          name: string;
          args?: Record<string, unknown>;
        };
        const id = v.callId ?? `tool-${++toolSeq}`;
        out.push({ type: 'tool-start', id, tool: v.name, title: v.name });
        const args = formatToolArgs(v.args);
        if (args) out.push({ type: 'tool-args', id, args });
        break;
      }
      case 'tool_call_confirmation': {
        closeThought();
        const v = ev.value as {
          request: {
            callId: string;
            name: string;
            args?: Record<string, unknown>;
          };
          details: { title?: string };
        };
        const id = v.request.callId ?? `tool-${++toolSeq}`;
        out.push({
          type: 'confirm',
          id,
          tool: v.request.name,
          title: v.details.title ?? v.request.name,
        });
        const args = formatToolArgs(v.request.args);
        if (args) out.push({ type: 'tool-args', id, args });
        break;
      }
      case 'tool_call_response': {
        const v = ev.value as {
          callId: string;
          error?: unknown;
          resultDisplay?: unknown;
          executionStatus?: string;
        };
        const diff = extractFileDiff(v.resultDisplay);
        if (diff) {
          out.push({ type: 'tool-result', id: v.callId, display: '', diff });
        } else {
          const display = renderResultDisplay(v.resultDisplay);
          if (display) out.push({ type: 'tool-result', id: v.callId, display });
        }
        const cancelled = v.executionStatus === 'cancelled';
        const failed = v.error !== undefined || v.executionStatus === 'error';
        out.push({
          type: 'tool-end',
          id: v.callId,
          success: !failed && !cancelled,
          summary: failed ? 'error' : cancelled ? 'cancelled' : 'ok',
        });
        break;
      }
      case 'user_cancelled': {
        closeThought();
        notice('User cancelled the request.');
        break;
      }
      case 'error': {
        closeThought();
        const v = ev.value as { error?: unknown };
        const message = context?.formatError
          ? context.formatError(v.error)
          : String(
              (v.error as { message?: string } | undefined)?.message ?? '',
            );
        notice(`[error] ${message}`);
        break;
      }
      case 'chat_compressed': {
        closeThought();
        const v = ev.value as ChatCompressionInfo | null;
        const model = context?.getModelName?.() ?? 'the model';
        const reasonClause =
          v?.triggerReason === 'image_overflow'
            ? `accumulated enough tool screenshots to trigger compaction for ${model}`
            : `approached the input token limit for ${model}`;
        const warningSuffix = v?.warning ? `\n⚠️ ${v.warning}` : '';
        notice(
          `IMPORTANT: This conversation ${reasonClause}. ` +
            `A compressed context will be sent for future messages (compressed from: ` +
            `${v?.originalTokenCount ?? 'unknown'} to ` +
            `${v?.newTokenCount ?? 'unknown'} tokens).` +
            warningSuffix,
        );
        break;
      }
      case 'max_session_turns': {
        closeThought();
        const turns = context?.getMaxSessionTurns?.();
        notice(
          `The session has reached the maximum number of turns: ` +
            `${turns ?? 'the configured limit'}. ` +
            `Please update this limit in your setting.json file.`,
        );
        break;
      }
      case 'session_token_limit_exceeded': {
        closeThought();
        const v = ev.value as { currentTokens: number; limit: number };
        notice(
          `[error] Session token limit exceeded: ` +
            `${v.currentTokens.toLocaleString()} tokens > ` +
            `${v.limit.toLocaleString()} limit.\n\n` +
            `★ Solutions:\n` +
            `   • Start a new session: Use /clear command\n` +
            `   • Increase limit: Add "sessionTokenLimit": (e.g., 128000) to your settings.json\n` +
            `   • Compress history: Use /compress command to compress history`,
        );
        break;
      }
      case 'loop_detected': {
        closeThought();
        // ink shows a disable/keep confirmation dialog; until that dialog
        // exists here, surface the halt itself (the dialog's "keep" outcome).
        notice(
          'A potential loop was detected. This can happen due to repetitive ' +
            'tool calls or other model behavior. The request has been halted.',
        );
        break;
      }
      case 'citation': {
        closeThought();
        // No dedicated citation surface yet — render the preformatted
        // citation text (the core already builds the display string).
        const text = ev.value as string;
        if (text) notice(text);
        break;
      }
      case 'retry': {
        closeThought();
        // No countdown UI: emit the retry info as plain text (ink
        // startRetryCountdown wording). Without retryInfo ink shows
        // nothing either.
        const info = (ev as { retryInfo?: RetryInfo }).retryInfo;
        if (info) {
          const seconds = Math.max(1, Math.ceil(info.delayMs / 1000));
          notice(
            `Retrying in ${seconds}s… (attempt ${info.attempt}/${info.maxRetries})`,
          );
        }
        break;
      }
      case 'model_fallback': {
        closeThought();
        const v = ev as { fromModel?: string; toModel?: string };
        notice(
          `Model ${v.fromModel ?? '(unknown)'} unavailable, ` +
            `falling back to ${v.toModel ?? '(unknown)'}`,
        );
        break;
      }
      case 'hook_system_message': {
        closeThought();
        notice(`Stop says: ${ev.value as string}`);
        break;
      }
      case 'user_prompt_submit_blocked': {
        closeThought();
        const v = ev.value as { reason: string; originalPrompt: string };
        notice(
          `✕ UserPromptSubmit operation blocked by hook:\n${v.reason}\n\n` +
            `Original prompt: ${v.originalPrompt}`,
        );
        break;
      }
      case 'stop_hook_loop': {
        closeThought();
        const v = ev.value as {
          reasons: string[];
          stopHookCount: number;
        };
        notice(
          `Ran ${v.stopHookCount} stop hooks\n` +
            `  ⎿  Stop hook error: ${v.reasons[v.reasons.length - 1] ?? ''}`,
        );
        break;
      }
      case 'active_goal': {
        closeThought();
        // Legacy goal runtime shape ({condition, iterations}); ink ignores
        // this event, but deduped text keeps the opentui user informed.
        const g = ev.value as {
          condition?: string;
          iterations?: number;
        } | null;
        if (!g) break;
        const turns = g.iterations ?? 0;
        goalNotice(
          `Goal active${turns > 0 ? ` · ${turns} ${turns === 1 ? 'turn' : 'turns'}` : ''}\n` +
            `Goal: ${g.condition ?? ''}`,
        );
        break;
      }
      case 'goal_state': {
        closeThought();
        const v = ev as {
          value: GoalSnapshotLike;
          cause?: string;
        };
        // ink gates on shouldDisplayGoalStateCause (turn_finished /
        // checkpoint / verifier_accept stay silent).
        if (
          v.cause &&
          ['turn_finished', 'checkpoint', 'verifier_accept'].includes(v.cause)
        ) {
          break;
        }
        goalNotice(goalText(v.value ?? null, v.cause));
        break;
      }
      case 'finished': {
        closeThought();
        const reason = (ev.value as { reason?: string } | undefined)?.reason;
        const message = reason ? FINISH_REASON_NOTICES[reason] : undefined;
        if (message) notice(`⚠  ${message}`);
        // Segment marker only — the turn settles when the live generator
        // returns (backend emits `done`), NOT here: `finished` arrives
        // before tool execution, so mapping it to `done` flashed a fake
        // "✗ skipped" on every running tool card.
        out.push({ type: 'segment-end' });
        break;
      }
      default:
        break;
    }
    return out;
  };
}

/** Loose GoalSnapshotV2 shape (goal-protocol.ts) for display purposes. */
type GoalSnapshotLike = {
  goal?: {
    objective?: string;
    status?: string;
    turnCount?: number;
    lastReason?: string;
  } | null;
  activity?: string;
};

/**
 * Goal snapshot / active-goal → one status text line (ink GoalStatusMessage
 * parity, simplified to plain text). Returns null when there is nothing to
 * show (no goal and not an explicit clear).
 */
function goalText(
  snapshot: GoalSnapshotLike | null | undefined,
  cause?: string,
): string | null {
  const goal = snapshot?.goal ?? null;
  if (!goal) return cause === 'clear' ? 'Goal cleared' : null;
  const status = goal.status ?? 'active';
  const title =
    status === 'active'
      ? snapshot?.activity === 'verifying'
        ? 'Goal checking'
        : snapshot?.activity === 'running'
          ? 'Goal running'
          : 'Goal active'
      : status === 'paused'
        ? 'Goal paused'
        : status === 'blocked'
          ? 'Goal blocked'
          : status === 'usage_limited'
            ? 'Goal usage limited'
            : status === 'complete'
              ? 'Goal complete'
              : 'Goal';
  const turns = goal.turnCount ?? 0;
  const subtitle =
    turns > 0 ? ` · ${turns} ${turns === 1 ? 'turn' : 'turns'}` : '';
  const reason =
    status !== 'active' && goal.lastReason?.trim()
      ? `\nReason: ${goal.lastReason.trim()}`
      : '';
  return `${title}${subtitle}\nGoal: ${goal.objective ?? ''}${reason}`;
}

/** Drains a real agent stream into a neutral-event sink. */
export async function pumpServerStream(
  stream: AsyncIterable<ServerGeminiStreamEvent>,
  sink: (ev: OpenTuiStreamEvent) => void,
): Promise<void> {
  const map = createEventMapper();
  for await (const ev of stream) {
    for (const neutral of map(ev)) sink(neutral);
  }
}
