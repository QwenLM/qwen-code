/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV_ENABLE_AGENT_SESSIONS } from '../config/brand.js';
import { isAgentSessionsEnabled } from './agent-session-feature.js';

describe('isAgentSessionsEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is enabled by default', () => {
    vi.stubEnv(ENV_ENABLE_AGENT_SESSIONS, undefined);
    expect(isAgentSessionsEnabled()).toBe(true);
  });

  it('is disabled only by the value 0', () => {
    vi.stubEnv(ENV_ENABLE_AGENT_SESSIONS, '0');
    expect(isAgentSessionsEnabled()).toBe(false);
  });

  it('remains enabled for other values', () => {
    vi.stubEnv(ENV_ENABLE_AGENT_SESSIONS, 'false');
    expect(isAgentSessionsEnabled()).toBe(true);
  });
});
