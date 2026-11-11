/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderMainMandatoryPrefix } from '../mandatory-prefix.js';
import type { PromptSectionDescriptor } from '../types.js';

export const MANDATORY_SECTIONS: readonly PromptSectionDescriptor[] = [
  {
    id: 'mandatory.core',
    version: 1,
    systemBlock: 'stable',
    order: 0,
    mandatory: true,
    render: () => renderMainMandatoryPrefix(),
  },
];
