/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC, ReactNode } from 'react';
import { createContext, useContext } from 'react';

export type WriteTerminalRaw = (data: string) => void;

const defaultWriteRaw: WriteTerminalRaw = (data) => {
  process.stdout.write(data);
};

const TerminalOutputContext = createContext<WriteTerminalRaw>(defaultWriteRaw);

export const TerminalOutputProvider: FC<{
  value: WriteTerminalRaw;
  children: ReactNode;
}> = ({ value, children }) => (
  <TerminalOutputContext.Provider value={value}>
    {children}
  </TerminalOutputContext.Provider>
);

export function useTerminalOutput(): WriteTerminalRaw {
  return useContext(TerminalOutputContext);
}
