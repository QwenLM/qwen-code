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
  AnsiToken,
  ChatCompressionInfo,
  GoalStateCause,
  RetryInfo,
  ServerGeminiStreamEvent,
} from '@qwen-code/qwen-code-core';
import type { StreamEvent } from '../model/streaming-model.js';
import type { TodoItem } from '../components/TodoDisplay.js';
import type { CompressionProps } from '../types.js';
import { sanitizeSensitiveText } from '../utils/textUtils.js';
import { sanitizeDisplayText } from '../../utils/extension-mention.js';
import { shouldDisplayGoalStateCause } from '../utils/goal-runtime.js';

/**
 * Neutral-model union extension: tool detail events the backend folds into
 * tool cards (args preview, result content, approval state), plus turn
 * segmentation and inline images.
 */
export type OpenTuiStreamEvent =
  | StreamEvent
  | { type: 'tool-args'; id: string; args: string }
  /** Real invocation description (live sessions only): the scheduler's
   * tracked call carries the invocation object, so the card title is the
   * tool's own `getDescription()` (ink mapToDisplay parity) instead of a
   * hand-rolled args guess. Yields after `tool-start` once the scheduler
   * builds the invocation. */
  | { type: 'tool-description'; id: string; description: string }
  | {
      type: 'tool-result';
      id: string;
      display: string;
      /** Structured FileDiff payload: rendered as colored diff lines in the
       * tool card instead of the flattened `display` text (ink
       * DiffResultRenderer parity). */
      diff?: { fileDiff: string; fileName: string };
      /** Structured TodoWrite payload: rendered as a status-icon list in the
       * tool card (ink TodoDisplay parity) instead of the flattened text. */
      todos?: TodoItem[];
      /** Structured AnsiOutputDisplay payload: rendered as a styled token
       * grid in the tool card (ink AnsiOutputText parity) instead of the
       * flattened, color-stripped text. */
      ansi?: {
        grid: AnsiToken[][];
        totalLines?: number;
        totalBytes?: number;
      };
      /** Vision-bridge egress disclosure (ink ToolMessage renders the notice
       * under the result): tells the user their image/prompt left the
       * machine via the vision model. */
      visionBridgeNotice?: string;
    }
  | { type: 'confirm'; id: string; tool: string; title: string }
  /** Structured compression item (/compress command): rendered as the ink
   * CompressionMessage row (spinner/diamond + token counts) instead of the
   * flattened text projection. */
  | { type: 'compaction'; compression: CompressionProps }
  /** Info notice row (ink `addItem({type: INFO})` → InfoMessage): `●` prefix
   * + primary-colored text, e.g. the auto-compact `chat_compressed` notice. */
  | { type: 'info'; text: string }
  /** Error notice row (ink `type: 'error'` → ErrorMessage): `✕` prefix +
   * error-colored text with an optional inline hint. */
  | { type: 'error'; text: string; hint?: string }
  /** Warning block (ink user_prompt_submit_blocked): no prefix, whole block
   * in the warning color. */
  | { type: 'warning'; text: string }
  /** Retry countdown (ink startRetryCountdown): drives the two pending
   * rows — the retry error line and the `↻` countdown — updated every
   * second until the delay elapses. `message` mirrors RetryInfo.message;
   * `skipDelay` resolves the core delay promise early (Ctrl+Y, ink
   * skipRetryDelayRef); `isContinuation` keeps the failed attempt's
   * streamed content instead of discarding it (ink continuation retries). */
  | {
      type: 'retry-countdown';
      attempt: number;
      maxRetries: number;
      delayMs: number;
      message?: string;
      skipDelay?: () => void;
      isContinuation?: boolean;
    }
  /** Retry without retryInfo: the attempt is starting now, so any prior
   * retry UI is stale (ink clearRetryCountdown). `isContinuation` carries
   * the keep/discard signal core's continuation retries set without a
   * retryInfo, so the backend keeps already-streamed text like ink does. */
  | { type: 'retry-countdown-clear'; isContinuation?: boolean }
  /** Stop-hook system message (ink stop_hook_system_message):
   * `⎿ Stop says:` header + indented markdown body. */
  | { type: 'stop-hook-message'; message: string }
  /** Goal lifecycle card (ink goal_state → GoalStatusMessage/GoalStateCard):
   * carries the v2 snapshot + display cause. */
  | { type: 'goal'; snapshot: GoalSnapshotLike; cause?: string }
  /** Legacy goal card (ink goal_status → GoalStatusMessage kind form, the
   * /goal command path): carried structurally instead of the text
   * projection so the renderer can apply lifecycle colors. */
  | {
      type: 'goal-legacy';
      kind: string;
      condition: string;
      iterations?: number;
      durationMs?: number;
      lastReason?: string;
    }
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
  /** Active model name for the chat-compression notice (ink parity:
   * `modelOverrideRef.current ?? config.getModel()`). */
  getModelName?: () => string;
  /** Configured max session turns for the MaxSessionTurns notice. */
  getMaxSessionTurns?: () => number;
  /**
   * ink parity of the `showCitations(settings)` gate in
   * handleCitationEvent; absent means citations are shown.
   */
  showCitations?: () => boolean;
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

