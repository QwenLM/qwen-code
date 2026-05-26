/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { HooksConfigSource } from '@qwen-code/qwen-code-core';
import type { HookConfigDisplayInfo } from './types.js';
import { getTranslatedSourceDisplayMap } from './constants.js';
import { t } from '../../../i18n/index.js';

export function formatSourceLabel(source: HooksConfigSource): string {
  switch (source) {
    case HooksConfigSource.User:
      return t('User');
    case HooksConfigSource.Project:
      return t('Project');
    case HooksConfigSource.System:
      return t('System');
    case HooksConfigSource.Extensions:
      return t('Extension');
    case HooksConfigSource.Session:
      return t('Session');
    default:
      return source;
  }
}

export function formatSourceLabels(configs: HookConfigDisplayInfo[]): string {
  return Array.from(
    new Set(configs.map((config) => formatSourceLabel(config.source))),
  ).join(', ');
}

export function getConfigSourceDisplay(config: {
  source: HooksConfigSource;
  sourceDisplay: string;
}): string {
  const sourceDisplayMap = getTranslatedSourceDisplayMap();
  if (config.source === HooksConfigSource.Extensions) {
    return `${sourceDisplayMap[HooksConfigSource.Extensions]} (${config.sourceDisplay})`;
  }
  return sourceDisplayMap[config.source] || config.source;
}
