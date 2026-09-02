/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI MCP dialog reproduces the original ink
 * MCPManagementDialog content: status icons/colors, source grouping order,
 * the approval/auth status-text overrides, the conditional detail actions,
 * per-step footers, and the clamp (non-wrap) list navigation.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import { MCPServerStatus } from '@qwen-code/qwen-code-core';
import {
  buildMcpServerActions,
  clampNavIndex,
  groupMcpServersBySource,
  MCP_MANAGEMENT_STEPS,
  mcpServerRowColor,
  mcpServerStatusText,
  mcpSourceDisplayName,
  mcpStatusColor,
  mcpStatusIcon,
  mcpStepFooter,
  type McpServerInfo,
} from './dialogs-mcp.js';

function server(overrides: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    name: 'srv',
    status: MCPServerStatus.CONNECTED,
    source: 'user',
    toolCount: 0,
    invalidToolCount: 0,
    promptCount: 0,
    resourceCount: 0,
    isDisabled: false,
    hasOAuthTokens: false,
    requiresAuth: false,
    ...overrides,
  };
}

describe('status icon/color parity', () => {
  it('maps connection states to the original glyphs', () => {
    expect(mcpStatusIcon('connected')).toBe('✓');
    expect(mcpStatusIcon('connecting')).toBe('…');
    expect(mcpStatusIcon('disconnected')).toBe('✗');
    expect(mcpStatusIcon('unknown')).toBe('?');
  });

  it('maps connection states to the original colors', () => {
    expect(mcpStatusColor('connected')).toBe('green');
    expect(mcpStatusColor('connecting')).toBe('yellow');
    expect(mcpStatusColor('disconnected')).toBe('red');
    expect(mcpStatusColor('other')).toBe('gray');
  });
});

describe('mcpSourceDisplayName', () => {
  it('uses the original group names', () => {
    expect(mcpSourceDisplayName('user')).toBe('User MCPs');
    expect(mcpSourceDisplayName('project')).toBe('Project MCPs');
    expect(mcpSourceDisplayName('workspace')).toBe('Workspace Settings');
    expect(mcpSourceDisplayName('system')).toBe('System Settings');
    expect(mcpSourceDisplayName('extension')).toBe('Extension MCPs');
    expect(mcpSourceDisplayName('weird')).toBe('weird');
  });
});

describe('groupMcpServersBySource', () => {
  it('groups in SOURCE_ORDER regardless of input order', () => {
    const groups = groupMcpServersBySource([
      server({ name: 'ext', source: 'extension' }),
      server({ name: 'u1', source: 'user' }),
      server({ name: 'p1', source: 'project' }),
      server({ name: 'u2', source: 'user' }),
    ]);
    expect(groups.map((g) => g.source)).toEqual([
      'user',
      'project',
      'extension',
    ]);
    expect(groups[0].servers.map((s) => s.name)).toEqual(['u1', 'u2']);
  });

  it('omits empty sources', () => {
    expect(groupMcpServersBySource([])).toEqual([]);
  });
});

describe('mcpServerStatusText', () => {
  it('prefers the disabled marker', () => {
    expect(mcpServerStatusText(server({ isDisabled: true }))).toBe('disabled');
  });

  it('shows approval states before auth', () => {
    expect(
      mcpServerStatusText(
        server({ approvalState: 'pending', requiresAuth: true }),
      ),
    ).toBe('needs approval');
    expect(
      mcpServerStatusText(
        server({ approvalState: 'rejected', requiresAuth: true }),
      ),
    ).toBe('rejected — edit config to re-approve');
  });

  it('shows needs authentication for unconnected auth-required servers', () => {
    expect(
      mcpServerStatusText(
        server({
          status: MCPServerStatus.DISCONNECTED,
          requiresAuth: true,
        }),
      ),
    ).toBe('needs authentication');
  });

  it('falls back to the raw status once connected', () => {
    expect(
      mcpServerStatusText(
        server({ status: MCPServerStatus.CONNECTED, requiresAuth: true }),
      ),
    ).toBe('connected');
  });

  it('colors approval/auth/disabled rows yellow', () => {
    expect(mcpServerRowColor(server({ isDisabled: true }))).toBe('yellow');
    expect(mcpServerRowColor(server({ approvalState: 'pending' }))).toBe(
      'yellow',
    );
    expect(
      mcpServerRowColor(
        server({ status: MCPServerStatus.DISCONNECTED, requiresAuth: true }),
      ),
    ).toBe('yellow');
    expect(mcpServerRowColor(server())).toBe('green');
    expect(
      mcpServerRowColor(server({ status: MCPServerStatus.DISCONNECTED })),
    ).toBe('red');
  });
});

