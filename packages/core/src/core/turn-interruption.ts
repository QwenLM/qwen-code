/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { isSystemReminderContent } from './environmentContext.js';
import { isAgentEnvelopeContent } from '../agents/session-agents/envelope.js';

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
 * Shape alone cannot separate that from a real user prompt whose entire text
 * IS a bare envelope (the user pasted one, or asked for a verbatim echo): the
 * entry is user-role, single-part and wrapped, so every clause above matches.
 * Trimming it exposes the PREVIOUS model turn as the tail and returns `none`,
 * certifying `clean` for a prompt that was never answered — and the next send
 * pops it out of live history through `stripOrphanedUserEntriesFromHistory`.
 * Callers that have the source records therefore pass
 * `trailingSystemNotifications` to {@link effectiveHistoryEnd}, which narrows
 * the trim to entries the recorder actually stamped as notifications. This
 * predicate stays shape-based because it is also the fallback for callers that
 * hold only raw `Content[]`.
 *
 * The same shape collision exists between a cold record and a FAILED live
 * notification turn whose entry carries no reminders (no plan mode, no output
 * style, no active todo chain): both are single-envelope user entries, and
 * both records carry `provenance: 'system'` + `subtype: 'notification'`.
 * `backgroundTurn` cannot separate them — the `channelTask` admission branch
 * runs the turn with `backgroundTurnContext.exit(...)` — so the recorder
 * stamps the turn's own entry `deliveredTurn: true` when the `client.ts` send
 * path admits it (chatRecordingService.ts), and the projection's count
 * excludes stamped entries. Wherever that count is forwarded — today only the
 * record-derived `buildSessionRecoveryPlan` callers (the TUI's resume and
 * session-switch paths) — a failed stamped turn is left in place and
 * classifies as the textbook `interrupted_prompt` documented above. Callers
 * that hold only raw `Content[]` (headless
 * `continueInterrupted`/`continue_last_turn`, and the daemon) forward no
 * count, keep the shape-only trim, and still trim a stamped envelope: with no
 * count `authoritativeFrom` is `-Infinity`, so the trim's only bail-out is
 * unreachable and every trailing envelope-shaped entry goes. When the count IS
 * supplied, only unstamped records — cold copies persisted before any turn
 * ran — are trimmed.
 *
 * The stamp is written on the `LlmClient.sendMessageStream` send path — the
 * TUI and headless runtimes. The ACP/serve daemon sends its notification
 * turns through `Session.#sendMessageStreamWithAutoCompression` →
 * `LlmChat.sendMessageStream`, which records nothing; its entry is written
 * either pre-admission by `recordNotificationStrict` (no stamp parameter) or
 * post-admission at send time by `recordNotification` (the unpersisted
 * registry-callback branch) — the latter overload takes the stamp, but both
 * sites write before the send commits, so an abort or a null `responseStream`
 * afterwards would stamp a turn that never ran. A reminder-less entry the
 * daemon delivered is therefore still unmarked, still counted, still trimmed
 * and still reported `clean`. That daemon residual of #12042 shape A stays
 * open
 * (`docs/design/session-crash-recovery/session-crash-recovery-interruption-detection.md`,
 * "Not covered yet"); closing it needs a marker written after the send
 * commits or a daemon-side re-drive, not a stamp at either existing site.
 * Stamping the cold record itself is not an option: it is written before
 * `assertCanStartTurn()`, so turns later refused or deferred would carry the
 * stamp too. The `LlmClient` stamp sits after admission but still above that
 * path's own pre-send refusal gates, so it carries the same imprecision on a
 * narrower set of exits; that residual is accepted and quantified on
 * `ChatRecord.deliveredTurn` rather than restated here.
 *
 * Needed at all because the record's `subtype: 'notification'` and
 * `provenance: 'system'` cannot ride along on `Content` (that type comes from
 * `@google/genai`), so the live history tail carries no metadata to read and
 * the projection has to report it separately (`session-api-history.ts`).
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
 * @param trailingSystemNotifications - Optional authoritative count of trailing
 *   `history` entries whose source record the recorder stamped
 *   `provenance: 'system'` + `subtype: 'notification'` AND that is a cold copy
 *   persisted before any turn ran (`deliveredTurn !== true`; see
 *   `isSystemNotificationRecord` in `session-api-history.ts`), as reported by
 *   `buildSessionHistoryFromConversation`. A stamped-but-unanswered entry is
 *   an `interrupted_prompt`, not a cold notification, so it is excluded from
 *   the count and survives the trim. When supplied it NARROWS the trim:
 *   an entry is only trimmed if its shape matches AND it falls inside that
 *   authoritative run. Passing `undefined` (what every caller that has no
 *   record metadata does) preserves the shape-only behaviour exactly, so the
 *   cross-package caller above needs no change. It can never widen the trim —
 *   the shape predicate still gates every entry — so a count larger than the
 *   envelope-shaped run simply stops at the first non-matching entry.
 * @returns The exclusive end index of the classifiable prefix.
 */
export function effectiveHistoryEnd(
  history: readonly Content[],
  trailingSystemNotifications?: number,
): number {
  let end = history.length;
  // Index of the first entry the authoritative run covers. Entries before it
  // are not known to be system notifications, whatever they look like.
  const authoritativeFrom =
    trailingSystemNotifications === undefined
      ? -Infinity
      : history.length - trailingSystemNotifications;
  while (end > 0) {
    const entry = history[end - 1]!;
    // A session multi-agent record (agent reply or @-mention) is durable
    // conversation the main model was never asked to answer, so a trailing
    // one is not an unfinished turn.
    // TODO(multi-agent): an agent entry after trailing notifications shifts
    // the authoritative notification window below; revisit if that mixes.
    if (isAgentEnvelopeContent(entry)) {
      end--;
      continue;
    }
    if (!isSystemNotificationContent(entry)) break;
    // Shape says notification, but the record's own provenance says this is
    // real user input that merely looks like an envelope. Trimming it would
    // expose the previous model turn as the tail, certify `clean` for a prompt
    // that was never answered, and the next send would pop it out of live
    // history — silent loss, and the one case shape alone cannot rule out.
    if (end - 1 < authoritativeFrom) break;
    end--;
  }
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
 * @param completedToolCallIds - Ids whose call/response pair is already closed.
 * @param trailingSystemNotifications - Optional authoritative notification
 *   provenance forwarded to {@link effectiveHistoryEnd}. Omit it when the
 *   caller only has raw `Content[]`; supply it when the history came from
 *   `buildSessionHistoryFromConversation`, which can read the records' own
 *   `provenance`.
 * @returns The interruption classification; see {@link TurnInterruption}.
 */
export function detectTurnInterruption(
  history: Content[],
  completedToolCallIds?: readonly string[],
  trailingSystemNotifications?: number,
): TurnInterruption {
  const boundary = completedToolCallBoundary(history, completedToolCallIds);
  // Trailing background notifications are not an unfinished turn: the daemon
  // persists each one before its automatic turn runs, so a notification whose
  // turn never ran leaves a `user` tail that nothing will ever answer. Left in
  // place it classifies as `interrupted_prompt`, which keeps the recovery
  // banner pinned on a session whose last real turn ended cleanly.
  const end = effectiveHistoryEnd(history, trailingSystemNotifications);
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
      // The same holds for session multi-agent envelope entries.
      if (isSystemReminderContent(entry) || isAgentEnvelopeContent(entry)) {
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
