/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import type { ModelToolUseBlock } from '../../provider/event/modelCompleteEvent.js';
import { captureMcpToolIdentity } from './mcp-tool-history.js';
import { buildMcpToolName, type McpInfo } from './mcp-tool.js';
import { sanitizeToolName } from '../../utils/tool-name-utils.js';

describe('MCP original names in history', () => {
  it.each([
    ['chinese-demo', '文档格式转换_查询'],
    ['转换服务', 'status'],
    ['转换服务', '文档格式转换_status'],
    ['long-server-'.repeat(8), '文档格式转换_查询'],
  ])(
    'captures the original eager identity for %s/%s without changing dispatch',
    (serverName, toolName) => {
      const mcpInfo = { serverName, toolName };
      const qualifiedName = buildMcpToolName(serverName, toolName);
      const name = sanitizeToolName(qualifiedName);
      const getTool = vi.fn(() => ({ mcpInfo }));
      const config = {
        getToolRegistry: () => ({ getTool }),
      } as unknown as Config;
      const block: ModelToolUseBlock = {
        type: 'tool_use',
        id: 'call',
        name,
        input: { id: 'demo-001' },
      };
      const result = captureMcpToolIdentity(block, config);
      expect(result).toEqual(mcpInfo);
      expect(getTool).toHaveBeenCalledWith(qualifiedName);
      expect(block).not.toHaveProperty('mcpInfo');
      mcpInfo.toolName = 'changed after discovery';
      expect(result).toEqual({ serverName, toolName });
    },
  );

  it('captures lazy names from discovery before invocation or approval', () => {
    const mcpInfo = { serverName: '转换服务', toolName: '文档格式转换_提交' };
    const toolName = buildMcpToolName(mcpInfo.serverName, mcpInfo.toolName);
    const lookup = vi.fn(() => mcpInfo);
    const config = {
      getMcpClientManager: () => ({
        getLazyDiscoveredMcpToolByQualifiedName: lookup,
      }),
    } as unknown as Config;
    const block: ModelToolUseBlock = {
      type: 'tool_use',
      id: 'call',
      name: 'mcp_call',
      input: { toolName, arguments: { id: 'demo-001' } },
    };
    expect(captureMcpToolIdentity(block, config)).toEqual(mcpInfo);
    expect(block).not.toHaveProperty('mcpInfo');
    expect(lookup).toHaveBeenCalledWith(toolName);
  });

  it('resolves exposed MCP names through the registry', () => {
    const mcpInfo = { serverName: '转换服务', toolName: '文档格式转换_查询' };
    const getTool = vi.fn((name: string) =>
      name === 'DocQuery' ? { mcpInfo } : undefined,
    );
    const config = {
      getToolRegistry: () => ({ getTool }),
    } as unknown as Config;
    const block: ModelToolUseBlock = {
      type: 'tool_use',
      id: 'exposed-call',
      name: 'DocQuery',
      input: { id: 'demo-001' },
    };
    expect(captureMcpToolIdentity(block, config)).toEqual(mcpInfo);
    expect(block).not.toHaveProperty('mcpInfo');
    expect(getTool).toHaveBeenCalledWith('DocQuery');
  });

  it('retains each captured call identity when discovery changes', () => {
    const mcpInfo = { serverName: '转换服务', toolName: '文档格式转换_查询' };
    const initialIdentity = { ...mcpInfo };
    const getTool = vi.fn(() => ({ mcpInfo }));
    const config = {
      getToolRegistry: () => ({ getTool }),
    } as unknown as Config;
    const capturedIdentities = new Map<string, McpInfo>();
    const block: ModelToolUseBlock = {
      type: 'tool_use',
      id: 'first-call',
      name: 'DocQuery',
      input: { id: 'demo-001' },
    };
    captureMcpToolIdentity(block, config, capturedIdentities);
    mcpInfo.toolName = '替换后的工具';
    expect(
      captureMcpToolIdentity(block, config, capturedIdentities),
    ).toEqual(initialIdentity);
    expect(captureMcpToolIdentity(block, undefined, capturedIdentities)).toEqual(
      initialIdentity,
    );
    expect(getTool).toHaveBeenCalledTimes(1);

    const nextCall = { ...block, id: 'second-call' };
    expect(
      captureMcpToolIdentity(nextCall, config, capturedIdentities),
    ).toEqual(mcpInfo);
    // A new model request can reuse an ID without inheriting the previous snapshot.
    expect(
      captureMcpToolIdentity(block, config, new Map()),
    ).toEqual(mcpInfo);
    expect(block).not.toHaveProperty('mcpInfo');
  });

  it('keeps unknown, ASCII and built-in calls unchanged', () => {
    const getTool = vi.fn((name: string) =>
      name === 'mcp__demo__query'
        ? { mcpInfo: { serverName: 'demo', toolName: 'query' } }
        : undefined,
    );
    const config = {
      getToolRegistry: () => ({ getTool }),
    } as unknown as Config;
    for (const name of [
      'mcp__demo__query',
      'mcp__demo__u_unknown',
      'mcp_call',
      'Read',
    ]) {
      const block: ModelToolUseBlock = {
        type: 'tool_use',
        id: 'call',
        name,
        input: {},
      };
      expect(captureMcpToolIdentity(block, config)).toBeUndefined();
      expect(block).not.toHaveProperty('mcpInfo');
    }
  });
});
