/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext, type ReactNode } from 'react';

export interface DaemonStatusCardRenderers {
  readonly renderMcpStatus?: (content: string) => ReactNode;
  readonly renderTasksStatus?: (content: string) => ReactNode;
}

export const DaemonStatusCardsContext =
  createContext<DaemonStatusCardRenderers>({});

export function useDaemonStatusCards(): DaemonStatusCardRenderers {
  return useContext(DaemonStatusCardsContext);
}
