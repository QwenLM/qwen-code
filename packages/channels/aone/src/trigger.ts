/**
 * Command-prefix trigger for Aone CR comments. The platform's @mention
 * syntax is unverified (see the design doc's open questions), so v1
 * dispatches on configured prefixes — the convention the existing Aone
 * agent workflows already use (`force-review:`, `precheck_all`, ...).
 */

export interface TriggerMatch {
  /** The configured prefix that matched (original spelling). */
  prefix: string;
  /** Comment body with the matched prefix stripped, ready as prompt text. */
  text: string;
}

/**
 * Match a comment body against the trigger prefixes, case-insensitively.
 * The body is trimmed first; the matched prefix is stripped from the
 * prompt text (GitHub mention-strip precedent) so the instruction after
 * the prefix leads the text — slash-command dispatch and message routes
 * both key on the leading text.
 */
export function matchTrigger(
  body: string,
  prefixes: readonly string[],
): TriggerMatch | undefined {
  const trimmed = body.trim();
  const lower = trimmed.toLowerCase();
  for (const prefix of prefixes) {
    const lowered = prefix.toLowerCase();
    if (lowered.length > 0 && lower.startsWith(lowered)) {
      return { prefix, text: trimmed.slice(prefix.length).trimStart() };
    }
  }
  return undefined;
}

/**
 * Normalize the configured prefix list: an array of non-empty strings,
 * each trimmed. Throws with an actionable message otherwise. Shared by
 * the management descriptor's validateConfig and connect() so the UI and
 * the runtime cannot drift (GitHub validateRepoFilterConfig pattern).
 */
export function normalizeTriggerPrefixes(
  raw: unknown,
  channelName: string,
): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `triggerPrefixes for channel ${channelName} must be a non-empty array of comment prefixes (e.g. ["qwen:"]).`,
    );
  }
  const prefixes = raw.map((entry) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(
        `triggerPrefixes entries for channel ${channelName} must be non-empty strings.`,
      );
    }
    return entry.trim();
  });
  return prefixes;
}
