/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { createContext, useContext, useState, useEffect } from 'react';
import type { ModeDefinition } from '@qwen-code/modes';
import type { Config } from '@qwen-code/qwen-code-core';

interface WorkModeContextValue {
  currentWorkMode: ModeDefinition | null;
  setCurrentWorkMode: (mode: ModeDefinition) => void;
}

const WorkModeContext = createContext<WorkModeContextValue | undefined>(undefined);

interface WorkModeProviderProps {
  children: React.ReactNode;
  config: Config;
}

export const WorkModeProvider: React.FC<WorkModeProviderProps> = ({
  children,
  config,
}) => {
  const [currentWorkMode, setCurrentWorkMode] = useState<ModeDefinition | null>(() => {
    const modeManager = config.getModeManager();
    return modeManager?.getCurrentMode() || null;
  });

  // Sync with external mode changes
  useEffect(() => {
    const modeManager = config.getModeManager();
    if (modeManager) {
      const mode = modeManager.getCurrentMode();
      setCurrentWorkMode(mode);
    }
  }, [config]);

  const value: WorkModeContextValue = {
    currentWorkMode,
    setCurrentWorkMode,
  };

  return (
    <WorkModeContext.Provider value={value}>
      {children}
    </WorkModeContext.Provider>
  );
};

export const useWorkMode = (): WorkModeContextValue => {
  const context = useContext(WorkModeContext);
  if (context === undefined) {
    throw new Error('useWorkMode must be used within a WorkModeProvider');
  }
  return context;
};
