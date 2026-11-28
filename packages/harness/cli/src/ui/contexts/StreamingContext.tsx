/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext } from 'react';
import type { StreamingState } from '../types.js';

export const StreamingContext = createContext<StreamingState | undefined>(
  undefined,
);

export const useStreamingContext = (): StreamingState => {
  const context = React.useContext(StreamingContext);
  if (context === undefined) {
    throw new Error(
      'useStreamingContext must be used within a StreamingContextProvider',
    );
  }
  return context;
};
