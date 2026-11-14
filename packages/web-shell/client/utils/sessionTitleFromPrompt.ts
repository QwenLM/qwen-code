const MAX_PROMPT_TITLE_LENGTH = 40;
const MIN_PROMPT_TITLE_LENGTH = 4;

export interface TitleFromPromptOptions {
  /** Minimum title length in code points (default: 4). */
  minTitleLength?: number;
  /**
   * Title length cap in code points (default: 40). Without `truncate`,
   * prompts beyond the cap are rejected so the fast-model title can take
   * over; with `truncate`, the title is cut to the cap.
   */
  maxTitleLength?: number;
  /**
   * Fold newlines into spaces instead of rejecting the prompt (default:
   * reject).
   */
  allowMultiLine?: boolean;
  /**
   * Cut the title to `maxTitleLength` instead of rejecting it (default:
   * reject).
   */
  truncate?: boolean;
}

/**
 * Derive a session title from the first prompt when the prompt itself is
 * already a usable short title. Returns undefined for anything the fast-model
 * title should handle instead: multi-line prompts, long prompts, and a bare
 * slash command with no arguments.
 *
 * Options let other title consumers relax the main-session rules without
 * forking the sanitization (side tasks derive the tab title and the daemon
 * rename from the same prompt, so they fold multi-line prompts, name short
 * prompts, and truncate instead of deferring to the model title). Defaults
 * preserve the main-session behavior.
 *
 * Deliberately lighter than core's `sanitizeTitle`: this runs in the browser
 * bundle, which must not pull in the model client. Keep the trailing
 * punctuation class in sync with that helper.
 */
export function titleFromPrompt(
  text: string,
  options: TitleFromPromptOptions = {},
): string | undefined {
  const {
    minTitleLength = MIN_PROMPT_TITLE_LENGTH,
    maxTitleLength = MAX_PROMPT_TITLE_LENGTH,
    allowMultiLine = false,
    truncate = false,
  } = options;

  let trimmed = text.trim();
  if (!trimmed) return undefined;
  if (/[\r\n]/.test(trimmed)) {
    if (!allowMultiLine) return undefined;
    trimmed = trimmed.replace(/[\r\n]+/g, ' ');
  }

  const title = trimmed
    .replace(/^[>*#\-+`"'\s]+/, '')
    .replace(/[`"'\s]+$/, '')
    .replace(/[.!?。！？,，;；:：]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Control characters cannot be persisted as a title (the daemon rejects
  // them) and must not become a client-only pending label. A loop keeps the
  // source free of control-character regex literals (eslint no-control-regex).
  for (const character of title) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return undefined;
    }
  }

  const codePoints = Array.from(title);
  if (codePoints.length < minTitleLength) return undefined;
  if (codePoints.length > maxTitleLength && !truncate) return undefined;
  // `/verify-pr 15361` is already a title; `/review` alone is not.
  if (/^\/\S+$/.test(title)) return undefined;
  return codePoints.length > maxTitleLength
    ? codePoints.slice(0, maxTitleLength).join('')
    : title;
}
