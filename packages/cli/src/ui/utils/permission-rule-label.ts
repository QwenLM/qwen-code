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
