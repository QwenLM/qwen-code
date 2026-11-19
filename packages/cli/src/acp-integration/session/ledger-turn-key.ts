/**
 * Single source of truth for the ACP mid-turn continuation suffix vocabulary.
 *
 * Mid-turn automatic continuations rewrite the prompt id with one of these
 * suffixes; the ledger must keep the turn's base key so a continuation does not
 * reset the turn's consumed marks. Both the id builders in `Session.ts` and the
 * normalizer below derive from this list, so the generation and stripping sides
 * cannot drift apart. Only the ledger key is normalized — the prompt id keeps
 * its prompt identity.
 */
export const LEDGER_CONTINUATION_SUFFIXES = [
  'todo_stop_guard',
  'stop_hook',
  'background_result',
  'mid_turn',
] as const;

export type LedgerContinuationSuffix =
  (typeof LEDGER_CONTINUATION_SUFFIXES)[number];

const CONTINUATION_SUFFIX_PATTERN = new RegExp(
  `_(${LEDGER_CONTINUATION_SUFFIXES.join('|')})_\\d+$`,
);

/** Appends a continuation suffix to a base prompt id (generation side). */
export function buildContinuationPromptId(
  basePromptId: string,
  suffix: LedgerContinuationSuffix,
  ordinal: number,
): string {
  return `${basePromptId}_${suffix}_${ordinal}`;
}

/** Strips a trailing continuation suffix back to the base key (ledger side). */
export function deriveLedgerTurnKey(promptId: string): string {
  return promptId.replace(CONTINUATION_SUFFIX_PATTERN, '');
}
