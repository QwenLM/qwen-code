/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '../../i18n/index.js';

/**
 * One rule row's label. The marker goes first: both dialogs paint rule rows
 * single-line with tail truncation, so as a suffix it is clipped away on a long
 * rule and the row reads as an active rule again.
 */
export function permissionRuleLabel(rule: {
  raw: string;
  invalid?: boolean;
}): string {
  return rule.invalid ? `${t('(unparsable)')} ${rule.raw}` : rule.raw;
}

/**
 * The stored list with the deleted row removed, or `null` when the row is not
 * in it.
 *
 * `parseRule` trims, so a row lists the trimmed text while the settings file
 * may hold a padded entry: compare on the trimmed text or the removal never
 * reaches the file and the rule returns on the next start.
 *
 * Only the first matching entry goes. Two stored spellings can trim to the
 * same rule (a padded one plus an exact one added later), and one delete must
 * not clear both — `PermissionManager.removePersistentRule` also removes the
 * first match only.
 *
 * Non-string entries are kept as they are: settings loading does not validate
 * element types, and they must not be passed to `trim()`.
 */
export function withoutDeletedRule(
  rules: readonly unknown[],
  raw: string,
): unknown[] | null {
  const index = rules.findIndex(
    (rule) => typeof rule === 'string' && rule.trim() === raw,
  );
  if (index === -1) return null;
  return rules.filter((_, i) => i !== index);
}
