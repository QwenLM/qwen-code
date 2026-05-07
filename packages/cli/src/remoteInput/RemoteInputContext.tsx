/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type {
  ConfirmationHandler,
  ControlHandler,
  SubmitFn,
} from './RemoteInputWatcher.js';

export interface RemoteInputController {
  setSubmitFn(fn: SubmitFn): void;
  setConfirmationHandler(fn: ConfirmationHandler): void;
  setControlHandler(fn: ControlHandler): void;
  notifyIdle(): void;
}

export const RemoteInputContext = createContext<RemoteInputController | null>(
  null,
);
export const useRemoteInput = () => useContext(RemoteInputContext);
