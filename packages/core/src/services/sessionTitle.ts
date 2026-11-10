/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { withoutAutoMemorySnapshots } from '../memory/request-context.js';
import { stripTrailingUserPromptSubmitContextPart } from '../hooks/user-prompt-submit-context.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  getStartupContextLength,
  stripSystemReminderBlocks,
} from '../core/environmentContext.js';
import { parseOutputLanguageMarker } from '../utils/output-language-table.js';
import {
  formatOutputLanguageInstruction,
  readOutputLanguagePreference,
} from '../utils/side-query-output-language.js';
import { runSideQuery } from '../utils/sideQuery.js';
import { stripTerminalControlSequences } from '../utils/terminalSafe.js';
import { SESSION_TITLE_MAX_LENGTH } from './sessionService.js';

const debugLogger = createDebugLogger('SESSION_TITLE');

const MAX_CONVERSATION_CHARS = 1000;
const RECENT_MESSAGE_WINDOW = 20;

// The "Good examples" shown to the model in TITLE_SYSTEM_PROMPT, and the
// echo-guard set: when the recent conversation carries little topical signal
// (boilerplate-heavy channel/hook context), the model takes the cheapest
// schema-valid answer and parrots one of these back verbatim (#9706). A
// canned example says nothing about the session, so matches are rejected
// like empty results. The prompt's "Good examples" block is rendered from
// this array, so the two cannot drift apart.
const TITLE_PROMPT_EXAMPLE_TITLES = [
  'Fix login button on mobile',
  'Add OAuth authentication flow',
  'Debug failing CI pipeline tests',
  '重构用户鉴权中间件',
];

// Rules that make the title follow the conversation's language. They are sent
// only when the output-language preference is `auto` or absent (#16793): the
// English prompt otherwise pulls fast models into English titles for a Chinese
// conversation, most often when the request is short or full of identifiers.
// A fixed language gets the prompt unchanged: with these rules added, a fast
// model broke a fixed English preference more often on Chinese conversations.
const TITLE_LENGTH_RULE_ANY_SCRIPT =
  '3-7 words, or about 8-20 characters for Chinese, Japanese or Korean.';
const TITLE_AUTO_LANGUAGE_CONTEXT =
  "For this title, the user's input means the human user's messages in the conversation transcript. Apply any language exception to those same messages.";

function titleSystemPrompt(description: string, rules: string): string {
  return `Generate ${description} that captures what this programming-assistant session is about. Think of it as a git commit subject for the session.

Rules:
${rules}
- No trailing punctuation.
- No quotes, backticks, or markdown.
- Be specific about the user's actual goal — name the feature, bug, or subject area. Avoid vague "Code changes", "Help request", "Conversation".

Good examples:
${TITLE_PROMPT_EXAMPLE_TITLES.map(
  (title) => `{"title": ${JSON.stringify(title)}}`,
).join('\n')}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the session title generation issue in the chat recording service"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}
Bad (trailing punctuation): {"title": "Fix login button."}

Return ONLY a JSON object with a single "title" key. No preamble, no reasoning, no closing remarks.`;
}

const TITLE_SYSTEM_PROMPT = titleSystemPrompt(
  'a concise, sentence-case title (3-7 words)',
  '- 3-7 words.\n- Sentence case: capitalize only the first word and proper nouns. NOT Title Case.',
);
const TITLE_SYSTEM_PROMPT_CONVERSATION_LANGUAGE = titleSystemPrompt(
  'a concise title',
  [
    `- ${TITLE_LENGTH_RULE_ANY_SCRIPT}`,
    '- Use sentence case only for languages with letter case. Capitalize only the first word and proper nouns.',
    "- Write the title in the main language of the user's messages in the conversation.",
    '- Keep personal names, code identifiers, file paths and product names exactly as written. Do not translate or transliterate them.',
  ].join('\n'),
);

const TITLE_USER_PROMPT =
  'Generate the session title now. Populate the schema with a single short title string.';

