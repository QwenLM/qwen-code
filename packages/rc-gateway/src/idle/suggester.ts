/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatTransport, ChatMessage } from './chatTransport.js';
import { parseSuggestions } from './suggestionParser.js';

/** One recent conversation turn fed as context to the suggester. */
export interface TurnText {
  role: 'user' | 'assistant';
  text: string;
}

const SYSTEM_PROMPT =
  'You suggest next-step actions for a software engineering session. ' +
  'Reply with ONLY a JSON array of 1-3 short imperative strings ' +
  '(each ≤ 60 chars, e.g. "Run the tests"). No prose, no code fences, no keys.';

/**
 * Generate next-step suggestions from recent conversation turns using the
 * gateway's own chat transport. TOTAL and never-throws: a transport
 * error/timeout/abort, or any unparseable reply, yields `[]` (the feature
 * degrades to silence, never a crash or a broken UI). No turns → `[]` (nothing
 * to suggest from; also avoids a pointless model call).
 *
 * This NEVER touches the daemon session — it makes an independent model call and
 * the result is surfaced out-of-band (a later slice emits an `idle_suggestions`
 * event), so the live transcript, viewers, and the model's own later replies are
 * unaffected (the whole reason `add-idle-suggestions` is built gateway-side).
 */
export async function generateSuggestions(args: {
  turns: TurnText[];
  chat: ChatTransport;
  max?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string[]> {
  const max = args.max ?? 3;
  if (args.turns.length === 0) return [];

  const convo = args.turns.map((t) => `${t.role}: ${t.text}`).join('\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Recent conversation:\n${convo}\n\n` +
        `Suggest up to ${max} next-step actions as a JSON array of strings.`,
    },
  ];

  let raw: string;
  try {
    raw = await args.chat(messages, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
  } catch {
    return []; // transport error / timeout / abort → no suggestions, never throw.
  }
  return parseSuggestions(raw, { max });
}
