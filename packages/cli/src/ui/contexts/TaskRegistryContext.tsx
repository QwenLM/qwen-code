/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { createContext, useContext } from 'react';
import type { TaskRegistry } from '@qwen-code/core';

const TaskRegistryContext = createContext<TaskRegistry | null>(null);

export interface TaskRegistryProviderProps {
  registry: TaskRegistry;
  children: React.ReactNode;
}

export const TaskRegistryProvider: React.FC<TaskRegistryProviderProps> = ({
  registry,
  children,
}) => (
    <TaskRegistryContext.Provider value={registry}>
      {children}
    </TaskRegistryContext.Provider>
  );

export function useTaskRegistry(): TaskRegistry | null {
  return useContext(TaskRegistryContext);
}