function titleSchema(description: string) {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description,
      },
    },
    required: ['title'],
  } as const;
}

const TITLE_SCHEMA = titleSchema(
  'A concise sentence-case session title, 3-7 words, no trailing punctuation.',
);
const TITLE_SCHEMA_CONVERSATION_LANGUAGE = titleSchema(
  `A concise session title. ${TITLE_LENGTH_RULE_ANY_SCRIPT} Use sentence case for languages with letter case. No trailing punctuation.`,
);

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
 * - `no_fast_model`: config.getFastModel() returned undefined.
 *   User needs to configure one via `/model --fast <name>`.
 * - `no_client`: BaseLlmClient or LlmClient not yet initialized. Rare,
 *   usually means the session hasn't authenticated yet.
 * - `empty_history`: the conversation has fewer than 2 turns of usable text.
 *   User should send at least one message before asking for a title.
 * - `empty_result`: the model returned nothing parseable into a title, or
 *   only parroted back one of the prompt's own example titles (#9706).
 *   Often means the model is too small or the conversation text is
 *   meaningless (e.g., only tool calls).
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
 * Generate a short title for the current session using the configured fast
 * model. Best-effort — never throws.
 *
 * Returns a discriminated result so callers can either handle failures
 * generically (`if (!outcome.ok) return null`) or map failure reasons to
 * actionable messages (as `/rename --auto` does).
 */
