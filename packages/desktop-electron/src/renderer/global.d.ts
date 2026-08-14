/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QwenDesktopBridge } from '../shared/types';

declare global {
  interface Window {
    qwenDesktop: QwenDesktopBridge;
  }
}

export {};
