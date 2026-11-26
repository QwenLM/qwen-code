/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isValidToolName,
  getToolAliases,
  ALL_BUILTIN_TOOL_NAMES,
} from './tool-names.js';

vi.mock('../mcp/tools/mcp-tool.js', () => ({
  MCP_TOOL_PREFIX: 'mcp__',
  isMcpToolName: (name: string) => name.startsWith('mcp__'),
  parseMcpToolName: (name: string) => {
    const [serverName, toolName] = name.slice('mcp__'.length).split('__');
    return { serverName, toolName };
  },
}));

// Mock tool-names to inject test-only legacy aliases
vi.mock('./tool-names.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tool-names.js')>();
  const mockedAliases: Record<string, string> = {
    legacy_test_tool: 'current_test_tool',
    another_legacy_test_tool: 'current_test_tool',
  };
  return {
    ...actual,
    TOOL_LEGACY_ALIASES: mockedAliases,
    isValidToolName: vi.fn().mockImplementation((name: string, options) => {
      if (Object.prototype.hasOwnProperty.call(mockedAliases, name))
        return true;
      return actual.isValidToolName(name, options);
    }),
    getToolAliases: vi.fn().mockImplementation((name: string) => {
      const aliases = new Set<string>([name]);
      const canonicalName = mockedAliases[name] ?? name;
      aliases.add(canonicalName);
      for (const [legacyName, currentName] of Object.entries(mockedAliases)) {
        if (currentName === canonicalName) {
          aliases.add(legacyName);
        }
      }
      return Array.from(aliases);
    }),
  };
});

describe('tool-names', () => {
  describe('isValidToolName', () => {
    it('should validate built-in tool names', () => {
      for (const name of ALL_BUILTIN_TOOL_NAMES) {
        expect(isValidToolName(name)).toBe(true);
      }
    });

    it('should not validate retired Terminal* tool names as built-ins', () => {
      for (const name of [
        'TerminalOpen',
        'TerminalWrite',
        'TerminalSnapshot',
        'TerminalResize',
        'TerminalClose',
        'TerminalList',
      ]) {
        expect(isValidToolName(name)).toBe(false);
      }
    });

    it('should validate modern MCP FQNs (mcp__server__tool)', () => {
      expect(isValidToolName('mcp__server__tool')).toBe(true);
      expect(isValidToolName('mcp__my-server__my-tool')).toBe(true);
    });

    it('should validate legacy tool aliases via mock', () => {
      // The mock injects legacy_test_tool → current_test_tool
      expect(isValidToolName('legacy_test_tool')).toBe(true);
    });

    it('should return false for invalid tool names', () => {
      expect(isValidToolName('invalid-tool-name')).toBe(false);
      // Legacy single-underscore form no longer matches the MCP prefix.
      expect(isValidToolName('mcp_server_tool')).toBe(false);
      expect(isValidToolName('mcp__server')).toBe(false);
      expect(isValidToolName('mcp____tool')).toBe(false);
      expect(isValidToolName('mcp__invalid server__tool')).toBe(false);
      expect(isValidToolName('mcp__server__invalid tool')).toBe(false);
      expect(isValidToolName('mcp__server__')).toBe(false);
    });

    it('should handle wildcards when allowed', () => {
      // Default: not allowed
      expect(isValidToolName('*')).toBe(false);
      expect(isValidToolName('mcp__*')).toBe(false);
      expect(isValidToolName('mcp__server__*')).toBe(false);

      // Explicitly allowed
      expect(isValidToolName('*', { allowWildcards: true })).toBe(true);
      expect(isValidToolName('mcp__*', { allowWildcards: true })).toBe(true);
      expect(isValidToolName('mcp__server__*', { allowWildcards: true })).toBe(
        true,
      );

      // Invalid wildcards
      expect(isValidToolName('mcp____*', { allowWildcards: true })).toBe(false);
      expect(
        isValidToolName('mcp__server__tool*', { allowWildcards: true }),
      ).toBe(false);
    });
  });

  describe('getToolAliases', () => {
    it('should return all associated names for a current tool', () => {
      const aliases = getToolAliases('current_test_tool');
      expect(aliases).toContain('current_test_tool');
      expect(aliases).toContain('legacy_test_tool');
      expect(aliases).toContain('another_legacy_test_tool');
    });

    it('should return all associated names for a legacy tool', () => {
      const aliases = getToolAliases('legacy_test_tool');
      expect(aliases).toContain('current_test_tool');
      expect(aliases).toContain('legacy_test_tool');
      expect(aliases).toContain('another_legacy_test_tool');
    });

    it('should return only the name itself if no aliases exist', () => {
      const aliases = getToolAliases('unknown_tool');
      expect(aliases).toEqual(['unknown_tool']);
    });
  });
});
