/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  ToolRouter,
  filterToolsByMode,
  isToolAllowedInMode,
} from '../src/tool-router.js';
import { ARCHITECT_MODE, CODE_MODE, ASK_MODE } from '../src/modes/builtin-modes.js';

describe('ToolRouter', () => {
  describe('constructor', () => {
    it('should initialize with mode and default tools', () => {
      const router = new ToolRouter(ARCHITECT_MODE);
      expect(router).toBeDefined();
    });

    it('should initialize with custom tool list', () => {
      const customTools = ['read_file', 'write_file'] as const;
      const router = new ToolRouter(ARCHITECT_MODE, customTools);
      expect(router).toBeDefined();
    });
  });

  describe('isToolAllowed', () => {
    it('should allow tool in allowed list', () => {
      const router = new ToolRouter(ARCHITECT_MODE);
      const result = router.isToolAllowed('read_file');
      expect(result.allowed).toBe(true);
    });

    it('should deny tool not in allowed list', () => {
      const router = new ToolRouter(ARCHITECT_MODE);
      const result = router.isToolAllowed('write_file');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('недоступен в режиме');
    });

    it('should deny tool in excluded list', () => {
      const router = new ToolRouter(ASK_MODE);
      const result = router.isToolAllowed('shell');
      expect(result.allowed).toBe(false);
    });

    it('should provide suggestion for denied tool', () => {
      const router = new ToolRouter(ARCHITECT_MODE);
      const result = router.isToolAllowed('write_file');
      expect(result.suggestion).toBe('read_file');
    });
  });

  describe('filterTools', () => {
    it('should filter tools by mode', () => {
      const router = new ToolRouter(ARCHITECT_MODE);
      const allTools = [
        'read_file',
        'write_file',
        'list_dir',
        'shell',
      ] as const;

      const filtered = router.filterTools(allTools);
      expect(filtered).toEqual(['read_file', 'list_dir']);
    });

    it('should return empty array when no tools allowed', () => {
      const router = new ToolRouter(ARCHITECT_MODE);
      const tools = ['write_file', 'edit', 'shell'] as const;
      const filtered = router.filterTools(tools);
      expect(filtered).toEqual([]);
    });
  });

  describe('getAllowedTools', () => {
    it('should return all allowed tools for mode', () => {
      const router = new ToolRouter(ARCHITECT_MODE);
      const allowed = router.getAllowedTools();
      expect(allowed).toEqual(ARCHITECT_MODE.allowedTools);
    });

    it('should exclude excluded tools', () => {
      const modeWithExclusions = {
        ...ASK_MODE,
        excludedTools: ['web_search' as const],
      };
      const router = new ToolRouter(modeWithExclusions);
      const allowed = router.getAllowedTools();
      expect(allowed).not.toContain('web_search');
    });
  });

  describe('validateToolCall', () => {
    it('should not throw for allowed tool', () => {
      const router = new ToolRouter(ARCHITECT_MODE);
      expect(() => router.validateToolCall('read_file')).not.toThrow();
    });

    it('should throw for denied tool', () => {
      const router = new ToolRouter(ARCHITECT_MODE);
      expect(() => router.validateToolCall('write_file')).toThrow(
        'Инструмент "write_file" заблокирован',
      );
    });
  });

  describe('forMode', () => {
    it('should create new router for different mode', () => {
      const architectRouter = new ToolRouter(ARCHITECT_MODE);
      const codeRouter = architectRouter.forMode(CODE_MODE);

      expect(codeRouter.isToolAllowed('write_file').allowed).toBe(true);
      expect(architectRouter.isToolAllowed('write_file').allowed).toBe(false);
    });
  });

  describe('getToolBlockageInfo', () => {
    it('should return blockage info for denied tool', () => {
      const router = new ToolRouter(ARCHITECT_MODE);
      const info = router.getToolBlockageInfo('write_file');

      expect(info.blocked).toBe(true);
      expect(info.modeName).toBe('Architect');
      expect(info.reason).toBeDefined();
    });

    it('should return allowed info for allowed tool', () => {
      const router = new ToolRouter(ARCHITECT_MODE);
      const info = router.getToolBlockageInfo('read_file');

      expect(info.blocked).toBe(false);
      expect(info.modeName).toBe('Architect');
    });
  });
});

describe('filterToolsByMode', () => {
  it('should filter tools by mode', () => {
    const tools = ['read_file', 'write_file', 'list_dir'] as const;
    const filtered = filterToolsByMode(tools, ARCHITECT_MODE);

    expect(filtered).toEqual(['read_file', 'list_dir']);
  });
});

describe('isToolAllowedInMode', () => {
  it('should return true for allowed tool', () => {
    const result = isToolAllowedInMode('read_file', ARCHITECT_MODE);
    expect(result).toBe(true);
  });

  it('should return false for denied tool', () => {
    const result = isToolAllowedInMode('write_file', ARCHITECT_MODE);
    expect(result).toBe(false);
  });

  it('should respect excluded tools', () => {
    const modeWithExclusion = {
      ...ASK_MODE,
      excludedTools: ['web_search' as const],
    };
    const result = isToolAllowedInMode('web_search', modeWithExclusion);
    expect(result).toBe(false);
  });
});
