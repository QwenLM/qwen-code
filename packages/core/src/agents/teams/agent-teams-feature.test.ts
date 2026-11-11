/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV_AGENT_TEAMS, ENV_ENABLE_AGENT_SESSIONS } from '../../config/brand.js';
import {
  deriveSessionTeamName,
  isAgentTeamsEnabled,
  isInProcessTeammateFeatureEnabled,
} from './agent-teams-feature.js';

describe('agent teams feature', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is disabled by default', () => {
    vi.stubEnv(ENV_AGENT_TEAMS, '');

    expect(isAgentTeamsEnabled()).toBe(false);
    expect(isInProcessTeammateFeatureEnabled()).toBe(false);
  });

  it.each(['1', 'true'])('accepts %s as an enabled value', (value) => {
    vi.stubEnv(ENV_AGENT_TEAMS, value);

    expect(isAgentTeamsEnabled()).toBe(true);
    expect(isInProcessTeammateFeatureEnabled()).toBe(true);
  });

  it('requires agent sessions to remain enabled', () => {
    vi.stubEnv(ENV_AGENT_TEAMS, '1');
    vi.stubEnv(ENV_ENABLE_AGENT_SESSIONS, '0');

    expect(isAgentTeamsEnabled()).toBe(true);
    expect(isInProcessTeammateFeatureEnabled()).toBe(false);
  });

  it('uses the same session-derived team identity after resume', () => {
    expect(
      deriveSessionTeamName('1526a591-42e7-43eb-a371-14b709518ccc'),
    ).toBe('session-1526a591');
  });
});
