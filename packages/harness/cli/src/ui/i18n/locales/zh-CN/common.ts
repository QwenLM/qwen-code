/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { enCommon } from '../en/common.js';

export const zhCNCommon = {
  'common.action.cancel': '取消',
  'common.action.confirm': '确认',
  'common.action.close': '关闭',
  'auth.hint.navigate': '↑/↓ 导航',
  'auth.hint.select': 'Enter 选择',
} as const satisfies Record<keyof typeof enCommon, string>;
