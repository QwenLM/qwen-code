/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '../i18n/index.js';
import { commandMetadata } from './command-metadata.js';

export const authCommandMetadata = {
  ...commandMetadata.auth,
  describe: t(commandMetadata.auth.describe),
};
