/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReasoningEffort } from '../core/reasoning-effort.js';

export interface ModelPreference {
  reasoning?: { effort?: ReasoningEffort };
  contextWindow?: number;
}

export type ModelPreferences = Readonly<
  Partial<Record<string, ModelPreference>>
>;
