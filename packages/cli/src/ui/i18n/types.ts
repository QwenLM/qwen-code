/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { enCatalog } from './locales/en/index.js';

export type UiMessageKey = keyof typeof enCatalog;
export type { MessageParams, UiLanguagePreference } from '@qwen-code/core';
