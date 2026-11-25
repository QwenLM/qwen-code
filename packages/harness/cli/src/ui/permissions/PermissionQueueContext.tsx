/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * React context for the permission queue store.
 *
 * Provides the PermissionQueueStore to the component tree so any
 * component can subscribe to queue changes via usePermissionQueue.
 */

import type React from 'react';
import { createContext, useContext } from 'react';
import type { PermissionQueueStore } from './permissionQueueStore.js';

const PermissionQueueContext = createContext<PermissionQueueStore | null>(null);

export interface PermissionQueueProviderProps {
  store: PermissionQueueStore;
  children: React.ReactNode;
}

/**
 * Provides the PermissionQueueStore to the React tree.
 */
export const PermissionQueueProvider: React.FC<
  PermissionQueueProviderProps
> = ({ store, children }) => (
  <PermissionQueueContext.Provider value={store}>
    {children}
  </PermissionQueueContext.Provider>
);

/**
 * Returns the PermissionQueueStore from context.
 * Throws if used outside a PermissionQueueProvider.
 */
export function usePermissionQueueStore(): PermissionQueueStore {
  const store = useContext(PermissionQueueContext);
  if (!store) {
    throw new Error(
      'usePermissionQueueStore must be used within a PermissionQueueProvider',
    );
  }
  return store;
}

/**
 * Returns the PermissionQueueStore from context, or null if no provider
 * is present. Safe to call outside a PermissionQueueProvider.
 */
export function useOptionalPermissionQueueStore(): PermissionQueueStore | null {
  return useContext(PermissionQueueContext);
}
