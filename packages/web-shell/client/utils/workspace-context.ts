/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type { DaemonWorkspaceContextValue } from '../daemon/workspace/types.js';

export const WorkspaceRuntimeContext = createContext<
  DaemonWorkspaceContextValue | undefined
>(undefined);

export function useOptionalWorkspaceRuntime():
  | DaemonWorkspaceContextValue
  | undefined {
  return useContext(WorkspaceRuntimeContext);
}
