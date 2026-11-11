/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expectTypeOf, it } from 'vitest';
import type { MergedSettings } from '@qwen-code/resource';
import type {
  AgentOverride,
  CustomTheme,
  ModelPreferenceEntry,
} from './config.js';
import type { MCPServerConfig } from '../mcp/mcpServerConfig.js';
import type { JudgmentSettings } from '../judgment/settings.js';

// The settings boundary describes data; Core owns runtime/domain definitions.
// Keep these contracts assignable in both directions as either side evolves.
it('preserves Settings compatibility with Core domain types', () => {
  expectTypeOf<
    MergedSettings['mcpServers'][string]
  >().toEqualTypeOf<MCPServerConfig>();
  expectTypeOf<
    MergedSettings['agents']['overrides'][string]
  >().toEqualTypeOf<AgentOverride>();
  expectTypeOf<
    MergedSettings['ui']['customThemes'][string]
  >().toEqualTypeOf<CustomTheme>();
  expectTypeOf<
    NonNullable<MergedSettings['model']['preferences']>[string]
  >().toEqualTypeOf<ModelPreferenceEntry>();
  expectTypeOf<
    NonNullable<MergedSettings['judgment']>
  >().toEqualTypeOf<JudgmentSettings>();
});
