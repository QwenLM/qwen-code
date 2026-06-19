/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext } from 'react';
import type { DaemonSessionDriver } from './useDaemonStream.js';

/**
 * Provides the attached daemon session driver to `useDaemonStreamAdapter`.
 * `DaemonAppContainer` sets it after `createOrAttach` resolves; it is `null` in
 * the normal in-process path (where the adapter is never used).
 */
export const DaemonStreamContext = createContext<DaemonSessionDriver | null>(
  null,
);
