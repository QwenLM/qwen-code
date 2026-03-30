/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext } from 'react';

interface VerboseModeContextType {
  verboseMode: boolean;
}

const VerboseModeContext = createContext<VerboseModeContextType>({
  verboseMode: false, // default: compact mode
});

export const useVerboseMode = (): VerboseModeContextType =>
  useContext(VerboseModeContext);

export const VerboseModeProvider = VerboseModeContext.Provider;
