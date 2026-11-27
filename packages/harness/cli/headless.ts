/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Headless 产品扩展面：无登录基类、参数与启动失败收尾信号。 */
export {
  HeadlessSession,
  type HeadlessSessionParams,
} from './src/headless/headlessSession.js';
export { HeadlessStartupAbort } from './src/headless/exit.js';
