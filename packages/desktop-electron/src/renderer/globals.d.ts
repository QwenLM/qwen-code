/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QwenCodePetApi } from '../shared/desktop-api';

declare global {
  interface Window {
    qwenCodePet?: QwenCodePetApi;
  }
}

export {};
