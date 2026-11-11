/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, {
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  coreEvents,
  CoreEvent,
  runLogger,
  type Config,
  type Model,
} from '@qwen-code/core';

export const ConfigContext = React.createContext<Config | undefined>(undefined);

export const useConfig = () => {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
};

/** A view snapshot of the same provider directory used by inference. */
export function useModelList(
  config: Config | undefined,
  refreshRevision: number,
  initialModels: readonly Model[] = [],
): readonly Model[] {
  const [eventRevision, reload] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    coreEvents.on(CoreEvent.ModelInfoChanged, reload);
    return () => {
      coreEvents.off(CoreEvent.ModelInfoChanged, reload);
    };
  }, []);
  const identity = config?.getModelRequestIdentity();
  const sessionId = config?.getSessionId();
  const [snapshot, setSnapshot] = useState<{
    config: Config;
    identity: string;
    sessionId: string;
    models: readonly Model[];
  }>();
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    void config
      .getModelProviderManager()
      .listModels()
      .then(
        (models) => {
          if (
            !cancelled &&
            identity === config.getModelRequestIdentity() &&
            sessionId === config.getSessionId()
          ) {
            setSnapshot({ config, identity, sessionId, models });
          }
        },
        (error: unknown) =>
          runLogger.debug('[ui] Model list query failed', error),
      );
    return () => {
      cancelled = true;
    };
  }, [config, identity, sessionId, refreshRevision, eventRevision]);
  return snapshot !== undefined &&
    snapshot.config === config &&
    snapshot.identity === identity &&
    snapshot.sessionId === sessionId
    ? snapshot.models
    : initialModels;
}

// 只持有组件展示状态；目录缓存和刷新仍由所属会话的 provider 管理。
export function useModel(config: Config, modelKey?: string): Model | undefined {
  const [eventRevision, reload] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const onModelChanged = (event: { sessionId: string }) => {
      if (event.sessionId === config.getSessionId()) reload();
    };
    coreEvents.on(CoreEvent.ModelChanged, onModelChanged);
    coreEvents.on(CoreEvent.ModelInfoChanged, reload);
    return () => {
      coreEvents.off(CoreEvent.ModelChanged, onModelChanged);
      coreEvents.off(CoreEvent.ModelInfoChanged, reload);
    };
  }, [config]);
  const key = modelKey ?? config.getModel();
  const identity = config.getModelRequestIdentity();
  const sessionId = config.getSessionId();
  const current = useRef({ config, key, identity, sessionId });
  current.current = { config, key, identity, sessionId };
  const [resolved, setResolved] = useState<{
    config: Config;
    key: string;
    identity: string;
    sessionId: string;
    model: Model | undefined;
  }>();
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const load = async () => {
      const request = ++revision;
      const requestKey = modelKey ?? config.getModel();
      const requestIdentity = config.getModelRequestIdentity();
      const requestSessionId = config.getSessionId();
      let model: Model | undefined;
      try {
        const manager = config.getModelProviderManager();
        model = requestKey
          ? await manager.getModel(requestKey)
          : (await manager.listModels()).find(
              (entry) => entry.isDefault === true && entry.enabled !== false,
            );
      } catch (error) {
        runLogger.debug('[ui] 模型展示查询失败:', error);
      }
      if (
        disposed ||
        request !== revision ||
        current.current.config !== config ||
        current.current.key !== requestKey ||
        requestIdentity !== config.getModelRequestIdentity() ||
        requestSessionId !== config.getSessionId()
      )
        return;
      setResolved({
        config,
        key: requestKey,
        identity: requestIdentity,
        sessionId: requestSessionId,
        model,
      });
    };
    void load();
    return () => {
      disposed = true;
      revision++;
    };
  }, [config, key, identity, sessionId, modelKey, eventRevision]);
  return resolved?.config === config &&
    resolved.key === key &&
    resolved.identity === identity &&
    resolved.sessionId === sessionId
    ? resolved.model
    : undefined;
}
