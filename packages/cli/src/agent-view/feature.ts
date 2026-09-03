/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { FatalError } from '@qwen-code/qwen-code-core';
import { loadSettings } from '../config/settings.js';
import type { Settings } from '../config/settingsSchema.js';

export const AGENT_VIEW_DISABLED_MESSAGE =
  'Agent View is disabled. Set `experimental.agentView` to `true` in settings to enable it.';

export function isAgentViewEnabled(settings: Settings): boolean {
  return settings.experimental?.agentView === true;
}

export function requireAgentViewEnabled(settings?: Settings): void {
  if (!isAgentViewEnabled(settings ?? loadSettings().merged)) {
    throw new FatalError(AGENT_VIEW_DISABLED_MESSAGE, 1);
  }
}
