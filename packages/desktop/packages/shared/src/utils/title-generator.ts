/**
 * Session title generation utilities.
 *
 * Shared helpers for building title prompts and validating results.
 * Actual title generation is handled by agent classes using their respective SDKs:
 * - Backend agents use their own lightweight completion path
 */

/** Max characters used for persisted/displayed session titles. */
export const MAX_TITLE_LENGTH = 60;

/** Slice text at the last word boundary within `max` characters. */
export function sliceAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const lastSpace = text.lastIndexOf(' ', max);
  return lastSpace > 0 ? text.slice(0, lastSpace) : text.slice(0, max);
}

/** Truncate a title so the returned string never exceeds `max` characters. */
export function truncateTitle(title: string, max = MAX_TITLE_LENGTH): string {
  const cleaned = title.trim();
  if (cleaned.length <= max) return cleaned;
  if (max <= 0) return '';
  if (max === 1) return '…';

  const sliceMax = max - 1;
  const sliced = sliceAtWord(cleaned, sliceMax).trimEnd();
  const prefix = sliced.length > 0 ? sliced : cleaned.slice(0, sliceMax);
  return `${prefix}…`;
}

/**
 * Check if text before a colon looks like LLM preamble.
 * Matches: "Title", "Topic", "Sure", "Sure, the title is", "Here's the topic", etc.
 */