export async function tryGenerateSessionTitle(
  config: Config,
  abortSignal: AbortSignal,
  // One entry per user turn: its display text, `undefined` when the turn
  // recorded none, or `null` for a turn the person did not type, which offers
  // the title nothing either way.
  userDisplayTexts: ReadonlyArray<string | null | undefined> = [],
  // The keys ({@link modPromptTitleKey}) of the messages the Mods submitted,
  // which a title drawn from the conversation leaves out too.
  modPromptKeys: ReadonlySet<string> = new Set(),
): Promise<SessionTitleOutcome> {
  try {
    const model = config.getFastModel();
    if (!model) return { ok: false, reason: 'no_fast_model' };

    const llmClient = config.getLlmClient();
    if (!llmClient) return { ok: false, reason: 'no_client' };

    const fullHistory = withoutAutoMemorySnapshots(
      llmClient.getHistoryShallow(),
    );
    if (fullHistory.length < 2) return { ok: false, reason: 'empty_history' };

    const hasDisplayProjection = userDisplayTexts.some(
      (displayText) => typeof displayText === 'string',
    );
    const dialog = hasDisplayProjection
      ? userDisplayTexts.flatMap((displayText): Content[] =>
          displayText ? [{ role: 'user', parts: [{ text: displayText }] }] : [],
        )
      : filterToDialog(fullHistory, modPromptKeys);
    const recentHistory = takeRecentDialog(dialog, RECENT_MESSAGE_WINDOW);
    if (recentHistory.length === 0) {
      return { ok: false, reason: 'empty_history' };
    }

    const conversationText = flattenToTail(
      recentHistory,
      MAX_CONVERSATION_CHARS,
    );
    if (!conversationText.trim()) return { ok: false, reason: 'empty_history' };

    const preference = await readOutputLanguagePreference(
      config.getOutputLanguageFilePath?.(),
    );
    const isAuto =
      parseOutputLanguageMarker(preference ?? '')?.toLowerCase() === 'auto';
    const useConversationLanguage = preference === undefined || isAuto;
    const titlePrompt = useConversationLanguage
      ? TITLE_SYSTEM_PROMPT_CONVERSATION_LANGUAGE
      : TITLE_SYSTEM_PROMPT;
    const outputLanguageInstruction = formatOutputLanguageInstruction(
      isAuto ? `${TITLE_AUTO_LANGUAGE_CONTEXT}\n\n${preference}` : preference,
    );

    const result = await runSideQuery<{ title?: string }>(config, {
      purpose: 'session-title',
      model,
      systemInstruction: outputLanguageInstruction
        ? `${titlePrompt}\n\n${outputLanguageInstruction}`
        : titlePrompt,
      skipOutputLanguagePreference: true,
      schema: useConversationLanguage
        ? TITLE_SCHEMA_CONVERSATION_LANGUAGE
        : TITLE_SCHEMA,
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
    if (!title || isPromptExampleEcho(title)) {
      // Pre-#9706 an echo produced a visible bad title; post-guard the
      // failure mode is a silent absence, so leave a trace for oncall.
      debugLogger.warn(
        `Session title rejected (${title ? 'prompt-example echo' : 'empty'}): ${JSON.stringify(rawTitle)}`,
      );
      return { ok: false, reason: 'empty_result' };
    }

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
 * Detect a sanitized title that is just the model echoing one of the
 * prompt's own "Good examples" back (#9706). Exact, case-insensitive match
 * after sanitization — deliberately not fuzzy, so a genuinely topical title
 * that merely resembles an example still passes. Also catches the prompt's
 * "Bad (wrong case)" variant of the first example.
 *
 * Both sides of the comparison go through `normalizeForEchoCompare`, so an
 * example carrying edge punctuation (e.g. "Fix CI!") cannot slip past the
 * guard just because `sanitizeTitle` strips that punctuation off the
 * candidate (#9772).
 */
function isPromptExampleEcho(title: string): boolean {
  const normalized = normalizeForEchoCompare(title);
  return TITLE_PROMPT_EXAMPLE_TITLES.some(
    (example) => normalizeForEchoCompare(example) === normalized,
  );
}

/**
 * Normal form for echo comparison: trimmed, lowercased, with leading/trailing
 * runs of non-letter/non-digit characters stripped. The strip is Unicode-aware
 * so no wrapper family — `(...)`, `["..."]`, `<...>`, `«...»` — can bypass it
 * by falling outside an enumerated character class. Comparison-only: the title
 * shown to the user is never rewritten by it. Exported for unit tests.
 */
export function normalizeForEchoCompare(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '');
}

/**
 * Strip tool calls, tool responses, and hidden reasoning from history; keep
 * only user prompts and the model's user-visible text. A single tool response
 * can be a 10K-token file dump that swamps the title-LLM with irrelevant detail.
 */
/**
 * What a Mod's message is found by in the conversation: the text the model
 * read for it, its first text part as recorded.
 */
export function modPromptTitleKey(parts: readonly Part[]): string | undefined {
  return parts.find((part) => typeof part?.text === 'string')?.text;
}

// The request that reaches history can carry reminders as parts of their own
// and IDE context prepended to the first text part, so a part that ends with
// the key after that separator is the Mod's text too.
function isModPrompt(msg: Content, keys: ReadonlySet<string>): boolean {
  if (msg.role !== 'user' || keys.size === 0) return false;
  return (msg.parts ?? []).some((part) => {
    const text = part?.text;
    if (typeof text !== 'string') return false;
    for (const key of keys)
      if (text === key || text.endsWith(`\n\n${key}`)) return true;
    return false;
  });
}

function filterToDialog(
  history: Content[],
  modPromptKeys: ReadonlySet<string>,
): Content[] {
  const out: Content[] = [];
  for (const msg of history.slice(getStartupContextLength(history))) {
    if (msg.role !== 'user' && msg.role !== 'model') continue;
    if (isModPrompt(msg, modPromptKeys)) continue;
    const textParts: Part[] = [];
    const parts = stripTrailingUserPromptSubmitContextPart(msg.parts ?? []);
    for (const part of parts) {
      if (
        typeof part?.text !== 'string' ||
        part.text.trim() === '' ||
        part.thought ||
        part.thoughtSignature
      ) {
        continue;
      }
      const text = stripSystemReminderBlocks(part.text);
      if (text.trim() === '') continue;
      textParts.push({ ...part, text });
    }
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
