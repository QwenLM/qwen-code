/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type { RemoteInputWatcher } from './RemoteInputWatcher.js';

export const RemoteInputContext = createContext<RemoteInputWatcher | null>(
  null,
);
export const useRemoteInput = () => useContext(RemoteInputContext);
