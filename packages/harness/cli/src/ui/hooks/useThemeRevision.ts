/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';
import { themeManager } from '../themes/theme-manager.js';

export function useThemeRevision(): number {
  return useSyncExternalStore(
    themeManager.subscribe,
    themeManager.getSnapshot,
    themeManager.getSnapshot,
  );
}
