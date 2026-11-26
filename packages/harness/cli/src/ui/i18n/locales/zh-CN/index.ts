/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UiMessageKey } from '../../types.js';
import { zhCNCommon } from './common.js';
import { zhCNCommands } from './commands.js';
import { zhCNHelp } from './help.js';
import { zhCNHome } from './home.js';
import { zhCNModels } from './models.js';
import { zhCNSettings } from './settings.js';
import { zhCNSession } from './session.js';
import { zhCNShortcuts } from './shortcuts.js';
import { zhCNStatus } from './status.js';
import { zhCNTrustPrivacy } from './trustPrivacy.js';
import { zhCNUsage } from './usage.js';

export const zhCNCatalog = {
  ...zhCNCommon,
  ...zhCNCommands,
  ...zhCNHelp,
  ...zhCNHome,
  ...zhCNModels,
  ...zhCNSettings,
  ...zhCNSession,
  ...zhCNShortcuts,
  ...zhCNStatus,
  ...zhCNTrustPrivacy,
  ...zhCNUsage,
} as const satisfies Record<UiMessageKey, string>;
