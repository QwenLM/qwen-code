/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { enUsage } from '../en/usage.js';

export const zhCNUsage = {
  'usage.dedicatedPackages.title': '个人专属资源包',
  'usage.dedicatedPackages.remaining': '剩余 {remaining}',
  'usage.dedicatedPackages.expires': '{date} 到期',
  'usage.dedicatedPackages.available': '可用',
  'usage.dedicatedPackages.unavailable': '不可用',
  'usage.dedicatedPackages.exhausted': '已用尽',
  'usage.dedicatedPackages.expired': '已过期',
  'usage.dedicatedPackages.suspended': '已暂停',
  'usage.dedicatedPackages.applicableModels': '适用模型：{models}',
} as const satisfies Record<keyof typeof enUsage, string>;
