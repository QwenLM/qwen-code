/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { runSideQuery } from '../utils/sideQuery.js';
import { stripTerminalControlSequences } from '../utils/terminalSafe.js';
import { SESSION_TITLE_MAX_LENGTH } from './sessionService.js';

const debugLogger = createDebugLogger('SESSION_TITLE');

const MAX_CONVERSATION_CHARS = 1000;
const RECENT_MESSAGE_WINDOW = 20;

const TITLE_SYSTEM_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures what this programming-assistant session is about. Think of it as a git commit subject for the session.

Rules:
- 3-7 words.
- Sentence case: capitalize only the first word and proper nouns. NOT Title Case.
- No trailing punctuation.
- No quotes, backticks, or markdown.
- Match the dominant language of the conversation (English or Chinese). For Chinese, treat as roughly 12-20 characters total; still no trailing punctuation.
- Be specific about the user's actual goal — name the feature, bug, or subject area. Avoid vague "Code changes", "Help request", "Conversation".

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication flow"}
{"title": "Debug failing CI pipeline tests"}
{"title": "重构用户鉴权中间件"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the session title generation issue in the chat recording service"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}
Bad (trailing punctuation): {"title": "Fix login button."}

Return ONLY a JSON object with a single "title" key. No preamble, no reasoning, no closing remarks.`;

const TITLE_USER_PROMPT =
  'Generate the session title now. Populate the schema with a single short title string.';

const TITLE_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description:
        'A concise sentence-case session title, 3-7 words, no trailing punctuation.',
    },
  },
  required: ['title'],
} as const;

const LEADING_MARKERS_RE = /^[\s>*\-#`"'_]+/;
const TRAILING_MARKERS_RE = /[\s*`"'_]+$/;
const TRAILING_PUNCT_RE = /[.!?。！？,，;；:：]+$/;
// Paired CJK brackets (e.g. `【Draft】Fix login`): strip as a whole so a
// lone closing bracket doesn't dangle after a leading-char-class strip.
const LEADING_PAIRED_BRACKETS_RE =
  /^\s*[「『【〈《][^」』】〉》]*[」』】〉》]\s*/;
const TRAILING_PAIRED_BRACKETS_RE =
  /\s*[「『【〈《][^」』】〉》]*[」』】〉》]\s*$/;

/**
 * Reason a title generation didn't produce a usable title. Separated from
 * the success payload so callers (esp. the interactive `/rename --auto`
 * command) can surface actionable messages instead of a generic "could not
 * generate".
 *
 * - `no_fast_model`: config.getFastModelForSideQuery() returned undefined.
 *   User needs to configure one via `/model --fast <name>`.
 * - `no_client`: BaseLlmClient or GeminiClient not yet initialized. Rare,
 *   usually means the session hasn't authenticated yet.
 * - `empty_history`: the conversation has fewer than 2 turns of usable text.
 *   User should send at least one message before asking for a title.
 * - `empty_result`: the model returned nothing parseable into a title. Often
 *   means the model is too small or the conversation text is meaningless
 *   (e.g., only tool calls).
 * - `aborted`: AbortSignal fired (user pressed Ctrl-C / new session / switch).
 * - `model_error`: the LLM call threw — rate limit, auth, network, etc.
 */
export type SessionTitleFailureReason =
  | 'no_fast_model'
  | 'no_client'
  | 'empty_history'
  | 'empty_result'
  | 'aborted'
  | 'model_error';

export type SessionTitleOutcome =
  | { ok: true; title: string; modelUsed: string }
  | { ok: false; reason: SessionTitleFailureReason };

/**
 * Generate a short (3-7 word, sentence-case) title for the current session
 * using the configured fast model. Best-effort — never throws.
 *
 * Returns a discriminated result so callers can either handle failures
 * generically (`if (!outcome.ok) return null`) or map failure reasons to
 * actionable messages (as `/rename --auto` does).
 */
export async function tryGenerateSessionTitle(
  config: Config,
  abortSignal: AbortSignal,
): Promise<SessionTitleOutcome> {
  try {
    const model = config.getFastModelForSideQuery?.() ?? config.getFastModel();
    if (!model) return { ok: false, reason: 'no_fast_model' };

    const geminiClient = config.getGeminiClient();
    if (!geminiClient) return { ok: false, reason: 'no_client' };

    const fullHistory = geminiClient.getChat().getHistory();
    if (fullHistory.length < 2) return { ok: false, reason: 'empty_history' };

    const dialog = filterToDialog(fullHistory);
    const recentHistory = takeRecentDialog(dialog, RECENT_MESSAGE_WINDOW);
    if (recentHistory.length === 0) {
      return { ok: false, reason: 'empty_history' };
    }

    const conversationText = flattenToTail(
      recentHistory,
      MAX_CONVERSATION_CHARS,
    );
    if (!conversationText.trim()) return { ok: false, reason: 'empty_history' };

    const result = await runSideQuery<{ title?: string }>(config, {
      purpose: 'session-title',
      systemInstruction: TITLE_SYSTEM_PROMPT,
      schema: TITLE_SCHEMA as unknown as Record<string, unknown>,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `Conversation so far:\n${conversationText}\n\n${TITLE_USER_PROMPT}`,
            },
          ],
        },
      ],
      config: {
        temperature: 0.2,
        maxOutputTokens: 100,
      },
      abortSignal,
      // Titles are best-effort cosmetic metadata — one shot only, no long retry loop.
      maxAttempts: 1,
    });

    if (abortSignal.aborted) return { ok: false, reason: 'aborted' };

    const rawTitle =
      typeof result?.['title'] === 'string' ? (result['title'] as string) : '';
    const title = sanitizeTitle(rawTitle);
    if (!title) return { ok: false, reason: 'empty_result' };

    return { ok: true, title, modelUsed: model };
  } catch (err) {
    debugLogger.warn(
      `Session title generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (abortSignal.aborted) return { ok: false, reason: 'aborted' };
    return { ok: false, reason: 'model_error' };
  }
}

