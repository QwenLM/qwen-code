/**
 * Derives the model-availability ledger turn key from an ACP prompt id.
 *
 * Mid-turn automatic continuations rewrite the prompt id with a
 * guard/stop-hook/background-result/mid-turn suffix; the ledger must keep the
 * turn's base key so a continuation does not reset the turn's consumed marks.
 * Only the ledger key is normalized — the prompt id keeps its prompt identity.
 */
export function deriveLedgerTurnKey(promptId: string): string {
  return promptId.replace(
    /_(todo_stop_guard|stop_hook|background_result|mid_turn)_\d+$/,
    '',
  );
}
