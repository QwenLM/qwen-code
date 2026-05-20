/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '../../i18n/index.js';

export function qwenOAuthDiscontinuedMessage(): string {
  return t(
    'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.',
  );
}
