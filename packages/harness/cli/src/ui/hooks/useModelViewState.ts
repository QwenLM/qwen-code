/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import {
  type Config,
  CoreEvent,
  coreEvents,
  type ReasoningEffortLevel,
} from '@qwen-code/core';
import {
  getPreferredContextWindow,
  getPreferredReasoningEffort,
} from '../../utils/modelPreference.js';
import { useModel } from '../contexts/ConfigContext.js';

export interface UseModelViewStateReturn {
  currentModel: string;
  setCurrentModel: (model: string) => void;
  currentReasoningEffort: ReasoningEffortLevel | undefined;
  setCurrentReasoningEffort: (
    reasoningEffort: ReasoningEffortLevel | undefined,
  ) => void;
  currentContextWindow: number | undefined;
  setCurrentContextWindow: (contextWindow: number | undefined) => void;
}

/**
 * Owns model selection and effort state with the matching CoreEvent listeners.
 *
 * - currentModel stays in sync with `CoreEvent.ModelChanged` and is also
 *   writable so the remote session controller can mirror the controller's
 *   active model.
 */
export function useModelViewState(config: Config): UseModelViewStateReturn {
  const [currentModel, setCurrentModel] = useState(config.getModel());
  const listed = useModel(config);
  const [currentReasoningEffort, setCurrentReasoningEffort] = useState(
    getPreferredReasoningEffort(config, listed),
  );
  const [currentContextWindow, setCurrentContextWindow] = useState(
    getPreferredContextWindow(config, listed),
  );

  useEffect(() => {
    const refreshModelSnapshot = () => {
      setCurrentModel(config.getModel());
      const model = listed?.key === config.getModel() ? listed : undefined;
      setCurrentReasoningEffort(getPreferredReasoningEffort(config, model));
      setCurrentContextWindow(getPreferredContextWindow(config, model));
    };
    const handleModelChanged = (payload: { sessionId: string }) => {
      if (payload.sessionId === config.getSessionId()) refreshModelSnapshot();
    };
    const handleModelInfoChanged = refreshModelSnapshot;
    const handleReasoningEffortChanged = (payload: {
      reasoningEffort?: ReasoningEffortLevel;
    }) => {
      setCurrentReasoningEffort(payload.reasoningEffort);
    };
    const handleContextWindowChanged = (payload: {
      contextWindow?: number;
    }) => {
      setCurrentContextWindow(payload.contextWindow);
    };
    coreEvents.on(CoreEvent.ModelChanged, handleModelChanged);
    coreEvents.on(CoreEvent.ModelInfoChanged, handleModelInfoChanged);
    coreEvents.on(
      CoreEvent.ReasoningEffortChanged,
      handleReasoningEffortChanged,
    );
    coreEvents.on(CoreEvent.ContextWindowChanged, handleContextWindowChanged);
    return () => {
      coreEvents.off(CoreEvent.ModelChanged, handleModelChanged);
      coreEvents.off(CoreEvent.ModelInfoChanged, handleModelInfoChanged);
      coreEvents.off(
        CoreEvent.ReasoningEffortChanged,
        handleReasoningEffortChanged,
      );
      coreEvents.off(
        CoreEvent.ContextWindowChanged,
        handleContextWindowChanged,
      );
    };
  }, [config, listed]);

  useEffect(() => {
    const model = listed;
    setCurrentModel(config.getModel());
    setCurrentReasoningEffort(getPreferredReasoningEffort(config, model));
    setCurrentContextWindow(getPreferredContextWindow(config, model));
  }, [config, listed]);

  return {
    currentModel,
    setCurrentModel,
    currentReasoningEffort,
    setCurrentReasoningEffort,
    currentContextWindow,
    setCurrentContextWindow,
  };
}
