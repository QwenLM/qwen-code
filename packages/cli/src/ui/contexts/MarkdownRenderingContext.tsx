/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

export type MarkdownRenderMode = 'visual' | 'source';

interface MarkdownRenderingContextValue {
  markdownRenderMode: MarkdownRenderMode;
  setMarkdownRenderMode: React.Dispatch<
    React.SetStateAction<MarkdownRenderMode>
  >;
}

const MarkdownRenderingContext =
  React.createContext<MarkdownRenderingContextValue>({
    markdownRenderMode: 'visual',
    setMarkdownRenderMode: () => undefined,
  });

export const MarkdownRenderingProvider = MarkdownRenderingContext.Provider;

export function useMarkdownRendering(): MarkdownRenderingContextValue {
  return React.useContext(MarkdownRenderingContext);
}
