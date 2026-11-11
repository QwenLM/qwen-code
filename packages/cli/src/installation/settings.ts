/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/** Narrow live settings used by install/update code; no TUI or Config dependency. */
export interface InstallationSettings {
  merged: {
    general: {
      enableAutoUpdate?: boolean;
      enableAutoUpdateNotification?: boolean;
    };
  };
}
