import { describe, expect, it } from 'vitest';
import {
  canAddSelection,
  selectBuiltInTools,
  selectDiscoverableMcpServerNames,
} from './agent-tool-options';

describe('canAddSelection', () => {
  it('allows the same retained select value after its tag is removed', () => {
    const selected = new Set(['read_file']);
    expect(canAddSelection(selected, 'read_file')).toBe(false);
    selected.delete('read_file');
    expect(canAddSelection(selected, 'read_file')).toBe(true);
  });
});

describe('selectBuiltInTools', () => {
  it('excludes disabled and MCP tools from a mixed workspace response', () => {
    const tools = [
      {
        name: 'read_file',
        displayName: 'ReadFile',
        enabled: true,
      },
      {
        name: 'disabled_builtin',
        displayName: 'Disabled',
        enabled: false,
      },
      {
        name: 'mcp__code__search',
        displayName: 'Search',
        enabled: true,
      },
      {
        name: 'legacy_mcp_name',
        displayName: 'Legacy MCP tool',
        enabled: true,
      },
    ];

    expect(
      selectBuiltInTools(tools, {
        code: [
          {
            name: 'legacy_mcp_name',
            serverToolName: 'search',
            isValid: true,
          },
        ],
      }),
    ).toEqual([tools[0]]);
  });
});

describe('selectDiscoverableMcpServerNames', () => {
  it('loads tools only from connected, enabled servers', () => {
    expect(
      selectDiscoverableMcpServerNames([
        {
          name: 'connected',
          disabled: false,
          status: 'ok',
          mcpStatus: 'connected',
        },
        {
          name: 'disconnected',
          disabled: false,
          status: 'error',
          mcpStatus: 'disconnected',
        },
        {
          name: 'disabled',
          disabled: true,
          status: 'ok',
          mcpStatus: 'connected',
        },
        { name: 'legacy', disabled: false, status: 'ok' },
      ]),
    ).toEqual(['connected', 'legacy']);
  });
});
