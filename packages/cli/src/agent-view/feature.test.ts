/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { FatalError } from '@qwen-code/qwen-code-core';
import type { Settings } from '../config/settingsSchema.js';
import {
  AGENT_VIEW_DISABLED_MESSAGE,
  isAgentViewEnabled,
  requireAgentViewEnabled,
} from './feature.js';

describe('Agent View feature gate', () => {
  it('is opt-in', () => {
    expect(isAgentViewEnabled({} as Settings)).toBe(false);
    expect(
      isAgentViewEnabled({ experimental: { agentView: true } } as Settings),
    ).toBe(true);
  });

  it('returns one stable enablement hint', () => {
    const invoke = () => requireAgentViewEnabled({} as Settings);

    expect(invoke).toThrow(AGENT_VIEW_DISABLED_MESSAGE);
    expect(invoke).toThrow(FatalError);
  });
});