describe('buildMcpServerActions', () => {
  it('offers browse + toggle + authenticate for a healthy server', () => {
    const actions = buildMcpServerActions(
      server({ toolCount: 2, resourceCount: 1 }),
      { resourcesSupported: true },
    );
    expect(actions.map((a) => a.key)).toEqual([
      'view-tools',
      'view-resources',
      'toggle-disable',
      'authenticate',
    ]);
  });

  it('adds reconnect when disconnected (and not awaiting approval)', () => {
    const actions = buildMcpServerActions(
      server({ status: MCPServerStatus.DISCONNECTED }),
    );
    expect(actions.map((a) => a.key)).toEqual([
      'reconnect',
      'toggle-disable',
      'authenticate',
    ]);
  });

  it('offers approve when pending and hides reconnect/authenticate', () => {
    const actions = buildMcpServerActions(
      server({ approvalState: 'pending' }),
      { approveSupported: true },
    );
    expect(actions.map((a) => a.key)).toEqual(['approve', 'toggle-disable']);
  });

  it('offers only Enable for a disabled server', () => {
    const actions = buildMcpServerActions(server({ isDisabled: true }));
    expect(actions).toEqual([
      { key: 'toggle-disable', label: 'Enable', action: 'toggle-disable' },
    ]);
  });

  it('uses Re-authenticate + Clear Authentication when tokens exist', () => {
    const actions = buildMcpServerActions(server({ hasOAuthTokens: true }));
    expect(actions.map((a) => a.label)).toContain('Re-authenticate');
    expect(actions.map((a) => a.label)).toContain('Clear Authentication');
  });

  it('hides resources unless the caller supports them', () => {
    const actions = buildMcpServerActions(server({ resourceCount: 3 }));
    expect(actions.some((a) => a.key === 'view-resources')).toBe(false);
  });
});

describe('mcpStepFooter', () => {
  it('uses the original per-step hints', () => {
    expect(mcpStepFooter(MCP_MANAGEMENT_STEPS.SERVER_LIST, 0)).toBe(
      'Esc to close',
    );
    expect(mcpStepFooter(MCP_MANAGEMENT_STEPS.SERVER_LIST, 2)).toBe(
      '↑↓ to navigate · Enter to select · Esc to close',
    );
    expect(mcpStepFooter(MCP_MANAGEMENT_STEPS.SERVER_DETAIL, 2)).toBe(
      '↑↓ to navigate · Enter to select · Esc to back',
    );
    expect(mcpStepFooter(MCP_MANAGEMENT_STEPS.TOOL_DETAIL, 2)).toBe(
      'Esc to back',
    );
    expect(mcpStepFooter(MCP_MANAGEMENT_STEPS.AUTHENTICATE, 2)).toBe(
      'Esc to go back',
    );
  });
});

describe('clampNavIndex', () => {
  it('clamps instead of wrapping — MCP lists are not circular', () => {
    expect(clampNavIndex(0, 3, 'up')).toBe(0);
    expect(clampNavIndex(2, 3, 'down')).toBe(2);
    expect(clampNavIndex(0, 3, 'down')).toBe(1);
    expect(clampNavIndex(2, 3, 'up')).toBe(1);
  });
});
