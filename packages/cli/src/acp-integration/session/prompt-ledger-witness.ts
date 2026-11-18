/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  readPromptLedgerRecords,
  type PromptLedgerRecord,
} from '@qwen-code/acp-bridge/promptLedger';

/**
 * Trailing bytes of the session's prompt terminal ledger read on the
 * recovery-status path. Records are ~150 bytes, so 32 KiB retains a few
 * hundred records — far more than the newest-record evidence the recovery
 * classification needs. (The 256 KiB load-response window is sized for
 * embedding up to 64 terminal records; a different requirement.)
 */
export const RECOVERY_LEDGER_TAIL_BYTES = 32 * 1024;

/**
 * The minimal config surface the witness factory needs from the daemon
 * process: the session service that owns the per-session ledger layout.
 */
export interface PromptLedgerWitnessConfig {
  getSessionService(): {
    getPromptLedgerPath(sessionId: string): string;
  };
}

/**
 * Builds the recovery-classification witness for one session: a closure
 * returning the bounded tail of that session's prompt terminal ledger, or
 * `undefined` without usable ledger evidence (unwired session service, I/O
 * error). A missing or empty ledger file reads as `[]` — that is evidence
 * too: on a runtime where the ledger is wired, no prompt was ever admitted
 * in that session.
 *
 * The read side must degrade to "no evidence" on every failure: a failed
 * read leaves recovery classification conservative (the banner stays), and
 * that is the only safe direction.
 *
 * Extracted from the `QwenAgent` session-construction site so the production
 * wiring (config → session service → ledger path → bounded tail read) is the
 * code under test, not an inline closure that no test executes.
 */
export function createPromptLedgerWitness(
  config: PromptLedgerWitnessConfig,
  sessionId: string,
): () => readonly PromptLedgerRecord[] | undefined {
  return () => {
    try {
      const ledgerPath = config
        .getSessionService()
        .getPromptLedgerPath(sessionId);
      return readPromptLedgerRecords(ledgerPath, {
        tailBytes: RECOVERY_LEDGER_TAIL_BYTES,
      });
    } catch {
      return undefined;
    }
  };
}
