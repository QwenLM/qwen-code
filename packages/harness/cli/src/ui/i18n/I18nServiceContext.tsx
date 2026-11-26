/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, {
  createContext,
  useContext,
  useCallback,
  useSyncExternalStore,
} from 'react';
import type { I18nService } from '@qwen-code/core';

const Context = createContext<I18nService | undefined>(undefined);
export function I18nServiceProvider({
  service,
  children,
}: {
  service: I18nService;
  children: React.ReactNode;
}) {
  return <Context.Provider value={service}>{children}</Context.Provider>;
}

export function useI18nService(): I18nService {
  const service = useContext(Context);
  if (!service)
    throw new Error(
      'useI18nService must be used within an I18nServiceProvider',
    );
  const subscribe = useCallback(
    (listener: () => void) => service.subscribe(listener),
    [service],
  );
  const getSnapshot = useCallback(() => service.getSnapshot(), [service]);
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return service;
}
