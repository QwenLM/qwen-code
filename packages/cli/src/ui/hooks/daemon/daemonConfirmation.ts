/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridge a daemon `permission_request` to the in-process confirmation UI.
 *
 * The TUI's `ToolConfirmationMessage` renders a fixed set of
 * {@link ToolConfirmationOutcome}s per `confirmationDetails.type` and calls
 * `onConfirm(outcome)`. A daemon gate, by contrast, exposes an opaque set of
 * `{ optionId, kind }` options and is answered over HTTP. This module maps
 * between the two:
 *
 * - {@link outcomeToOptionId} translates the user's chosen outcome to the
 *   daemon `optionId` to vote, driven by each option's ACP **`kind`** (NOT its
 *   opaque id), so it works for any tool's option set.
 * - {@link buildDaemonConfirmation} produces a `confirmationDetails` whose
 *   `onConfirm` performs that mapping and posts the vote.
 *
 * Option `kind`s are the ACP set built in
 * `packages/cli/src/acp-integration/session/permissionUtils.ts`
 * (`allow_once` / `allow_always` / `reject_once` / `reject_always`).
 */
import {
  ToolConfirmationOutcome,
  type ToolCallConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import type { PendingPermission } from './projectDaemonEvent.js';

type OptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

/**
 * Map an in-process {@link ToolConfirmationOutcome} to the daemon `optionId` to
 * vote, by matching the desired ACP `kind` against the gate's options (first
 * match wins, in preference order). Returns `null` when no suitable option
 * exists — the caller then sends a plain `{ outcome: cancelled }` decline.
 */
export function outcomeToOptionId(
  outcome: ToolConfirmationOutcome,
  options: PendingPermission['options'],
): string | null {
  const find = (...kinds: OptionKind[]): string | null => {
    for (const k of kinds) {
      const opt = options.find((o) => o['kind'] === k);
      if (opt) return opt.optionId;
    }
    return null;
  };
  switch (outcome) {
    case ToolConfirmationOutcome.ProceedOnce:
      return find('allow_once', 'allow_always');
    case ToolConfirmationOutcome.ProceedAlways:
    case ToolConfirmationOutcome.ProceedAlwaysProject:
    case ToolConfirmationOutcome.ProceedAlwaysUser:
    case ToolConfirmationOutcome.ProceedAlwaysServer:
    case ToolConfirmationOutcome.ProceedAlwaysTool:
      // The daemon exposes a single `allow_always`; the in-process project/user
      // scope split collapses onto it (scope is enforced daemon-side).
      return find('allow_always', 'allow_once');
    case ToolConfirmationOutcome.Cancel:
    case ToolConfirmationOutcome.ModifyWithEditor:
    case ToolConfirmationOutcome.RestorePrevious:
    default:
      // Modify/Restore have no remote round-trip — treat them as a decline.
      return find('reject_once', 'reject_always');
  }
}

/**
 * Build a `confirmationDetails` for a daemon permission gate. Uses the universal
 * `info` type: every outcome it renders (`ProceedOnce` / `ProceedAlways*` /
 * `Cancel`) maps to a daemon `kind`, and — unlike the `edit` type — it offers no
 * `ModifyWithEditor` (which has no remote equivalent). `respond` posts the vote
 * (the resolved `optionId`, or `null` to decline).
 */
export function buildDaemonConfirmation(
  gate: PendingPermission,
  respond: (optionId: string | null) => Promise<void>,
): ToolCallConfirmationDetails {
  const title = gate.title ?? 'Tool approval requested';
  return {
    type: 'info',
    title,
    prompt: title,
    onConfirm: async (outcome) => {
      await respond(outcomeToOptionId(outcome, gate.options));
    },
  };
}
