/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

export type RenderMode = 'render' | 'raw';

interface RenderModeContextValue {
  renderMode: RenderMode;
  setRenderMode: React.Dispatch<React.SetStateAction<RenderMode>>;
}

const RenderModeContext = React.createContext<RenderModeContextValue>({
  renderMode: 'render',
  setRenderMode: () => undefined,
});

export const RenderModeProvider = RenderModeContext.Provider;

export function useRenderMode(): RenderModeContextValue {
  return React.useContext(RenderModeContext);
}
