/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  DaemonResourceOptions,
  ResourceResult,
  ResourceState,
} from '../types.js';

export function useDaemonResource<T>(
  load: () => Promise<T>,
  options: DaemonResourceOptions,
): ResourceResult<T> {
  const { autoLoad = false, enabled = true } = options;
  const [state, setState] = useState<ResourceState<T>>({
    data: undefined,
    loading: false,
    error: undefined,
  });

  const reload = useCallback(async (): Promise<T | undefined> => {
    if (!enabled) return undefined;
    setState((current) => ({
      ...current,
      loading: true,
      error: undefined,
    }));
    try {
      const data = await load();
      setState({ data, loading: false, error: undefined });
      return data;
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      setState((current) => ({
        ...current,
        loading: false,
        error: normalized,
      }));
      return undefined;
    }
  }, [enabled, load]);

  useEffect(() => {
    if (!autoLoad || !enabled) return;
    void reload();
  }, [autoLoad, enabled, reload]);

  return {
    ...state,
    reload,
  };
}
