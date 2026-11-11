/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type { BuiltinPluginContributions } from '@qwen-code/core';
import type { LocalSessionHandle } from '../../session/localSession.js';

/** UI 交付当前会话并借用应用展示能力，不接管应用初始化和关闭。 */
export interface CliApplicationView {
  getCliDisplayName(): string;
  getAppPlugins(): BuiltinPluginContributions;
  bindLocalSession?(session: LocalSessionHandle): () => void;
}
export const CliApplicationContext = createContext<
  CliApplicationView | undefined
>(undefined);
export const useCliApplication = () => useContext(CliApplicationContext);
