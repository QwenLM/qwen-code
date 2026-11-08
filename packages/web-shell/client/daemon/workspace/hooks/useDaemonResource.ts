/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useDaemonAvailability,
  useDaemonAvailabilityController,
} from '../../availability-context.js';
import { isDaemonUnavailableError } from '../../availability.js';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  const available = useDaemonAvailability() === 'available';
  const controller = useDaemonAvailabilityController();
  const [state, setState] = useState<ResourceState<T>>({
    data: undefined,
    loading: false,
    error: undefined,
  });
  const requestSeqRef = useRef(0);

  const reload = useCallback(async (): Promise<T | undefined> => {
    if (
      !enabled ||
      !available ||
      (controller && controller.getSnapshot() !== 'available')
    )
      return undefined;
    const seq = ++requestSeqRef.current;
    setState((current) => ({
      ...current,
      loading: true,
      error: undefined,
    }));
    try {
      const data = await load();
      if (seq !== requestSeqRef.current) return undefined;
      setState({ data, loading: false, error: undefined });
      return data;
    } catch (error) {
      if (seq !== requestSeqRef.current) return undefined;
      if (
        isDaemonUnavailableError(error) ||
        (controller && controller.getSnapshot() !== 'available')
      ) {
        setState((current) => ({ ...current, loading: false }));
        return undefined;
      }
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      setState((current) => ({
        ...current,
        loading: false,
        error: normalized,
      }));
      return undefined;
    }
  }, [available, controller, enabled, load]);

  useEffect(() => {
    if (!autoLoad || !enabled) return;
    void reload();
  }, [autoLoad, enabled, reload]);

  return {
    ...state,
    reload,
  };
}
