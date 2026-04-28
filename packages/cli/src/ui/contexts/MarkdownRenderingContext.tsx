/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

export type MermaidRenderMode = 'visual' | 'source';

interface MarkdownRenderingContextValue {
  mermaidRenderMode: MermaidRenderMode;
  setMermaidRenderMode: React.Dispatch<React.SetStateAction<MermaidRenderMode>>;
}

const MarkdownRenderingContext =
  React.createContext<MarkdownRenderingContextValue>({
    mermaidRenderMode: 'visual',
    setMermaidRenderMode: () => undefined,
  });

export const MarkdownRenderingProvider = MarkdownRenderingContext.Provider;

export function useMarkdownRendering(): MarkdownRenderingContextValue {
  return React.useContext(MarkdownRenderingContext);
}
