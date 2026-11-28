/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

const DialogSizeContext = createContext<{
  columns: number;
  rows: number;
} | null>(null);

export const DialogSizeProvider = DialogSizeContext.Provider;

/** Layout bounds only; pointer coordinates still use the physical terminal. */
export function useDialogSize() {
  const terminal = useTerminalSize();
  const dialog = useContext(DialogSizeContext);
  return { ...(dialog ?? terminal), isDialog: dialog !== null };
}
