/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { lerp } from '../../utils/math.js';
import type { Settings } from '../../config/settings.js';

const TERMINAL_MARGIN = 2;

export const getMainAreaWidthInternal = (terminalWidth: number): number => {
  if (terminalWidth <= 80) {
    return Math.round(0.98 * terminalWidth);
  }
  if (terminalWidth >= 132) {
    return Math.round(0.9 * terminalWidth);
  }

  const t = (terminalWidth - 80) / (132 - 80);
  const percentage = lerp(98, 90, t);

  return Math.round(percentage * terminalWidth * 0.01);
};

export const calculateMainAreaWidth = (
  terminalWidth: number,
  settings: Settings,
): number => {
  if (settings.ui?.useFullWidth !== false) {
    return terminalWidth - TERMINAL_MARGIN;
  }
  return getMainAreaWidthInternal(terminalWidth);
};
