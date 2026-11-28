/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// CLI 在解析进程配置前就要运行守护进程源码，不能经过 Core 主入口加载整个包。
export { DETACHED_PROCESS_GUARD_SOURCE } from './src/services/detachedProcessGuard.js';
