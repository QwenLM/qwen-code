/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { createContext, useContext } from 'react';
import { defaultKeyMatchers, type KeyMatchers } from '../key/keyMatchers.js';
import {
  defaultKeyBindingConfig,
  type KeyBindingConfig,
} from '../key/keyBindings.js';

export const KeyMatchersContext =
  createContext<KeyMatchers>(defaultKeyMatchers);
export const KeyBindingConfigContext = createContext<KeyBindingConfig>(
  defaultKeyBindingConfig,
);

export const KeyMatchersProvider = ({
  children,
  value,
  config = defaultKeyBindingConfig,
}: {
  children: React.ReactNode;
  value: KeyMatchers;
  config?: KeyBindingConfig;
}): React.JSX.Element => (
  <KeyBindingConfigContext.Provider value={config}>
    <KeyMatchersContext.Provider value={value}>
      {children}
    </KeyMatchersContext.Provider>
  </KeyBindingConfigContext.Provider>
);

/**
 * Hook to retrieve the currently active key matchers.
 * Defaults to defaultKeyMatchers if no provider is present, allowing tests to run without explicit wrappers.
 */
export function useKeyMatchers(): KeyMatchers {
  return useContext(KeyMatchersContext);
}

/** Retrieves the bindings used by the active matcher set for UI hints. */
export function useKeyBindingConfig(): KeyBindingConfig {
  return useContext(KeyBindingConfigContext);
}
