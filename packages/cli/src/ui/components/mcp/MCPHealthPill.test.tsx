/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getPillLabel } from './MCPHealthPill.js';
import type { MCPHealthSnapshot } from '../../hooks/useMCPHealth.js';

function snapshot(
  overrides: Partial<MCPHealthSnapshot> = {},
): MCPHealthSnapshot {
  return {
    totalCount: 0,
    disconnectedCount: 0,
    connectingCount: 0,
    connectedCount: 0,
    ...overrides,
  };
}

describe('MCPHealthPill / getPillLabel', () => {
  it('returns empty when no servers are configured', () => {
    expect(getPillLabel(snapshot())).toBe('');
  });

  it('returns empty when all servers are connected', () => {
    expect(getPillLabel(snapshot({ totalCount: 2, connectedCount: 2 }))).toBe(
      '',
    );
  });

  it('returns empty when servers are only connecting (transient — not surfaced in v1)', () => {
    expect(getPillLabel(snapshot({ totalCount: 1, connectingCount: 1 }))).toBe(
      '',
    );
  });

  it('uses singular form for one offline server', () => {
    expect(
      getPillLabel(snapshot({ totalCount: 1, disconnectedCount: 1 })),
    ).toBe('1 MCP offline');
  });

  it('uses plural form for multiple offline servers', () => {
    expect(
      getPillLabel(snapshot({ totalCount: 3, disconnectedCount: 3 })),
    ).toBe('3 MCPs offline');
  });

  it('counts only disconnected when mixed with connecting/connected', () => {
    expect(
      getPillLabel(
        snapshot({
          totalCount: 4,
          disconnectedCount: 1,
          connectingCount: 1,
          connectedCount: 2,
        }),
      ),
    ).toBe('1 MCP offline');
  });
});
