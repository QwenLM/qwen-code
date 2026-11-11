/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PermissionManager } from '@qwen-code/core';

/** 测试用进程级 manager：没有 framework 时自行 new + initialize。 */
export function createTestPermissionManager(): PermissionManager {
  const manager = new PermissionManager();
  manager.initialize();
  return manager;
}
