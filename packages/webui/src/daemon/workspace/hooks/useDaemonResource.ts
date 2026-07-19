/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type {
  DaemonResourceOptions,
  ResourceResult,
  ResourceState,
} from '../types.js';

/**
 * `resourceKey` identifies the owner of the state. Render filters state by the
 * proposed key; commit invalidates the previous owner's request.
 */
export function useDaemonResource<T>(
  load: () => Promise<T>,
  options: DaemonResourceOptions,
  resourceKey?: unknown,
): ResourceResult<T> {
  const { autoLoad = false, enabled = true } = options;
  const [state, setState] = useState<{
    key: unknown;
    value: ResourceState<T>;
  }>({
    key: resourceKey,
    value: emptyResourceState(),
  });
  const requestSeqRef = useRef(0);
  const committedResourceKeyRef = useRef(resourceKey);

  useLayoutEffect(() => {
    if (Object.is(committedResourceKeyRef.current, resourceKey)) return;
    committedResourceKeyRef.current = resourceKey;
    requestSeqRef.current++;
  }, [resourceKey]);

  const reload = useCallback(async (): Promise<T | undefined> => {
    if (!Object.is(committedResourceKeyRef.current, resourceKey)) {
      return undefined;
    }
    if (!enabled) return undefined;
    const seq = ++requestSeqRef.current;
    setState((current) => {
      const value = Object.is(current.key, resourceKey)
        ? current.value
        : emptyResourceState<T>();
      return {
        key: resourceKey,
        value: { ...value, loading: true, error: undefined },
      };
    });
    try {
      const data = await load();
      if (seq !== requestSeqRef.current) return undefined;
      setState({
        key: resourceKey,
        value: { data, loading: false, error: undefined },
      });
      return data;
    } catch (error) {
      if (seq !== requestSeqRef.current) return undefined;
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      setState((current) => {
        const value = Object.is(current.key, resourceKey)
          ? current.value
          : emptyResourceState<T>();
        return {
          key: resourceKey,
          value: { ...value, loading: false, error: normalized },
        };
      });
      return undefined;
    }
  }, [enabled, load, resourceKey]);

  useEffect(() => {
    if (!autoLoad || !enabled) return;
    void reload();
  }, [autoLoad, enabled, reload]);

  const value = Object.is(state.key, resourceKey)
    ? state.value
    : emptyResourceState<T>();
  return { ...value, reload };
}

function emptyResourceState<T>(): ResourceState<T> {
  return { data: undefined, loading: false, error: undefined };
}
