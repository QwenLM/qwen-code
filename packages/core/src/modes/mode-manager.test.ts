/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { SubagentManager } from '../subagents/subagent-manager.js';
import type { Config } from '../config/config.js';
import { ModeManager } from './mode-manager.js';
import { ModeError, ModeErrorCode } from './types.js';
import { BUILTIN_MODES } from './builtin-modes.js';
import * as modeLoad from './mode-load.js';

// Mock dependencies
vi.mock('./mode-load.js');
vi.mock('./mode-validation.js');

const mockLoadModesFromDir = vi.mocked(modeLoad.loadModesFromDir);
const mockGetUserModesDir = vi.mocked(modeLoad.getUserModesDir);
const mockGetProjectModesDir = vi.mocked(modeLoad.getProjectModesDir);

// Import mocked validation
import { modeValidator } from './mode-validation.js';

describe('ModeManager', () => {
  let modeManager: ModeManager;
  let mockToolRegistry: ToolRegistry;
  let mockSkillManager: SkillManager;
  let mockSubagentManager: SubagentManager;
  let mockConfig: Config;

  const mockTools = [
    { name: 'read_file', displayName: 'ReadFile' },
    { name: 'write_file', displayName: 'WriteFile' },
    { name: 'edit', displayName: 'Edit' },
    { name: 'run_shell_command', displayName: 'Shell' },
    { name: 'grep_search', displayName: 'Grep' },
    { name: 'glob', displayName: 'Glob' },
    { name: 'list_directory', displayName: 'ListFiles' },
    { name: 'todo_write', displayName: 'TodoWrite' },
    { name: 'save_memory', displayName: 'SaveMemory' },
    { name: 'agent', displayName: 'Agent' },
    { name: 'skill', displayName: 'Skill' },
    { name: 'web_fetch', displayName: 'WebFetch' },
    { name: 'web_search', displayName: 'WebSearch' },
    { name: 'lsp', displayName: 'LSP' },
    { name: 'ask_user_question', displayName: 'AskUserQuestion' },
  ];

  const mockSubagents = [
    {
      name: 'general-purpose',
      description: 'General purpose',
      level: 'builtin' as const,
      systemPrompt: 'test',
    },
    {
      name: 'Explore',
      description: 'Explore codebase',
      level: 'builtin' as const,
      systemPrompt: 'test',
    },
  ];

  const mockSkills = [
    {
      name: 'loop',
      description: 'Loop skill',
      level: 'bundled' as const,
      body: 'test',
      filePath: '/test',
    },
    {
      name: 'qc-helper',
      description: 'QC Helper',
      level: 'bundled' as const,
      body: 'test',
      filePath: '/test',
    },
    {
      name: 'review',
      description: 'Code Review',
      level: 'bundled' as const,
      body: 'test',
      filePath: '/test',
    },
  ];

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Setup mock tool registry
    mockToolRegistry = {
      getAllToolNames: vi.fn().mockReturnValue(mockTools.map((t) => t.name)),
    } as unknown as ToolRegistry;

    // Setup mock skill manager
    mockSkillManager = {
      listSkills: vi.fn().mockReturnValue(mockSkills),
    } as unknown as SkillManager;

    // Setup mock subagent manager
    mockSubagentManager = {
      listSubagents: vi.fn().mockReturnValue(mockSubagents),
    } as unknown as SubagentManager;

    // Setup mock config
    mockConfig = {
      getApprovalMode: vi.fn().mockReturnValue('default'),
      setApprovalMode: vi.fn(),
    } as unknown as Config;

    // Create ModeManager instance
    modeManager = new ModeManager(
      mockToolRegistry,
      mockSkillManager,
      mockSubagentManager,
      '/test/project',
    );
  });

  describe('loadBuiltinModes', () => {
    it('should register all built-in modes', async () => {
      await modeManager.loadBuiltinModes();

      const modes = modeManager.getAvailableModes();
      expect(modes).toHaveLength(BUILTIN_MODES.length);

      // Check specific modes exist
      const modeNames = modes.map((m) => m.name);
      expect(modeNames).toContain('general');
      expect(modeNames).toContain('developer');
      expect(modeNames).toContain('architect');
      expect(modeNames).toContain('reviewer');
    });

    it('should set builtin level for all built-in modes', async () => {
      await modeManager.loadBuiltinModes();

      const modes = modeManager.getAvailableModes();
      modes.forEach((mode) => {
        expect(mode.level).toBe('builtin');
      });
    });
  });

  describe('loadUserModes', () => {
    it('should handle missing user modes directory gracefully', async () => {
      mockGetUserModesDir.mockReturnValue('/nonexistent/path');
      mockLoadModesFromDir.mockResolvedValue([]);

      await expect(
        modeManager.loadUserModes(mockConfig),
      ).resolves.not.toThrow();
    });

    it('should skip invalid user modes', async () => {
      mockGetUserModesDir.mockReturnValue('/home/user/.qwen/modes');
      mockLoadModesFromDir.mockResolvedValue([]);

      await modeManager.loadUserModes(mockConfig);

      // Should not throw, just log warning
      expect(mockLoadModesFromDir).toHaveBeenCalled();
    });

    it('should handle missing user modes directory', async () => {
      mockGetUserModesDir.mockReturnValue('/home/user/.qwen/modes');
      mockLoadModesFromDir.mockRejectedValue(new Error('ENOENT'));

      await modeManager.loadUserModes(mockConfig);

      // Should not throw
      await expect(
        modeManager.loadUserModes(mockConfig),
      ).resolves.not.toThrow();
    });
  });

  describe('loadProjectModes', () => {
    it('should handle missing project modes directory gracefully', async () => {
      mockGetProjectModesDir.mockReturnValue('/nonexistent/.qwen/modes');
      mockLoadModesFromDir.mockResolvedValue([]);

      await expect(
        modeManager.loadProjectModes(mockConfig),
      ).resolves.not.toThrow();
    });

    it('should not load project modes when projectDir is not set', async () => {
      const managerWithoutProject = new ModeManager(
        mockToolRegistry,
        mockSkillManager,
        mockSubagentManager,
      );

      await managerWithoutProject.loadProjectModes(mockConfig);

      expect(mockLoadModesFromDir).not.toHaveBeenCalled();
    });
  });

  describe('switchMode', () => {
    beforeEach(async () => {
      await modeManager.loadBuiltinModes();
    });

    it('should switch to a valid mode', async () => {
      // Mock validator to return valid
      vi.mocked(modeValidator.validateConfig).mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      const runtime = await modeManager.switchMode('developer', mockConfig);

      expect(runtime.config.name).toBe('developer');
      expect(runtime.config.icon).toBe('💻');
      expect(runtime.appliedAt).toBeInstanceOf(Date);
    });

    it('should emit mode:changed event', async () => {
      vi.mocked(modeValidator.validateConfig).mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      const changeListener = vi.fn();
      modeManager.on('mode:changed', changeListener);

      await modeManager.switchMode('developer', mockConfig);

      expect(changeListener).toHaveBeenCalledTimes(1);
      expect(changeListener.mock.calls[0][0].config.name).toBe('developer');
    });

    it('should throw ModeError when mode not found', async () => {
      await expect(
        modeManager.switchMode('nonexistent', mockConfig),
      ).rejects.toThrow(ModeError);

      await expect(
        modeManager.switchMode('nonexistent', mockConfig),
      ).rejects.toMatchObject({
        code: ModeErrorCode.NOT_FOUND,
      });
    });

    it('should throw ModeError when validation fails', async () => {
      vi.mocked(modeValidator.validateConfig).mockReturnValue({
        isValid: false,
        errors: ['Invalid tool specified'],
        warnings: [],
      });

      await expect(
        modeManager.switchMode('developer', mockConfig),
      ).rejects.toThrow(ModeError);

      await expect(
        modeManager.switchMode('developer', mockConfig),
      ).rejects.toMatchObject({
        code: ModeErrorCode.VALIDATION_ERROR,
      });
    });

    it('should save original settings for restoration', async () => {
      vi.mocked(modeValidator.validateConfig).mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      const runtime = await modeManager.switchMode('developer', mockConfig);

      expect(runtime.originalSettings).toBeDefined();
      expect(runtime.originalSettings?.approvalMode).toBe('default');
    });
  });

  describe('resetToDefault', () => {
    beforeEach(async () => {
      await modeManager.loadBuiltinModes();
    });

    it('should reset to default mode', async () => {
      vi.mocked(modeValidator.validateConfig).mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      // Switch to a mode first
      await modeManager.switchMode('developer', mockConfig);

      // Reset
      await modeManager.resetToDefault(mockConfig);

      expect(modeManager.getCurrentMode()).toBeNull();
    });

    it('should emit mode:reset event', async () => {
      const resetListener = vi.fn();
      modeManager.on('mode:reset', resetListener);

      await modeManager.resetToDefault(mockConfig);

      expect(resetListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAvailableToolNames', () => {
    beforeEach(async () => {
      await modeManager.loadBuiltinModes();
    });

    it('should return all tools when no mode is active', () => {
      const tools = modeManager.getAvailableToolNames();
      expect(tools).toHaveLength(mockTools.length);
      expect(tools).toEqual(mockTools.map((t) => t.name));
    });

    it('should filter tools based on mode allowedTools', async () => {
      vi.mocked(modeValidator.validateConfig).mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      // Switch to reviewer mode which has restricted tools
      await modeManager.switchMode('reviewer', mockConfig);

      const tools = modeManager.getAvailableToolNames();
      expect(tools).not.toContain('run_shell_command');
      expect(tools).not.toContain('write_file');
      expect(tools).toContain('read_file');
    });
  });

  describe('getAvailableSubagentNames', () => {
    beforeEach(async () => {
      await modeManager.loadBuiltinModes();
    });

    it('should return all subagents when no mode is active', () => {
      const subagents = modeManager.getAvailableSubagentNames();
      expect(subagents).toContain('general-purpose');
      expect(subagents).toContain('Explore');
    });

    it('should filter subagents based on mode allowedSubagents', async () => {
      vi.mocked(modeValidator.validateConfig).mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      // Switch to reviewer mode which only allows Explore
      await modeManager.switchMode('reviewer', mockConfig);

      const subagents = modeManager.getAvailableSubagentNames();
      expect(subagents).toContain('Explore');
      expect(subagents).not.toContain('general-purpose');
    });
  });

  describe('getAvailableSkillNames', () => {
    beforeEach(async () => {
      await modeManager.loadBuiltinModes();
    });

    it('should return all skills when no mode is active', () => {
      const skills = modeManager.getAvailableSkillNames();
      expect(skills).toContain('loop');
      expect(skills).toContain('qc-helper');
      expect(skills).toContain('review');
    });
  });

  describe('listModes', () => {
    beforeEach(async () => {
      await modeManager.loadBuiltinModes();
    });

    it('should list all modes without filters', () => {
      const modes = modeManager.listModes();
      expect(modes).toHaveLength(BUILTIN_MODES.length);
    });

    it('should filter by level', () => {
      const modes = modeManager.listModes({ level: 'builtin' });
      expect(modes).toHaveLength(BUILTIN_MODES.length);

      const userModes = modeManager.listModes({ level: 'user' });
      expect(userModes).toHaveLength(0);
    });

    it('should filter by tool availability', () => {
      const modes = modeManager.listModes({ hasTool: 'read_file' });
      // All modes should have read_file
      expect(modes.length).toBeGreaterThan(0);

      const restrictedModes = modeManager.listModes({
        hasTool: 'run_shell_command',
      });
      // Reviewer and security modes should not have shell
      expect(restrictedModes.length).toBeLessThan(BUILTIN_MODES.length);
    });

    it('should sort by name', () => {
      const modes = modeManager.listModes({ sortBy: 'name', sortOrder: 'asc' });
      const names = modes.map((m) => m.name);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });

    it('should sort by name descending', () => {
      const modes = modeManager.listModes({
        sortBy: 'name',
        sortOrder: 'desc',
      });
      const names = modes.map((m) => m.name);
      const sorted = [...names].sort().reverse();
      expect(names).toEqual(sorted);
    });
  });

  describe('change listeners', () => {
    it('should notify change listeners on mode switch', async () => {
      await modeManager.loadBuiltinModes();
      vi.mocked(modeValidator.validateConfig).mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      const listener = vi.fn();
      const unsubscribe = modeManager.addChangeListener(listener);

      await modeManager.switchMode('developer', mockConfig);

      expect(listener).toHaveBeenCalledTimes(1);

      // Unsubscribe should work
      unsubscribe();
    });

    it('should handle listener errors gracefully', async () => {
      await modeManager.loadBuiltinModes();
      vi.mocked(modeValidator.validateConfig).mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      const errorListener = vi.fn().mockImplementation(() => {
        throw new Error('Listener error');
      });
      modeManager.addChangeListener(errorListener);

      // Should not throw
      await expect(
        modeManager.switchMode('developer', mockConfig),
      ).resolves.not.toThrow();
    });
  });

  describe('validateMode', () => {
    it('should validate a mode configuration', async () => {
      await modeManager.loadBuiltinModes();

      const developerMode = modeManager.getMode('developer');
      expect(developerMode).toBeDefined();

      vi.mocked(modeValidator.validateConfig).mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      const result = modeManager.validateMode(developerMode!);
      expect(result.isValid).toBe(true);
    });
  });

  describe('Alias Management', () => {
    beforeEach(async () => {
      await modeManager.loadBuiltinModes();
    });

    describe('resolveAlias', () => {
      it('should resolve built-in alias to full mode name', () => {
        expect(modeManager.resolveAlias('dev')).toBe('developer');
        expect(modeManager.resolveAlias('arch')).toBe('architect');
        expect(modeManager.resolveAlias('rev')).toBe('reviewer');
        expect(modeManager.resolveAlias('debug')).toBe('debugger');
        expect(modeManager.resolveAlias('test')).toBe('tester');
        expect(modeManager.resolveAlias('ops')).toBe('devops');
        expect(modeManager.resolveAlias('pm')).toBe('product');
        expect(modeManager.resolveAlias('sec')).toBe('security');
        expect(modeManager.resolveAlias('opt')).toBe('optimizer');
      });

      it('should return original name if not an alias', () => {
        expect(modeManager.resolveAlias('developer')).toBe('developer');
        expect(modeManager.resolveAlias('unknown')).toBe('unknown');
      });

      it('should resolve custom alias', () => {
        modeManager.addAlias('my-dev', 'developer');
        expect(modeManager.resolveAlias('my-dev')).toBe('developer');
      });

      it('should prioritize custom alias over built-in', () => {
        // Add a custom alias that shadows a built-in
        modeManager.addAlias('dev', 'architect');
        expect(modeManager.resolveAlias('dev')).toBe('architect');
      });
    });

    describe('addAlias', () => {
      it('should add a custom alias for an existing mode', () => {
        const result = modeManager.addAlias('my-alias', 'general');
        expect(result).toBe(true);
        expect(modeManager.resolveAlias('my-alias')).toBe('general');
      });

      it('should return false for non-existent target mode', () => {
        const result = modeManager.addAlias('bad-alias', 'nonexistent');
        expect(result).toBe(false);
      });
    });

    describe('removeAlias', () => {
      it('should remove a custom alias', () => {
        modeManager.addAlias('temp-alias', 'general');
        const result = modeManager.removeAlias('temp-alias');
        expect(result).toBe(true);
        expect(modeManager.resolveAlias('temp-alias')).toBe('temp-alias');
      });

      it('should not remove built-in aliases', () => {
        const result = modeManager.removeAlias('dev');
        expect(result).toBe(false);
        expect(modeManager.resolveAlias('dev')).toBe('developer');
      });

      it('should return false for non-existent alias', () => {
        const result = modeManager.removeAlias('nonexistent');
        expect(result).toBe(false);
      });
    });

    describe('getAllAliases', () => {
      it('should include all built-in aliases', () => {
        const aliases = modeManager.getAllAliases();
        expect(aliases.has('dev')).toBe(true);
        expect(aliases.has('arch')).toBe(true);
        expect(aliases.has('pm')).toBe(true);
      });

      it('should include custom aliases', () => {
        modeManager.addAlias('custom', 'general');
        const aliases = modeManager.getAllAliases();
        expect(aliases.has('custom')).toBe(true);
      });
    });

    describe('getCustomAliases', () => {
      it('should return only custom aliases', () => {
        modeManager.addAlias('custom', 'general');
        const customAliases = modeManager.getCustomAliases();
        expect(customAliases.has('custom')).toBe(true);
        expect(customAliases.has('dev')).toBe(false);
      });
    });
  });
});
