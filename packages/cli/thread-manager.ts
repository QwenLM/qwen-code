/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Protocol hosts import this subpath instead of reaching into CLI internals.
export {
  ThreadManager,
  type ThreadManagerEvent,
  type ThreadManagerObserver,
  type ThreadManagerParams,
  type ThreadOpenRequest,
} from './src/thread-manager/threadManager.js';
export type * from './src/thread-manager/thread-session/contract/hostContext.js';
export type { ThreadHostTokenSource } from './src/thread-manager/thread-session/contract/hostTokenSource.js';
export type { SessionQueryRunner } from './src/thread-manager/thread-session/query/sessionQueryRunner.js';
export type * from './src/thread-manager/thread-session/contract/threadSessionTypes.js';
export type { ThreadForkRequest } from './src/thread-manager/thread-session/contract/threadOpenRequest.js';
