/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState } from 'react';
import type { ViewLevel } from './AuthFlowTypes.js';

export interface AuthDialogNavigation {
  currentView: ViewLevel;
  pushView: (view: ViewLevel) => void;
  replaceView: (view: ViewLevel) => void;
  goBack: () => void;
}

export function useAuthDialogNavigation(
  initialView: ViewLevel,
): AuthDialogNavigation {
  const [viewStack, setViewStack] = useState<ViewLevel[]>([initialView]);

  const pushView = useCallback((view: ViewLevel) => {
    setViewStack((current) => [...current, view]);
  }, []);

  const replaceView = useCallback((view: ViewLevel) => {
    setViewStack((current) => [...current.slice(0, -1), view]);
  }, []);

  const goBack = useCallback(() => {
    setViewStack((current) =>
      current.length > 1 ? current.slice(0, -1) : current,
    );
  }, []);

  return {
    currentView: viewStack[viewStack.length - 1] || initialView,
    pushView,
    replaceView,
    goBack,
  };
}
