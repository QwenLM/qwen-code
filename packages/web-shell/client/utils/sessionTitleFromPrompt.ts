const MAX_PROMPT_TITLE_LENGTH = 40;
const MIN_PROMPT_TITLE_LENGTH = 4;

/**
 * Derive a session title from the first prompt when the prompt itself is
 * already a usable short title. Returns undefined for anything the fast-model
 * title should handle instead: multi-line prompts, long prompts, and a bare
 * slash command with no arguments.
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

  const length = Array.from(title).length;
  if (length < MIN_PROMPT_TITLE_LENGTH || length > MAX_PROMPT_TITLE_LENGTH) {
    return undefined;
  }
  // `/verify-pr 15361` is already a title; `/review` alone is not.
  if (/^\/\S+$/.test(title)) return undefined;
  return title;
}
