/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createContext, useContext } from 'react';
import { BUILTIN_COMMAND_DESCRIPTION_KEYS } from '../i18n/commandText.js';

/** Product text mappings are data owned by the selected UI root. */
export const CommandDescriptionContext = createContext<
  Readonly<Record<string, string>>
>(BUILTIN_COMMAND_DESCRIPTION_KEYS);
export function useCommandDescriptionKeys() {
  return useContext(CommandDescriptionContext);
}
