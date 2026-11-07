/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';

export const UNSENT_TOOL_RESULT =
  'The tool had already completed; its output was discarded.';

export function hasToolResultPromptHook(config: Config): boolean {
  return (
    !config.getDisableAllHooks?.() &&
    Boolean(config.getMessageBus?.()) &&
    config.hasHooksForEvent?.('UserPromptSubmit') === true
  );
}