/**
 * Normalize a raw title string coming back from the schema-enforced JSON
 * call. The schema guarantees a string, but models routinely ignore the
 * "no markdown / no trailing punctuation" guidance, so we strip those
 * post-hoc. Exported for unit tests. Returns '' if nothing recoverable.
 */
export function sanitizeTitle(s: string): string {
  // SECURITY: strip terminal control sequences first. The title renders
  // directly in the picker — a model-returned ANSI/OSC-8 escape would
  // otherwise execute on every render. See `stripTerminalControlSequences`
  // for the coverage list.
  let t = stripTerminalControlSequences(s).trim();
  // Strip paired CJK bracket prefix/suffix first (as units) so we don't end
  // up with a lone closing bracket after the single-character strips below.
  t = t.replace(LEADING_PAIRED_BRACKETS_RE, '');
  t = t.replace(TRAILING_PAIRED_BRACKETS_RE, '');
  t = t.replace(LEADING_MARKERS_RE, '');
  t = t.replace(TRAILING_MARKERS_RE, '');
  t = t.replace(TRAILING_PUNCT_RE, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length > SESSION_TITLE_MAX_LENGTH) {
    t = t.slice(0, SESSION_TITLE_MAX_LENGTH).trim();
    // slice() can split a surrogate pair at the boundary — drop any
    // orphaned surrogate so the resulting string stays well-formed UTF-16.
    t = t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '');
    t = t.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  }
  return t;
}

/**
 * Strip tool calls, tool responses, and hidden reasoning from history; keep
 * only user prompts and the model's user-visible text. A single tool response
 * can be a 10K-token file dump that swamps the title-LLM with irrelevant detail.
 */
function filterToDialog(history: Content[]): Content[] {
  const out: Content[] = [];
  for (const msg of history) {
    if (msg.role !== 'user' && msg.role !== 'model') continue;
    const textParts = (msg.parts ?? []).filter(
      (part) =>
        typeof part?.text === 'string' &&
        part.text.trim() !== '' &&
        !part.thought &&
        !part.thoughtSignature,
    );
    if (textParts.length === 0) continue;
    out.push({ role: msg.role, parts: textParts });
  }
  return out;
}

/**
 * Take the most recent N messages while preserving turn structure: never
 * start the slice on a model response that would dangle without its preceding
 * user message.
 */
function takeRecentDialog(history: Content[], windowSize: number): Content[] {
  if (history.length <= windowSize) return history;
  let start = history.length - windowSize;
  while (start < history.length && history[start]?.role !== 'user') {
    start++;
  }
  return history.slice(start);
}

/**
 * Flatten filtered dialog to labeled plain text, then tail-slice to the last
 * N characters. Tail (rather than head) captures what the session has become,
 * not just how it opened — e.g. a session that starts with "help me debug X"
 * but ends up refactoring Y should get a title about Y.
 */
function flattenToTail(history: Content[], maxChars: number): string {
  const lines: string[] = [];
  for (const msg of history) {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    const text = (msg.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) continue;
    lines.push(`${role}: ${text}`);
  }
  const joined = lines.join('\n');
  if (joined.length <= maxChars) return joined;
  let tail = joined.slice(-maxChars);
  // `.slice` on a UTF-16 code-unit boundary can strand a lone low-surrogate
  // at the start (if the slice cut through a CJK supplementary char or emoji).
  // JSON-serializing that to the LLM produces an invalid surrogate that some
  // providers reject with 400s, burning an attempt against the 3-cap for no
  // real reason. Drop the dangling surrogate so the payload is always
  // well-formed UTF-16.
  if (tail.length > 0) {
    const firstCode = tail.charCodeAt(0);
    if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
      tail = tail.slice(1);
    }
  }
  return tail;
}
