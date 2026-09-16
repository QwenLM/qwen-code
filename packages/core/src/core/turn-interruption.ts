/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { isSystemReminderContent } from './environmentContext.js';

/**
 * Classification of how a session's last turn ended, computed from persisted
 * chat history alone (no in-memory request refs), so it works across process
 * restarts — unlike the Ctrl+Y retry path, which depends on
 * `lastPromptRef` surviving in the same process.
 *
 * The history tail determines the classification:
 *  - `interrupted_prompt`: the tail is one or more non-structural `user`
 *    entries — a prompt (or a tool_result submission) whose model response
 *    never landed. Continuing means re-submitting their `parts` with Retry
 *    semantics: the send path strips the orphaned trailing user entries and
 *    re-pushes the same content under the same logical turn, so the transcript
 *    gains no new user message.
 *  - `interrupted_turn`: the tail is a `model` entry carrying `functionCall`s
 *    that no `functionResponse` ever answered (crash/abort mid tool run).
 *    Continuing means closing each pair with a synthesized error
 *    `functionResponse` submitted as a ToolResult — a legal continuation
 *    signal that needs no synthetic user text.
 *  - `none`: the turn ended cleanly (model text tail), the tail is a
 *    structural pure system-reminder entry (strip refuses to pop those, so a
 *    Retry would duplicate content), the tail is only system-injected
 *    background notifications (recorded before their automatic turn ran, so
 *    nothing owes them a response), or history is empty.
 *
 * A model text tail that was truncated mid-stream is indistinguishable from
 * a clean finish without persisted stop_reason metadata, so it classifies as
 * `none` here; recovering that case needs provider prefill support and is
 * tracked separately.
 */
export type TurnInterruption =
  | { kind: 'none' }
  | { kind: 'interrupted_prompt'; parts: Part[] }
  | {
      kind: 'interrupted_turn';
      danglingCalls: Array<{ callId: string; name: string }>;
    };

// Continue detection only walks the final run of trailing user/model entries.
// A bounded tail avoids deep-cloning long daemon histories for each probe while
// still leaving ample room for repeated failed sends and tool-result retries.
export const TURN_INTERRUPTION_HISTORY_TAIL_COUNT = 50;

export function completedToolCallBoundary(
  history: readonly Content[],
  toolCallIds: readonly string[] | undefined,
): number {
  if (!toolCallIds?.length) return 0;
  const ids = new Set(toolCallIds);
  const boundaries = new Map<string, number>();
  for (let i = 0; i < history.length; i++) {
    for (const part of history[i].parts ?? []) {
      const id = part.functionResponse?.id;
      if (!id || !ids.has(id)) continue;
      boundaries.set(
        id,
        boundaries.has(id) || history[i].role !== 'user' ? 0 : i + 1,
      );
    }
  }
  return Math.max(0, ...boundaries.values());
}

// Envelope the background registries wrap a notification's `modelText` in.
// Seven construction sites in six modules: `packages/cli/src/serve/create-sub-session.ts`,
// `packages/core/src/services/monitorRegistry.ts` (two),
// `packages/core/src/services/backgroundShellRegistry.ts`,
// `packages/core/src/agents/background-tasks.ts`,
// `packages/core/src/agents/workflow-run-registry.ts`, and
// `packages/core/src/agents/background-notification-queue.ts`.
//
// Most emitters escape their interpolated values with `escapeXml`, and monitor
// output additionally defangs these tag names (`sanitizeMonitorLine`), so a
// verbatim close tag inside those payloads can only come from the emitter —
// the same trust model `isSystemReminderContent` relies on for
// `<system-reminder>`. The escaping is not uniform, though
// (`background-notification-queue.ts` interpolates its status and summary
// raw), and model output is never defanged at all, so the envelope shape alone
// cannot prove provenance. The predicate below therefore gates on the role
// that does carry it: every real notification record is user-role.
const TASK_NOTIFICATION_OPEN = '<task-notification>';
const TASK_NOTIFICATION_CLOSE = '</task-notification>';

function isWrappedIn(part: Part, open: string, close: string): boolean {
  const text = part.text;
  return (
    typeof text === 'string' &&
    text.startsWith(open) &&
    text.trimEnd().endsWith(close)
  );
}

