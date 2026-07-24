/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';

export const VirtualViewportContext = createContext<boolean | undefined>(
  undefined,
);

export function useVirtualViewport(fallback?: boolean): boolean {
  return useContext(VirtualViewportContext) ?? fallback ?? false;
}
