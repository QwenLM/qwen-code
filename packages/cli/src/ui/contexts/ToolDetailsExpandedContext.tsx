/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';

export interface ToolDetailsExpandedValue {
  expandedBatchIds: ReadonlySet<string>;
  expandBatch: (batchId: string) => void;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

const ToolDetailsExpandedContext = createContext<ToolDetailsExpandedValue>({
  expandedBatchIds: EMPTY_IDS,
  expandBatch: () => {},
});

export const useToolDetailsExpanded = (): ToolDetailsExpandedValue =>
  useContext(ToolDetailsExpandedContext);

export const ToolDetailsExpandedProvider = ToolDetailsExpandedContext.Provider;