/**
 * Whether `content` is a system-injected background notification rather than
 * user input: the entry is user-role and EVERY part is a `<task-notification>`
 * envelope.
 *
 * The role check is the provenance signal, and it has to come first: the
 * envelope shape is not defanged against model output (see the trust-model
 * note above), so a MODEL entry whose whole text is a bare envelope — the user
 * asked the model to echo a notification verbatim, or injected tool/web
 * content steered the reply into ending with one — would otherwise be trimmed
 * away. That exposes the prompt the model *did* answer as the tail and returns
 * `interrupted_prompt` for a session that ended cleanly, re-introducing the
 * exact false banner this trim exists to remove. Requiring user-role cannot
 * drop a real notification: `createNotificationRecord`
 * (`packages/core/src/services/chatRecordingService.ts`) builds every one from
 * `createBaseRecord('user')`.
 *
 * The "every part" requirement is what keeps a real prompt out, and it is
 * deliberately NOT relaxed for `<system-reminder>` parts: per-turn reminders
 * ride alongside the prompt text in the SAME `user` entry, and a mid-turn
 * drain can merge background parts into a genuine user message — both have a
 * non-structural part, so neither matches. A DELIVERED notification turn
 * (`[...systemReminders, ...notificationParts]` as one entry) is therefore
 * left in place on purpose. Only the cold projection this trim exists for is
 * single-part (`recordNotification([{ text: item.modelText }], …)` →
 * `createNotificationRecord` → `createUserContent`; a co-recorded
 * `droppedSummary` is a separate record, so adjacent cold entries each trim
 * individually). Allowing reminders would also trim a notification turn that
 * was admitted, ran and then failed mid-stream — no `functionCall` delivered,
 * so no model entry was pushed and that user entry is the tail with nothing in
 * flight — certifying `clean` for the textbook `interrupted_prompt` documented
 * above and leaving it with no re-drive at all. The in-flight window the
 * reminder allowance was meant to cover is refused independently by the
 * `#hasActiveTurn()` guard in `Session.getRecoveryStatus()`.
 *
 * Residual, by shape alone: a FAILED live notification turn whose entry
 * carries no reminders (no plan mode, no output style, no active todo chain)
 * is a single-envelope user entry, indistinguishable from a cold record, and
 * is still trimmed. Closing that needs `provenance` to survive the projection
 * (`session-api-history.ts`) or a daemon-side re-drive; no shape predicate at
 * this layer can reach it.
 *
 * Needed at all because the record's `subtype: 'notification'` and
 * `provenance: 'system'` do not survive the projection into `Content`
 * (`session-api-history.ts`), so the live history tail carries no metadata to
 * read.
 */
function isSystemNotificationContent(content: Content): boolean {
  if (content.role !== 'user') return false;
  const parts = content.parts;
  if (!parts || parts.length === 0) return false;
  return parts.every((part) =>
    isWrappedIn(part, TASK_NOTIFICATION_OPEN, TASK_NOTIFICATION_CLOSE),
  );
}

/**
 * Index just past the last entry {@link detectTurnInterruption} classifies
 * against: `history.length` minus any trailing system-injected background
 * notifications.
 *
 * Exported so a caller that applies its own guard to the same tail can trim it
 * identically instead of re-deriving the rule. Without that, a trailing
 * notification hides the model entry from the caller's guard while the trim
 * hides the notification from detection, and both miss at once — see
 * `tailHoldsAnyFunctionCall` in `packages/cli/src/serve/prompt-terminal-ledger.ts`.
 *
 * @param history - Chat history in Gemini `Content[]` form, oldest first.
 * @returns The exclusive end index of the classifiable prefix.
 */
export function effectiveHistoryEnd(history: readonly Content[]): number {
  let end = history.length;
  while (end > 0 && isSystemNotificationContent(history[end - 1]!)) end--;
  return end;
}

/**
 * Detect whether the last turn of `history` was left unfinished, and if so
 * what kind of continuation applies. Pure read — never mutates `history`.
 *
 * Callers should pass enough tail entries to include all consecutive trailing
 * user entries. Accepting the full array keeps the function composable with
 * raw transcript fixtures in tests.
 *
 * @param history - Chat history in Gemini `Content[]` form, oldest first.
 * @returns The interruption classification; see {@link TurnInterruption}.
 */