/** Extracts the structured TodoWrite payload (`type: 'todo_list'`). */
export function extractTodos(display: unknown): TodoItem[] | null {
  if (typeof display !== 'object' || display === null) return null;
  const o = display as Record<string, unknown>;
  if (o['type'] !== 'todo_list' || !Array.isArray(o['todos'])) return null;
  return (o['todos'] as unknown[]).filter(
    (t): t is TodoItem =>
      typeof t === 'object' &&
      t !== null &&
      typeof (t as TodoItem).id === 'string' &&
      typeof (t as TodoItem).content === 'string' &&
      typeof (t as TodoItem).status === 'string',
  );
}

/** Extracts the AnsiOutputDisplay token grid (live shell output). */
export function extractAnsiOutput(
  display: unknown,
): { grid: AnsiToken[][]; totalLines?: number; totalBytes?: number } | null {
  if (typeof display !== 'object' || display === null) return null;
  const o = display as Record<string, unknown>;
  if (!Array.isArray(o['ansiOutput'])) return null;
  const grid = (o['ansiOutput'] as unknown[])
    .filter((line): line is unknown[] => Array.isArray(line))
    .map((line) =>
      line.filter(
        (t): t is AnsiToken =>
          typeof t === 'object' &&
          t !== null &&
          typeof (t as AnsiToken).text === 'string',
      ),
    );
  const totalLines =
    typeof o['totalLines'] === 'number' ? o['totalLines'] : undefined;
  const totalBytes =
    typeof o['totalBytes'] === 'number' ? o['totalBytes'] : undefined;
  return { grid, totalLines, totalBytes };
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
    // Structured displays ink's classifyDisplay handles individually.
    if (o['type'] === 'plan_summary') {
      const message = typeof o['message'] === 'string' ? o['message'] : '';
      const plan = typeof o['plan'] === 'string' ? o['plan'] : '';
      return [message, plan].filter(Boolean).join('\n');
    }
    // team_result/task_list are covered by their tools' returnDisplay text;
    // ink renders nothing for the structured object (classifyDisplay none).
    if (o['type'] === 'team_result' || o['type'] === 'task_list') {
      return '';
    }
    if (o['type'] === 'mcp_tool_progress') {
      const msg =
        typeof o['message'] === 'string'
          ? o['message']
          : `Progress: ${o['progress']}`;
      const totalStr = o['total'] != null ? `/${o['total']}` : '';
      return `◌ [${o['progress']}${totalStr}] ${msg}`;
    }
    // mcp_app renders only its fallbackText in ink — the embedded HTML must
    // never reach output, including the (currently unreachable) case where
    // the field is absent: the JSON dump would expose the raw HTML.
    if (o['type'] === 'mcp_app') {
      return typeof o['fallbackText'] === 'string' ? o['fallbackText'] : '';
    }
    // vision_bridge_notice renders summary\nnotice (ink's
    // formatVisionBridgeNoticeDisplay); the generic summary branch below
    // would drop the notice body.
    if (o['type'] === 'vision_bridge_notice') {
      const summary = typeof o['summary'] === 'string' ? o['summary'] : '';
      const notice = typeof o['notice'] === 'string' ? o['notice'] : '';
      return [summary, notice].filter(Boolean).join('\n');
    }
    // task_execution: status line + termination reason and result — the raw
    // JSON fallback would dump toolCalls[].responseParts (multi-MB base64);
    // core strips those exact fields in toolResultDisplayCompaction.
    if (o['type'] === 'task_execution') {
      const subagent =
        typeof o['subagentName'] === 'string' ? o['subagentName'] : '';
      const status = typeof o['status'] === 'string' ? o['status'] : '';
      const reason =
        typeof o['terminateReason'] === 'string' ? o['terminateReason'] : '';
      const result = typeof o['result'] === 'string' ? o['result'] : '';
      const header = [subagent, status].filter(Boolean).join(': ');
      return [header, reason, result].filter(Boolean).join('\n');
    }
    // findings_list: count + optional severity summary; the raw fallback
    // dumps every finding object.
    if (o['type'] === 'findings_list') {
      const findings = Array.isArray(o['findings'])
        ? (o['findings'] as unknown[])
        : [];
      const level = typeof o['level'] === 'string' ? ` (${o['level']})` : '';
      const omitted =
        typeof o['omittedFindings'] === 'number' && o['omittedFindings'] > 0
          ? `\n${o['omittedFindings']} additional finding(s) were omitted.`
          : '';
      return `${findings.length} finding(s)${level}${omitted}`;
    }
    // terminal_image: file-path note instead of the multi-MB binary payload
    // (ink renders the image inline; transcripts keep the path reference).
    if (o['type'] === 'terminal_image') {
      const filePath = typeof o['filePath'] === 'string' ? o['filePath'] : '';
      return filePath ? `[terminal image] ${filePath}` : '';
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
 * the answer starts streaming.
 */
export function createEventMapper(
  context?: EventMapperContext,
): (ev: ServerGeminiStreamEvent) => OpenTuiStreamEvent[] {
  let sawThought = false;
  let thoughtClosed = false;
  let toolSeq = 0;

  return (ev: ServerGeminiStreamEvent): OpenTuiStreamEvent[] => {
    const out: OpenTuiStreamEvent[] = [];
    const closeThought = () => {
      if (sawThought && !thoughtClosed) {
        out.push({ type: 'thinking-end' });
        thoughtClosed = true;
      }
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
          visionBridgeNotice?: string;
        };
        // ink parity: the egress disclosure rides the tool card whenever a
        // response bridged images (ToolMessage renders it under the result).
        const visionBridgeNotice =
          typeof v.visionBridgeNotice === 'string' && v.visionBridgeNotice
            ? v.visionBridgeNotice
            : undefined;
        const diff = extractFileDiff(v.resultDisplay);
        if (diff) {
          out.push({
            type: 'tool-result',
            id: v.callId,
            display: '',
            diff,
            ...(visionBridgeNotice ? { visionBridgeNotice } : {}),
          });
        } else {
          const todos = extractTodos(v.resultDisplay);
          if (todos) {
            out.push({
              type: 'tool-result',
              id: v.callId,
              display: '',
              todos,
              ...(visionBridgeNotice ? { visionBridgeNotice } : {}),
            });
          } else {
            const ansi = extractAnsiOutput(v.resultDisplay);
            if (ansi) {
              out.push({
                type: 'tool-result',
                id: v.callId,
                display: '',
                ansi,
                ...(visionBridgeNotice ? { visionBridgeNotice } : {}),
              });
            } else {
              const display = renderResultDisplay(v.resultDisplay);
              if (display)
                out.push({
                  type: 'tool-result',
                  id: v.callId,
                  display,
                  ...(visionBridgeNotice ? { visionBridgeNotice } : {}),
                });
            }
          }
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
        // ink parity: handleUserCancelledEvent clears the retry countdown
        // (stale after the cancel) before adding the info notice.
        out.push({ type: 'retry-countdown-clear' });
        out.push({ type: 'info', text: 'User cancelled the request.' });
        break;
      }
      case 'error': {
        closeThought();
        // ink parity: handleErrorEvent clears the retry countdown
        // unconditionally before adding the pending error item.
        out.push({ type: 'retry-countdown-clear' });
        // ink parity: handleErrorEvent sets a pending error item rendered by
        // ErrorMessage (`✕` + error color) with the retry hint inline.
        const v = ev.value as { error?: unknown };
        const message = context?.formatError
          ? context.formatError(v.error)
          : String(
              (v.error as { message?: string } | undefined)?.message ?? '',
            );
        if (message)
          out.push({
            type: 'error',
            text: message,
            hint: 'Press Ctrl+Y to retry',
          });
        break;
      }
      case 'chat_compressed': {
        // ink parity: useGeminiStream's handleChatCompressionEvent adds a
        // `type: 'info'` history item (InfoMessage row) with this text; a
        // pending retry countdown is stale once the context is swapped.
        closeThought();
        out.push({ type: 'retry-countdown-clear' });
        const v = ev.value as ChatCompressionInfo | null;
        const model = context?.getModelName?.() ?? 'the model';
        const reasonClause =
          v?.triggerReason === 'image_overflow'
            ? `accumulated enough tool screenshots to trigger compaction for ${model}`
            : `approached the input token limit for ${model}`;
        // ink's formatCount (useGeminiStream): estimated counts carry a '~'
        // prefix so locally-measured figures don't read as API-reported ones.
        const formatCount = (count?: number, isEstimated?: boolean) =>
          count === undefined
            ? 'unknown'
            : isEstimated
              ? `~${count}`
              : String(count);
        const warningSuffix = v?.warning ? `\n⚠️ ${v.warning}` : '';
        out.push({
          type: 'info',
          text:
            `IMPORTANT: This conversation ${reasonClause}. ` +
            `A compressed context will be sent for future messages (compressed from: ` +
            `${formatCount(v?.originalTokenCount, v?.originalTokenCountIsEstimated)} to ` +
            `${formatCount(v?.newTokenCount, v?.newTokenCountIsEstimated)} tokens).` +
            warningSuffix,
        });
        break;
      }
      case 'max_session_turns': {
        closeThought();
        // ink parity: handleMaxSessionTurnsEvent adds `{type: 'info'}`.
        const turns = context?.getMaxSessionTurns?.();
        out.push({
          type: 'info',
          text:
            `The session has reached the maximum number of turns: ` +
            `${turns ?? 'the configured limit'}. ` +
            `Please update this limit in your setting.json file.`,
        });
        break;
      }
      case 'session_token_limit_exceeded': {
        closeThought();
        // ink parity: handleSessionTokenLimitExceededEvent adds `{type:
        // 'error'}` with a `✗` glyph in the text.
        const v = ev.value as { currentTokens: number; limit: number };
        out.push({
          type: 'error',
          text:
            `✗ Session token limit exceeded: ` +
            `${v.currentTokens.toLocaleString()} tokens > ` +
            `${v.limit.toLocaleString()} limit.\n\n` +
            `★ Solutions:\n` +
            `   • Start a new session: Use /clear command\n` +
            `   • Increase limit: Add "sessionTokenLimit": (e.g., 128000) to your settings.json\n` +
            `   • Compress history: Use /compress command to compress history`,
        });
        break;
      }
      case 'loop_detected': {
        closeThought();
        // ink shows a disable/keep confirmation dialog; until that dialog
        // exists here, surface the halt itself (the dialog's "keep" outcome,
        // which ink adds as `{type: 'info'}`).
        out.push({
          type: 'info',
          text:
            'A potential loop was detected. This can happen due to repetitive ' +
            'tool calls or other model behavior. The request has been halted.',
        });
        break;
      }
      case 'citation': {
        closeThought();
        // ink parity: handleCitationEvent adds `{type: 'info'}` (the core
        // already builds the display string) but early-returns when the
        // user disabled `ui.showCitations`.
        if (context?.showCitations && !context.showCitations()) break;
        const text = ev.value as string;
        if (text) out.push({ type: 'info', text });
        break;
      }
      case 'retry': {
        closeThought();
        // ink parity: retryInfo → startRetryCountdown (restarts the two
        // pending rows every second); no retryInfo → clearRetryCountdown
        // (the attempt is starting now, so any prior retry UI is stale).
        const info = (ev as { retryInfo?: RetryInfo }).retryInfo;
        if (info) {
          out.push({
            type: 'retry-countdown',
            attempt: info.attempt,
            maxRetries: info.maxRetries,
            delayMs: info.delayMs,
            message: info.message,
            skipDelay: info.skipDelay,
            isContinuation: (ev as { isContinuation?: boolean }).isContinuation,
          });
        } else {
          out.push({
            type: 'retry-countdown-clear',
            isContinuation: (ev as { isContinuation?: boolean }).isContinuation,
          });
        }
        break;
      }
      case 'model_fallback': {
        closeThought();
        // ink parity: the model_fallback branch clears the retry countdown
        // (the retry chain died with the primary model) before the notice.
        out.push({ type: 'retry-countdown-clear' });
        const v = ev as { fromModel?: string; toModel?: string };
        // ink parity: model names pass through sanitizeDisplayText before
        // reaching the notice (useGeminiStream).
        const fromModel = sanitizeDisplayText(v.fromModel ?? '') ?? '(unknown)';
        const toModel = sanitizeDisplayText(v.toModel ?? '') ?? '(unknown)';
        out.push({
          type: 'info',
          text: `Model ${fromModel} unavailable, falling back to ${toModel}`,
        });
        break;
      }
      case 'hook_system_message': {
        closeThought();
        // ink parity: stop_hook_system_message renders `⎿ Stop says:` +
        // an indented markdown body.
        out.push({ type: 'stop-hook-message', message: ev.value as string });
        break;
      }
      case 'user_prompt_submit_blocked': {
        closeThought();
        const v = ev.value as { reason: string; originalPrompt: string };
        out.push({
          type: 'warning',
          text:
            `✕ UserPromptSubmit operation blocked by hook:\n${v.reason}\n\n` +
            // ink redacts the echoed prompt (HistoryItemDisplay): sensitive
            // patterns masked and the text capped at 200 chars.
            `Original prompt: ${sanitizeSensitiveText(v.originalPrompt)}`,
        });
        break;
      }
      case 'stop_hook_loop': {
        closeThought();
        // ink parity: the stop_hook_loop item renders via InfoMessage.
        const v = ev.value as {
          reasons: string[];
          stopHookCount: number;
        };
        out.push({
          type: 'info',
          text:
            `Ran ${v.stopHookCount} stop hooks\n` +
            `  ⎿  Stop hook error: ${v.reasons[v.reasons.length - 1] ?? ''}`,
        });
        break;
      }
      case 'active_goal':
        // ink parity: useGeminiStream ignores this legacy projection event.
        break;
      case 'goal_state': {
        closeThought();
        const v = ev as {
          value: GoalSnapshotLike;
          cause?: string;
        };
        // ink gates on `event.cause && shouldDisplayGoalStateCause(cause)`;
        // the shared predicate keeps the exhaustive-switch guard.
        const cause = v.cause;
        if (!cause || !shouldDisplayGoalStateCause(cause as GoalStateCause)) {
          break;
        }
        // ink parity: addItem({type: 'goal_state', snapshot, cause}) renders
        // via GoalStatusMessage (GoalStateCard).
        out.push({ type: 'goal', snapshot: v.value, cause });
        break;
      }
      case 'finished': {
        closeThought();
        // ink parity: handleFinishedEvent adds `{type: 'info'}` for
        // non-STOP finish reasons.
        const reason = (ev.value as { reason?: string } | undefined)?.reason;
        const message = reason ? FINISH_REASON_NOTICES[reason] : undefined;
        if (message) out.push({ type: 'info', text: `⚠  ${message}` });
        // ink parity: handleFinishedEvent clears an active auto-retry
        // countdown — a terminal event inside the countdown window must not
        // leave a stale ↻ row. The backend treats a redundant clear as a
        // no-op when no countdown is running.
        out.push({ type: 'retry-countdown-clear' });
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
export type GoalSnapshotLike = {
  goal?: {
    objective?: string;
    status?: string;
    turnCount?: number;
    activeTimeMs?: number;
    lastReason?: string;
  } | null;
  activity?: string;
};

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
