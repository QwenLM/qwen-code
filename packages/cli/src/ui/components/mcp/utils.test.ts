/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  groupServersBySource,
  getStatusColor,
  getStatusIcon,
  truncateText,
  formatServerCommand,
  isToolValid,
  getToolInvalidReasons,
} from './utils.js';
import type { MCPServerDisplayInfo } from './types.js';
import { MCPServerStatus } from '@qwen-code/qwen-code-core';

describe('MCP utils', () => {
  describe('groupServersBySource', () => {
    it('should group servers by source', () => {
      const servers: MCPServerDisplayInfo[] = [
        {
          name: 'server1',
          status: MCPServerStatus.CONNECTED,
          source: 'user',
          scope: 'user',
          config: { command: 'cmd1' },
          toolCount: 1,
          promptCount: 0,
          isDisabled: false,
        },
        {
          name: 'server2',
          status: MCPServerStatus.CONNECTED,
          source: 'extension',
          scope: 'extension',
          config: { command: 'cmd2' },
          toolCount: 2,
          promptCount: 0,
          isDisabled: false,
        },
      ];

      const result = groupServersBySource(servers);

      expect(result).toHaveLength(2);
      expect(result[0].source).toBe('user');
      expect(result[0].servers).toHaveLength(1);
      expect(result[1].source).toBe('extension');
    });
  });

  describe('getStatusColor', () => {
    it('should return correct colors for each status', () => {
      expect(getStatusColor(MCPServerStatus.CONNECTED)).toBe('green');
      expect(getStatusColor(MCPServerStatus.CONNECTING)).toBe('yellow');
      expect(getStatusColor(MCPServerStatus.DISCONNECTED)).toBe('red');
      expect(getStatusColor('unknown' as MCPServerStatus)).toBe('gray');
    });
  });

  describe('getStatusIcon', () => {
    it('should return correct icons for each status', () => {
      expect(getStatusIcon(MCPServerStatus.CONNECTED)).toBe('✓');
      expect(getStatusIcon(MCPServerStatus.CONNECTING)).toBe('…');
      expect(getStatusIcon(MCPServerStatus.DISCONNECTED)).toBe('✗');
      expect(getStatusIcon('unknown' as MCPServerStatus)).toBe('?');
    });
  });

  describe('truncateText', () => {
    it('should truncate text longer than maxLength', () => {
      expect(truncateText('hello world', 8)).toBe('hello...');
    });

    it('should not truncate text shorter than maxLength', () => {
      expect(truncateText('hello', 10)).toBe('hello');
    });
  });

  describe('formatServerCommand', () => {
    it('should format http URL', () => {
      const server = {
        config: { httpUrl: 'http://localhost:3000' },
      } as MCPServerDisplayInfo;
      expect(formatServerCommand(server)).toBe('http://localhost:3000 (http)');
    });

    it('should format stdio command', () => {
      const server = {
        config: { command: 'node', args: ['server.js'] },
      } as MCPServerDisplayInfo;
      expect(formatServerCommand(server)).toBe('node server.js (stdio)');
    });

    it('should return Unknown for empty config', () => {
      const server = { config: {} } as MCPServerDisplayInfo;
      expect(formatServerCommand(server)).toBe('Unknown');
    });
  });

  describe('isToolValid', () => {
    it('should return true for valid tool with name and description', () => {
      expect(isToolValid('toolName', 'A description')).toBe(true);
    });

    it('should return false for tool without name', () => {
      expect(isToolValid(undefined, 'A description')).toBe(false);
      expect(isToolValid('', 'A description')).toBe(false);
    });

    it('should return false for tool without description', () => {
      expect(isToolValid('toolName', undefined)).toBe(false);
      expect(isToolValid('toolName', '')).toBe(false);
    });

    it('should return false for tool without both name and description', () => {
      expect(isToolValid(undefined, undefined)).toBe(false);
      expect(isToolValid('', '')).toBe(false);
    });
  });

  describe('getToolInvalidReasons', () => {
    it('should return empty array for valid tool', () => {
      expect(getToolInvalidReasons('toolName', 'A description')).toEqual([]);
    });

    it('should return missing name reason', () => {
      expect(getToolInvalidReasons(undefined, 'A description')).toEqual([
        'missing name',
      ]);
      expect(getToolInvalidReasons('', 'A description')).toEqual([
        'missing name',
      ]);
    });

    it('should return missing description reason', () => {
      expect(getToolInvalidReasons('toolName', undefined)).toEqual([
        'missing description',
      ]);
      expect(getToolInvalidReasons('toolName', '')).toEqual([
        'missing description',
      ]);
    });

    it('should return both reasons when both are missing', () => {
      expect(getToolInvalidReasons(undefined, undefined)).toEqual([
        'missing name',
        'missing description',
      ]);
      expect(getToolInvalidReasons('', '')).toEqual([
        'missing name',
        'missing description',
      ]);
    });
  });
});
