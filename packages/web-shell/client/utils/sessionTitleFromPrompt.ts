const MAX_PROMPT_TITLE_LENGTH = 40;
const MIN_PROMPT_TITLE_LENGTH = 4;

/**
 * Derive a session title from the first prompt when the prompt itself is
 * already a usable short title. Returns undefined for anything the fast-model
 * title should handle instead: multi-line prompts, long prompts, and a bare
 * slash command with no arguments.
 *
 * Deliberately lighter than core's `sanitizeTitle`: this runs in the browser
 * bundle, which must not pull in the model client. Keep the trailing
 * punctuation class in sync with that helper.
 */
export function titleFromPrompt(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return undefined;

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

  const length = Array.from(title).length;
  if (length < MIN_PROMPT_TITLE_LENGTH || length > MAX_PROMPT_TITLE_LENGTH) {
    return undefined;
  }
  // `/verify-pr 15361` is already a title; `/review` alone is not.
  if (/^\/\S+$/.test(title)) return undefined;
  return title;
}
