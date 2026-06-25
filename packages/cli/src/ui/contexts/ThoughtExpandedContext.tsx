/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';

const ThoughtExpandedContext = createContext(false);

export const useThoughtExpanded = (): boolean =>
  useContext(ThoughtExpandedContext);

export const ThoughtExpandedProvider = ThoughtExpandedContext.Provider;
