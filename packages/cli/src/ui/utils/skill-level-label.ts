/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SkillLevel } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

export function levelLabel(level: SkillLevel): string {
  switch (level) {
    case 'project':
      return t('Project');
    case 'user':
      return t('User');
    case 'extension':
      return t('Extension');
    case 'bundled':
      return t('Bundled');
    default:
      return level;
  }
}
