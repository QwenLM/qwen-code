/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { isSystemReminderContent } from '../utils/environmentContext.js';

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
 *    Retry would duplicate content), or history is empty.
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
export function detectTurnInterruption(history: Content[]): TurnInterruption {
  const last = history[history.length - 1];
  if (!last) {
    return { kind: 'none' };
  }

  if (last.role === 'user') {
    const trailingUserEntries: Content[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
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
 * synthesized responses (`applyRepair` in geminiChat.ts) so downstream
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