export function detectTurnInterruption(
  history: Content[],
  completedToolCallIds?: readonly string[],
): TurnInterruption {
  const boundary = completedToolCallBoundary(history, completedToolCallIds);
  // Trailing background notifications are not an unfinished turn: the daemon
  // persists each one before its automatic turn runs, so a notification whose
  // turn never ran leaves a `user` tail that nothing will ever answer. Left in
  // place it classifies as `interrupted_prompt`, which keeps the recovery
  // banner pinned on a session whose last real turn ended cleanly.
  const end = effectiveHistoryEnd(history);
  if (boundary >= end) return { kind: 'none' };
  const last = history[end - 1];
  if (!last) {
    return { kind: 'none' };
  }

  if (last.role === 'user') {
    const trailingUserEntries: Content[] = [];
    // Walk from the REAL end, not the trimmed one, while the verdict above
    // still reads `history[end - 1]`. The Retry send path
    // (`stripOrphanedUserEntriesFromHistory`) pops the ENTIRE trailing user
    // run — its only break-guard is `isSystemReminderContent`, which is false
    // for an envelope — so the re-submission has to carry every entry the
    // strip removes. Collecting from `end - 1` instead would drop a
    // recorded-but-undelivered notification from live history permanently:
    // `enqueueBackgroundNotification` short-circuits on
    // `persistedBackgroundNotificationTaskIds`, which `collectSessionTurnState`
    // primes from the transcript itself, so nothing re-delivers it.
    for (let i = history.length - 1; i >= boundary; i--) {
      const entry = history[i];
      if (!entry || entry.role !== 'user') {
        break;
      }
      // Structural reminder entries are not orphaned turns; the strip pass
      // refuses to pop them, so re-submitting would duplicate the prompt.
      if (isSystemReminderContent(entry)) {
        break;
      }
      trailingUserEntries.unshift(entry);
    }
    // Capture every part, including any per-turn system-reminder parts riding
    // alongside the prompt. The Retry send path does not re-inject per-turn
    // reminders, so replaying them keeps the continued turn complete. When a
    // continuation includes tool results, keep functionResponse parts first:
    // Anthropic-compatible backends require tool_result blocks before text.
    const allParts = trailingUserEntries.flatMap((entry) => entry.parts ?? []);
    const parts = [
      ...allParts.filter((part) => part.functionResponse),
      ...allParts.filter((part) => !part.functionResponse),
    ];
    if (parts.length === 0) {
      return { kind: 'none' };
    }
    // Public helper boundary: callers may pass raw history, so return detached
    // parts even when current continuation callers only read them.
    return { kind: 'interrupted_prompt', parts: structuredClone(parts) };
  }

  if (last.role === 'model') {
    // Nothing follows the final entry, so every id'd functionCall in it is
    // by definition unanswered. Calls without an id can't be paired on the
    // wire at all — the repair pass skips them too — so they're ignored.
    const danglingCalls: Array<{ callId: string; name: string }> = [];
    for (const part of last.parts ?? []) {
      const fc = part.functionCall;
      if (fc?.id) {
        danglingCalls.push({ callId: fc.id, name: fc.name ?? 'unknown' });
      }
    }
    if (danglingCalls.length > 0) {
      return { kind: 'interrupted_turn', danglingCalls };
    }
  }

  return { kind: 'none' };
}

/**
 * Build the error `functionResponse` parts that close the dangling
 * `functionCall`s of an `interrupted_turn`. Shape matches the repair pass's
 * synthesized responses (`applyRepair` in llm-chat.ts) so downstream
 * dedup and telemetry treat both identically.
 *
 * @param danglingCalls - The unanswered calls from {@link detectTurnInterruption}.
 * @param reason - Error text placed in each response; callers pass
 *   `ORPHAN_TOOL_USE_REPAIR_REASON` for consistency with the repair pass.
 * @returns One `functionResponse` part per dangling call, in input order.
 */
export function buildSyntheticToolResponseParts(
  danglingCalls: Array<{ callId: string; name: string }>,
  reason: string,
): Part[] {
  return danglingCalls.map(({ callId, name }) => ({
    functionResponse: { id: callId, name, response: { error: reason } },
  }));
}
