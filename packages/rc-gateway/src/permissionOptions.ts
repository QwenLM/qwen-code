/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Select the option id that grants a permission request for THIS CALL ONLY.
 *
 * A daemon `permission_request` carries an ACP option list whose `kind` is one
 * of `allow_once | allow_always | reject_once | reject_always`. The order is
 * NOT reliable — index 0 is typically an `allow_always`/"Proceed always" option,
 * which (per the daemon) persists a standing allow rule or flips the session to
 * auto-edit mode. Voting that from an automated allow rule (or a one-tap phone
 * approval) would escalate a single sanctioned call into a permanent grant that
 * bypasses all future policy evaluation and audit.
 *
 * So we deliberately pick the `allow_once` option. If none exists (e.g. an older
 * daemon, or an unusual confirmation type), we return `undefined` and the caller
 * MUST fall back to prompting a human — never fabricate or guess a vote.
 */
export function selectAllowOnceOptionId(options: unknown): string | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const opt of options) {
    if (
      opt &&
      typeof opt === 'object' &&
      (opt as { kind?: unknown }).kind === 'allow_once'
    ) {
      const id = (opt as { optionId?: unknown }).optionId;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  }
  return undefined;
}
