/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ModeConfig } from './types.js';
import {
  resolveInheritedMode,
  getInheritanceChain,
  isInheritedFrom,
  findDescendants,
} from './mode-inheritance.js';

describe('Mode Inheritance', () => {
  let availableModes: Map<string, ModeConfig>;

  const createMode = (overrides: Partial<ModeConfig>): ModeConfig => ({
    name: 'test-mode',
    displayName: 'Test Mode',
    description: 'A test mode',
    icon: '🧪',
    systemPrompt: 'You are a test mode',
    level: 'user',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    availableModes = new Map();
    availableModes.set(
      'parent',
      createMode({
        name: 'parent',
        displayName: 'Parent Mode',
        description: 'Base parent mode',
        icon: '👨',
        systemPrompt: 'You are the parent mode',
        level: 'builtin',
        allowedTools: ['read_file', 'write_file', 'edit', 'run_shell_command'],
        deniedTools: ['agent'],
        approvalMode: 'default',
        allowedSubagents: ['general-purpose', 'Explore'],
        allowedSkills: ['skill-a'],
        modelConfig: { model: 'parent-model', temperature: 0.5 },
        runConfig: { max_turns: 10, max_time_minutes: 30 },
        color: '#FF0000',
        supportsParallel: true,
        maxParallelTasks: 5,
      }),
    );
  });

  describe('resolveInheritedMode - simple inheritance', () => {
    it('should return mode as-is when no inheritedFrom', () => {
      const mode = createMode({
        name: 'standalone',
        systemPrompt: 'Standalone mode',
      });

      const result = resolveInheritedMode(mode, availableModes);

      expect(result).toBe(mode);
      expect(result.name).toBe('standalone');
      expect(result.systemPrompt).toBe('Standalone mode');
    });

    it('should inherit parent systemPrompt when child does not override', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child Mode',
        description: '',
        icon: '',
        systemPrompt: '',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('child', child);

      const result = resolveInheritedMode(child, availableModes);

      expect(result.systemPrompt).toBe('You are the parent mode');
    });

    it('should override parent systemPrompt when child provides one', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child Mode',
        description: 'A child mode',
        icon: '👦',
        systemPrompt: 'You are the child mode',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('child', child);

      const result = resolveInheritedMode(child, availableModes);

      expect(result.systemPrompt).toBe('You are the child mode');
    });

    it('should inherit parent allowedTools when child does not specify', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('child', child);

      const result = resolveInheritedMode(child, availableModes);

      expect(result.allowedTools).toEqual([
        'read_file',
        'write_file',
        'edit',
        'run_shell_command',
      ]);
    });

    it('should use child allowedTools when child specifies them', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
        allowedTools: ['read_file', 'grep_search'],
      });
      availableModes.set('child', child);

      const result = resolveInheritedMode(child, availableModes);

      expect(result.allowedTools).toEqual(['read_file', 'grep_search']);
    });

    it('should inherit parent deniedTools when child does not specify', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('child', child);

      const result = resolveInheritedMode(child, availableModes);

      expect(result.deniedTools).toEqual(['agent']);
    });

    it('should inherit parent approvalMode when child does not specify', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('child', child);

      const result = resolveInheritedMode(child, availableModes);

      expect(result.approvalMode).toBe('default');
    });

    it('should inherit parent allowedSubagents when child does not specify', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('child', child);

      const result = resolveInheritedMode(child, availableModes);

      expect(result.allowedSubagents).toEqual(['general-purpose', 'Explore']);
    });

    it('should inherit parent allowedSkills when child does not specify', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('child', child);

      const result = resolveInheritedMode(child, availableModes);

      expect(result.allowedSkills).toEqual(['skill-a']);
    });

    it('should merge modelConfig with child overriding parent values', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
        modelConfig: { temperature: 0.8 },
      });
      availableModes.set('child', child);

      const result = resolveInheritedMode(child, availableModes);

      expect(result.modelConfig?.model).toBe('parent-model');
      expect(result.modelConfig?.temperature).toBe(0.8);
    });

    it('should merge runConfig with child overriding parent values', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
        runConfig: { max_turns: 20 },
      });
      availableModes.set('child', child);

      const result = resolveInheritedMode(child, availableModes);

      expect(result.runConfig?.max_turns).toBe(20);
      expect(result.runConfig?.max_time_minutes).toBe(30);
    });

    it('should inherit color and supportsParallel from parent', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('child', child);

      const result = resolveInheritedMode(child, availableModes);

      expect(result.color).toBe('#FF0000');
      expect(result.supportsParallel).toBe(true);
      expect(result.maxParallelTasks).toBe(5);
    });

    it('should use child name and level, not parent', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('child', child);

      const result = resolveInheritedMode(child, availableModes);

      expect(result.name).toBe('child');
      expect(result.level).toBe('user');
    });

    it('should use child displayName and icon when provided', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child Display',
        description: 'Child description',
        icon: '👶',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('child', child);

      const result = resolveInheritedMode(child, availableModes);

      expect(result.displayName).toBe('Child Display');
      expect(result.icon).toBe('👶');
    });
  });

  describe('resolveInheritedMode - deep chain', () => {
    it('should resolve grandchild → child → parent inheritance', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child system prompt',
        level: 'user',
        inheritedFrom: 'parent',
        allowedTools: ['read_file', 'write_file'],
      });

      const grandchild = createMode({
        name: 'grandchild',
        displayName: 'Grandchild',
        description: 'Grandchild',
        icon: '👶',
        systemPrompt: 'Grandchild prompt',
        level: 'project',
        inheritedFrom: 'child',
        modelConfig: { temperature: 0.9 },
      });

      availableModes.set('child', child);
      availableModes.set('grandchild', grandchild);

      const result = resolveInheritedMode(grandchild, availableModes);

      // Name and level from grandchild
      expect(result.name).toBe('grandchild');
      expect(result.level).toBe('project');

      // systemPrompt from grandchild
      expect(result.systemPrompt).toBe('Grandchild prompt');

      // allowedTools from child (grandchild did not override)
      expect(result.allowedTools).toEqual(['read_file', 'write_file']);

      // modelConfig temperature from grandchild, model from parent
      expect(result.modelConfig?.model).toBe('parent-model');
      expect(result.modelConfig?.temperature).toBe(0.9);
    });

    it('should inherit parent fields through the chain when intermediate does not override', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });

      const grandchild = createMode({
        name: 'grandchild',
        displayName: 'Grandchild',
        description: 'Grandchild',
        icon: '👶',
        systemPrompt: 'Grandchild',
        level: 'project',
        inheritedFrom: 'child',
      });

      availableModes.set('child', child);
      availableModes.set('grandchild', grandchild);

      const result = resolveInheritedMode(grandchild, availableModes);

      // deniedTools, approvalMode, allowedSubagents, allowedSkills should come from parent
      expect(result.deniedTools).toEqual(['agent']);
      expect(result.approvalMode).toBe('default');
      expect(result.allowedSubagents).toEqual(['general-purpose', 'Explore']);
      expect(result.allowedSkills).toEqual(['skill-a']);
    });
  });

  describe('resolveInheritedMode - missing parent', () => {
    it('should throw error when parent mode is not found', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'nonexistent-parent',
      });

      expect(() => resolveInheritedMode(child, availableModes)).toThrow(
        'Parent mode "nonexistent-parent" not found for mode "child"',
      );
    });
  });

  describe('resolveInheritedMode - circular inheritance', () => {
    it('should throw error on direct circular inheritance', () => {
      const circular = createMode({
        name: 'circular',
        displayName: 'Circular',
        description: 'Circular',
        icon: '🔄',
        systemPrompt: 'Circular',
        level: 'user',
        inheritedFrom: 'circular',
      });

      availableModes.set('circular', circular);

      expect(() => resolveInheritedMode(circular, availableModes)).toThrow(
        'Circular inheritance detected: circular → circular',
      );
    });

    it('should throw error on indirect circular inheritance', () => {
      const modeA = createMode({
        name: 'mode-a',
        displayName: 'Mode A',
        description: 'A',
        icon: 'A',
        systemPrompt: 'A',
        level: 'user',
        inheritedFrom: 'mode-b',
      });

      const modeB = createMode({
        name: 'mode-b',
        displayName: 'Mode B',
        description: 'B',
        icon: 'B',
        systemPrompt: 'B',
        level: 'user',
        inheritedFrom: 'mode-a',
      });

      availableModes.set('mode-a', modeA);
      availableModes.set('mode-b', modeB);

      expect(() => resolveInheritedMode(modeA, availableModes)).toThrow(
        'Circular inheritance detected',
      );
    });

    it('should throw error on longer circular chain', () => {
      const a = createMode({
        name: 'a',
        displayName: 'A',
        description: 'A',
        icon: 'A',
        systemPrompt: 'A',
        level: 'user',
        inheritedFrom: 'b',
      });
      const b = createMode({
        name: 'b',
        displayName: 'B',
        description: 'B',
        icon: 'B',
        systemPrompt: 'B',
        level: 'user',
        inheritedFrom: 'c',
      });
      const c = createMode({
        name: 'c',
        displayName: 'C',
        description: 'C',
        icon: 'C',
        systemPrompt: 'C',
        level: 'user',
        inheritedFrom: 'a',
      });

      availableModes.set('a', a);
      availableModes.set('b', b);
      availableModes.set('c', c);

      expect(() => resolveInheritedMode(a, availableModes)).toThrow(
        'Circular inheritance detected',
      );
    });
  });

  describe('getInheritanceChain', () => {
    it('should return chain with just the mode when no inheritance', () => {
      const standalone = createMode({
        name: 'standalone',
        displayName: 'Standalone',
        description: 'Standalone',
        icon: '📦',
        systemPrompt: 'Standalone',
        level: 'builtin',
      });

      const chain = getInheritanceChain(standalone, availableModes);

      expect(chain).toEqual(['standalone']);
    });

    it('should return correct chain for child → parent', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('child', child);

      const chain = getInheritanceChain(child, availableModes);

      expect(chain).toEqual(['child', 'parent']);
    });

    it('should return correct chain for grandchild → child → parent', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });

      const grandchild = createMode({
        name: 'grandchild',
        displayName: 'Grandchild',
        description: 'Grandchild',
        icon: '👶',
        systemPrompt: 'Grandchild',
        level: 'project',
        inheritedFrom: 'child',
      });

      availableModes.set('child', child);
      availableModes.set('grandchild', grandchild);

      const chain = getInheritanceChain(grandchild, availableModes);

      expect(chain).toEqual(['grandchild', 'child', 'parent']);
    });

    it('should stop chain when parent is not found', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'missing-parent',
      });

      const chain = getInheritanceChain(child, availableModes);

      expect(chain).toEqual(['child']);
    });
  });

  describe('isInheritedFrom', () => {
    it('should return false when mode has no inheritedFrom', () => {
      const standalone = createMode({
        name: 'standalone',
        displayName: 'Standalone',
        description: 'Standalone',
        icon: '📦',
        systemPrompt: 'Standalone',
        level: 'builtin',
      });

      expect(isInheritedFrom(standalone, 'parent', availableModes)).toBe(false);
    });

    it('should return true for direct parent', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('child', child);

      expect(isInheritedFrom(child, 'parent', availableModes)).toBe(true);
    });

    it('should return false for non-ancestor', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('child', child);

      expect(isInheritedFrom(child, 'unrelated', availableModes)).toBe(false);
    });

    it('should return true for grandparent (indirect inheritance)', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });

      const grandchild = createMode({
        name: 'grandchild',
        displayName: 'Grandchild',
        description: 'Grandchild',
        icon: '👶',
        systemPrompt: 'Grandchild',
        level: 'project',
        inheritedFrom: 'child',
      });

      availableModes.set('child', child);
      availableModes.set('grandchild', grandchild);

      expect(isInheritedFrom(grandchild, 'parent', availableModes)).toBe(true);
    });

    it('should return false when parent mode is not found', () => {
      // When the parent is not in availableModes, isInheritedFrom cannot traverse further,
      // but the direct check (mode.inheritedFrom === ancestorName) still returns true.
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'missing-parent',
      });

      expect(isInheritedFrom(child, 'missing-parent', availableModes)).toBe(
        true,
      );
    });
  });

  describe('findDescendants', () => {
    it('should find all child modes of a parent', () => {
      const child1 = createMode({
        name: 'child1',
        displayName: 'Child 1',
        description: 'Child 1',
        icon: '👦',
        systemPrompt: 'Child 1',
        level: 'user',
        inheritedFrom: 'parent',
      });

      const child2 = createMode({
        name: 'child2',
        displayName: 'Child 2',
        description: 'Child 2',
        icon: '👧',
        systemPrompt: 'Child 2',
        level: 'user',
        inheritedFrom: 'parent',
      });

      const unrelated = createMode({
        name: 'unrelated',
        displayName: 'Unrelated',
        description: 'Unrelated',
        icon: '🤷',
        systemPrompt: 'Unrelated',
        level: 'user',
      });

      availableModes.set('child1', child1);
      availableModes.set('child2', child2);
      availableModes.set('unrelated', unrelated);

      const descendants = findDescendants('parent', availableModes);

      expect(descendants).toHaveLength(2);
      const names = descendants.map((d) => d.name);
      expect(names).toContain('child1');
      expect(names).toContain('child2');
      expect(names).not.toContain('unrelated');
    });

    it('should find indirect descendants (grandchildren)', () => {
      const child = createMode({
        name: 'child',
        displayName: 'Child',
        description: 'Child',
        icon: '👦',
        systemPrompt: 'Child',
        level: 'user',
        inheritedFrom: 'parent',
      });

      const grandchild = createMode({
        name: 'grandchild',
        displayName: 'Grandchild',
        description: 'Grandchild',
        icon: '👶',
        systemPrompt: 'Grandchild',
        level: 'project',
        inheritedFrom: 'child',
      });

      availableModes.set('child', child);
      availableModes.set('grandchild', grandchild);

      const descendants = findDescendants('parent', availableModes);

      expect(descendants).toHaveLength(2);
      const names = descendants.map((d) => d.name);
      expect(names).toContain('child');
      expect(names).toContain('grandchild');
    });

    it('should return empty array when no descendants exist', () => {
      const descendants = findDescendants('parent', availableModes);
      expect(descendants).toEqual([]);
    });

    it('should return empty array when ancestor does not exist', () => {
      const unrelated = createMode({
        name: 'unrelated',
        displayName: 'Unrelated',
        description: 'Unrelated',
        icon: '🤷',
        systemPrompt: 'Unrelated',
        level: 'user',
        inheritedFrom: 'parent',
      });
      availableModes.set('unrelated', unrelated);

      const descendants = findDescendants(
        'nonexistent-ancestor',
        availableModes,
      );
      expect(descendants).toEqual([]);
    });
  });
});
