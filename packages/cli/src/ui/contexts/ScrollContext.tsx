/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';

export interface ScrollActions {
  scrollBy: (delta: number) => void;
}

export const ScrollContext = createContext<ScrollActions | null>(null);

export function useScrollActions(): ScrollActions | null {
  return useContext(ScrollContext);
}
