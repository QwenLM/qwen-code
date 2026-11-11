/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { enCommon } from './common.js';
import { enCommands } from './commands.js';
import { enHelp } from './help.js';
import { enHome } from './home.js';
import { enModels } from './models.js';
import { enSettings } from './settings.js';
import { enSession } from './session.js';
import { enShortcuts } from './shortcuts.js';
import { enStatus } from './status.js';
import { enTrustPrivacy } from './trustPrivacy.js';
import { enUsage } from './usage.js';

export const enCatalog = {
  ...enCommon,
  ...enCommands,
  ...enHelp,
  ...enHome,
  ...enModels,
  ...enSettings,
  ...enSession,
  ...enShortcuts,
  ...enStatus,
  ...enTrustPrivacy,
  ...enUsage,
} as const;
