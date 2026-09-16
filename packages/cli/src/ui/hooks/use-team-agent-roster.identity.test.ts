/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { useTeamAgentRoster } from './use-team-agent-roster.js';

/**
 * The roster feeds `LiveAgentPanel`, which keys its one-second elapsed-time
 * interval on the array identity. A fresh array per render tears that
 * interval down and recreates it before it can fire, so elapsed times stop
 * advancing — and the no-team path runs for every user, not just teams.
 */
describe('useTeamAgentRoster identity', () => {
  it('keeps the same array across renders when no team is active', () => {
    const registeredAgents = new Map<string, unknown>();
    const { result, rerender } = renderHook(() =>
      useTeamAgentRoster(null, registeredAgents),
    );

    const first = result.current;
    rerender();
    rerender();

    expect(result.current).toHaveLength(0);
    expect(result.current).toBe(first);
  });

  it('keeps the same array across renders when the config has no team', () => {
    const config = {
      onTeamManagerChange: () => {},
      getTeamManager: () => null,
    } as unknown as Config;
    const registeredAgents = new Map<string, unknown>();
    const { result, rerender } = renderHook(() =>
      useTeamAgentRoster(config, registeredAgents),
    );

    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });
});
