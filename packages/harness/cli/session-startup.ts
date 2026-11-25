/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 非交互会话的启动接缝：认证生命周期任务、中途输出 drain 与 headless 协议输出。
 * 开放实现不消费这些能力；产品入口（如 的 headless 会话）在自己的
 * 会话实现里组合它们。产品认证校验与未登录退出由产品包实现。
 */

export { runAfterAuthAttemptStartup } from './src/core/startupLifecycle.js';
export { initializeOutputListenersAndFlush } from './src/utils/outputListeners.js';
export { runExitCleanupWithTimeout } from './src/utils/cleanup.js';
export {
  emitResultErrorOutputWithSession,
  formatAuthenticationErrorMessage,
  handleErrorWithOutput,
} from './src/utils/errors.js';
export {
  buildStreamJsonInitMessage,
  buildSyntheticAssistantErrorMessage,
  buildSyntheticErrorResultMessage,
} from './src/utils/nonInteractiveOutput.js';
