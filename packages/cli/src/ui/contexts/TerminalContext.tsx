/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useStdinInternal, useStdout } from 'ink';
import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useRef,
} from 'react';
import { oscColor } from '../../ink/terminal-querier.js';
import { TerminalCapabilityManager } from '../utils/terminalCapabilityManager.js';

export type TerminalEventHandler = (event: string) => void;

interface TerminalContextValue {
  subscribe: (handler: TerminalEventHandler) => void;
  unsubscribe: (handler: TerminalEventHandler) => void;
  queryTerminalBackground: () => Promise<void>;
}

const TerminalContext = createContext<TerminalContextValue | undefined>(
  undefined,
);

export function useTerminalContext() {
  const context = useContext(TerminalContext);
  if (!context) {
    throw new Error(
      'useTerminalContext must be used within a TerminalProvider',
    );
  }
  return context;
}

export function TerminalProvider({ children }: { children: React.ReactNode }) {
  const { internal_querier } = useStdinInternal();
  const { stdout } = useStdout();
  const subscribers = useRef<Set<TerminalEventHandler>>(new Set()).current;

  const subscribe = useCallback(
    (handler: TerminalEventHandler) => {
      subscribers.add(handler);
    },
    [subscribers],
  );

  const unsubscribe = useCallback(
    (handler: TerminalEventHandler) => {
      subscribers.delete(handler);
    },
    [subscribers],
  );

  const queryTerminalBackground = useCallback(
    async () => {
      if (!internal_querier) {
        TerminalCapabilityManager.queryBackgroundColor(stdout);
        return;
      }

      const [response] = await Promise.all([
        internal_querier.send(oscColor(11)),
        internal_querier.flush(),
      ]);
      if (response) {
        for (const handler of subscribers) handler(response.data);
      }
    },
    [internal_querier, stdout, subscribers],
  );

  return (
    <TerminalContext.Provider
      value={{ subscribe, unsubscribe, queryTerminalBackground }}
    >
      {children}
    </TerminalContext.Provider>
  );
}
