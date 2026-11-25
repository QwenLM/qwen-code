/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission queue UI integration.
 *
 * Provides the bridge between the core permission handler chain and
 * the React UI layer:
 * - PermissionQueueStore: observable queue implementing PermissionQueueOps
 * - usePermissionQueue: React hook for subscribing to queue changes
 * - PermissionQueueProvider: React context provider
 */

export type {
  QueueChangeListener,
  PermissionQueueStore,
} from './permissionQueueStore.js';
export { createPermissionQueueStore } from './permissionQueueStore.js';

export {
  usePermissionQueue,
  useOptionalPermissionQueue,
  usePermissionQueueItems,
} from './usePermissionQueue.js';

export {
  PermissionQueueProvider,
  usePermissionQueueStore,
  useOptionalPermissionQueueStore,
} from './PermissionQueueContext.js';
export type { PermissionQueueProviderProps } from './PermissionQueueContext.js';

export { PermissionQueue } from './PermissionQueue.js';