function isPreamblePrefix(text: string): boolean {
  const lower = text.trim().toLowerCase();
  // Exact single-word preamble
  if (/^(?:title|topic|sure|okay|ok)$/.test(lower)) return true;
  // Starts with a known opener and optionally references title/topic
  if (/^(?:sure|okay|ok|here(?:'s| is))\b/.test(lower)) return true;
  // "the title/topic is" or similar
  if (/^the\s+(?:title|topic)\b/.test(lower)) return true;
  return false;
}

/**
 * Sanitize a language preference string before prompt interpolation.
 * Returns undefined for invalid/suspicious inputs so the caller falls back to auto-detect.
 */
export function sanitizeLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const trimmed = language.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > 40) return undefined;
  // Allow letters (any script), Unicode marks, spaces, hyphens
  if (!/^[\p{L}\p{M}\s\-]+$/u.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Build a language instruction for title prompts.
 * Explicit preference takes priority; otherwise auto-detect from message content.
 */
function buildLanguageInstruction(language?: string): string {
  const safe = sanitizeLanguage(language);
  if (safe) {
    return `Reply in ${safe}.`;
  }
  return 'Reply in the same language as the user\'s messages.';
}

/**
 * Build a prompt for generating a session title from a user message.
 *
 * @param message - The user's message to generate a title from
 * @param options.language - Preferred language for the title
 * @returns Formatted prompt string
 */
export function buildTitlePrompt(message: string, options?: { language?: string }): string {
  const snippet = sliceAtWord(message, 500);
  return [
    'What topic or area is the user exploring? Reply with ONLY a short descriptive title (2-5 words).',
    'Use a short descriptive label. Use plain text only - no markdown.',
    buildLanguageInstruction(options?.language),
    'Examples: "Auto Title Generation", "Dark Mode Support", "Fix API Authentication", "Database Schema Design", "React Performance"',
    '',
    'User: ' + snippet,
    '',
    'Topic:',
  ].join('\n');
}

/** Max characters for a message to be considered potentially low-signal. */
const LOW_SIGNAL_MAX_CHARS = 12;
/** Max words for a message to be considered potentially low-signal. */
const LOW_SIGNAL_MAX_WORDS = 2;

/**
 * Check if a message is likely low-signal (short acknowledgement/command).
 * Language-agnostic: uses length + word count only.
 */
export function isLowSignal(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length > LOW_SIGNAL_MAX_CHARS) return false;
  if (trimmed.split(/\s+/).length > LOW_SIGNAL_MAX_WORDS) return false;
  // If it contains a question mark, it's probably a real question
  if (trimmed.includes('?')) return false;
  return true;
}

/**
 * Select a spread of user messages that captures the session's purpose:
 * first (original intent), a recent-biased middle, and last (current state).
 *
 * Strips trailing low-signal messages (short acknowledgements like "ok", "thanks")
 * before selecting, so the spread focuses on substantive content.
 * Falls back to unfiltered if all messages are low-signal.
 *
 * For 4+ messages, picks at indices 0, ~66%, and last — biasing toward
 * where the conversation ended up rather than the exact midpoint.
 */
export function selectSpreadMessages(allUserMessages: string[]): string[] {
  const count = allUserMessages.length;
  if (count === 0) return [];

  // Strip trailing low-signal messages
  let filtered = allUserMessages;
  let trimEnd = allUserMessages.length;
  while (trimEnd > 0 && isLowSignal(allUserMessages[trimEnd - 1]!)) {
    trimEnd--;
  }
  if (trimEnd > 0) {
    filtered = allUserMessages.slice(0, trimEnd);
  }
  // else: all messages are low-signal, keep original array

  const n = filtered.length;
  if (n === 1) return [filtered[0]!];
  if (n === 2) return [filtered[0]!, filtered[1]!];
  if (n === 3) return [filtered[0]!, filtered[1]!, filtered[2]!];

  const midIndex = Math.floor(n * 2 / 3);
  return [filtered[0]!, filtered[midIndex]!, filtered[n - 1]!];
}

/** Build a label for the user messages section based on how many were selected. */
function messagesSectionLabel(count: number): string {
  if (count === 1) return 'User message:';
  if (count === 2) return 'User messages (first, last):';
  return 'Selected user messages:';
}

/**
 * Build a prompt for regenerating a session title from recent messages.
 *
 * @param recentUserMessages - Spread of user messages (first, middle, last)
 * @param lastAssistantResponse - The most recent assistant response
 * @param options.language - Preferred language for the title
 * @returns Formatted prompt string
 */
export function buildRegenerateTitlePrompt(
  recentUserMessages: string[],
  lastAssistantResponse: string,
  options?: { language?: string }
): string {
  const userContext = recentUserMessages
    .map((msg) => sliceAtWord(msg, 500))
    .join('\n\n');
  const assistantSnippet = sliceAtWord(lastAssistantResponse, 500);

  const lines: string[] = [
    'Based on these messages, what is this conversation about?',
    'Reply with ONLY a short descriptive title (2-5 words).',
    'Use a short descriptive label. Use plain text only - no markdown.',
    'Ignore short acknowledgement messages (like "ok", "thanks", "do it") that don\'t carry topic information.',
    buildLanguageInstruction(options?.language),
    'Examples: "Auto Title Generation", "Dark Mode Support", "Fix API Authentication", "Database Schema Design"',
  ];

  lines.push(
    '',
    messagesSectionLabel(recentUserMessages.length),
    userContext,
    '',
    'Latest assistant response:',
    assistantSnippet,
    '',
    'Topic:',
  );

  return lines.join('\n');
}

/** Max word count for a valid title. Anything above this is likely preamble leakage. */
const MAX_TITLE_WORDS = 10;

/**
 * Validate and clean a generated title.
 *
 * Iteratively strips known LLM preamble artifacts (leading "Title:", "Sure:", etc.),
 * then removes quotes and markdown formatting, and checks length/word-count bounds.
 *
 * @param title - The raw title from the model
 * @returns Cleaned title, or null if invalid
 */
export function validateTitle(title: string | null | undefined): string | null {
  if (!title) return null;

  let cleaned = title.trim();

  // Iterative preamble stripping: handles chained preambles like "Sure: Title: Foo"
  let prev = '';
  while (cleaned !== prev) {
    prev = cleaned;
    const colonIndex = cleaned.indexOf(':');
    if (colonIndex > 0 && colonIndex < 40) {
      const beforeColon = cleaned.slice(0, colonIndex);
      if (isPreamblePrefix(beforeColon)) {
        cleaned = cleaned.slice(colonIndex + 1).trim();
      }
    }
  }

  // Strip surrounding quotes
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }

  // Strip surrounding bold markers **title**
  if (cleaned.startsWith('**') && cleaned.endsWith('**')) {
    cleaned = cleaned.slice(2, -2);
  }

  // Strip leading markdown heading markers (one or more #, -, *)
  cleaned = cleaned.replace(/^[#\-*]+\s+/, '');

  cleaned = cleaned.trim();

  // Reject empty or too many words (likely preamble leakage)
  if (cleaned.length === 0) return null;
  if (cleaned.split(/\s+/).length > MAX_TITLE_WORDS) return null;

  return truncateTitle(cleaned);
}
