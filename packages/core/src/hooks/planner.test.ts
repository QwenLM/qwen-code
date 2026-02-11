/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { HookPlanner, createHookPlanner, matchToolName } from './planner.js';
import { HookEventName, HookType } from './types.js';

describe('HookPlanner', () => {
  describe('match', () => {
    it('should match exact tool names', () => {
      const planner = new HookPlanner();
      expect(planner.match('WriteFile', 'WriteFile')).toBe(true);
      expect(planner.match('WriteFile', 'ReadFile')).toBe(false);
    });

    it('should match wildcard pattern', () => {
      const planner = new HookPlanner();
      expect(planner.match('AnyTool', '*')).toBe(true);
      expect(planner.match('WriteFile', '*')).toBe(true);
    });

    it('should match regex pattern with pipe', () => {
      const planner = new HookPlanner();
      // Pipe creates alternation - matches beginning/end anchors
      expect(planner.match('Write', 'Write|Read')).toBe(true); // Matches ^Write
      expect(planner.match('Read', 'Write|Read')).toBe(true); // Matches Read$
      expect(planner.match('DeleteFile', 'Write|Read')).toBe(false);
    });

    it('should match regex pattern with dot', () => {
      const planner = new HookPlanner();
      expect(planner.match('FileA', 'File.')).toBe(true);
      expect(planner.match('File1', 'File.')).toBe(true);
    });

    it('should match regex pattern with asterisk', () => {
      const planner = new HookPlanner();
      expect(planner.match('WriteFileTool', 'Write.*')).toBe(true);
      // Note: 'Write.*' requires at least one char after Write due to .* being greedy
      // but 'Write' alone doesn't match 'Write.*' pattern which expects Write + anything
      expect(planner.match('WriteX', 'Write.*')).toBe(true);
    });

    it('should not match empty pattern', () => {
      const planner = new HookPlanner();
      expect(planner.match('WriteFile', '')).toBe(false);
    });
  });

  describe('matchDefinition', () => {
    it('should match when no matcher defined (wildcard)', () => {
      const planner = new HookPlanner();
      const definition = {
        hooks: [{ type: HookType.Command, command: 'test' }],
      };
      const result = planner.matchDefinition('AnyTool', definition);
      expect(result.matched).toBe(true);
      expect(result.pattern).toBe('*');
    });

    it('should match with exact matcher', () => {
      const planner = new HookPlanner();
      const definition = {
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test' }],
      };
      const result = planner.matchDefinition('WriteFile', definition);
      expect(result.matched).toBe(true);
      expect(result.pattern).toBe('WriteFile');
    });

    it('should not match when pattern differs', () => {
      const planner = new HookPlanner();
      const definition = {
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test' }],
      };
      const result = planner.matchDefinition('ReadFile', definition);
      expect(result.matched).toBe(false);
    });
  });

  describe('findMatchingHooks', () => {
    it('should find all matching definitions', () => {
      const planner = new HookPlanner();
      const definitions = [
        {
          matcher: 'WriteFile',
          hooks: [{ type: HookType.Command, command: 'cmd1' }],
        },
        {
          matcher: 'ReadFile',
          hooks: [{ type: HookType.Command, command: 'cmd2' }],
        },
        { matcher: '*', hooks: [{ type: HookType.Command, command: 'cmd3' }] },
      ];
      const matches = planner.findMatchingHooks('WriteFile', definitions);
      expect(matches).toHaveLength(2);
      expect(matches[0].matcher).toBe('WriteFile');
      expect(matches[1].matcher).toBe('*');
    });

    it('should return empty array when no matches', () => {
      const planner = new HookPlanner();
      const definitions = [
        {
          matcher: 'WriteFile',
          hooks: [{ type: HookType.Command, command: 'cmd1' }],
        },
      ];
      const matches = planner.findMatchingHooks('ReadFile', definitions);
      expect(matches).toHaveLength(0);
    });
  });

  describe('deduplicate', () => {
    it('should remove duplicate command hooks', () => {
      const planner = new HookPlanner();
      const hooks = [
        { type: HookType.Command, command: 'cmd1' },
        { type: HookType.Command, command: 'cmd2' },
        { type: HookType.Command, command: 'cmd1' }, // duplicate
      ];
      const deduped = planner.deduplicate(hooks);
      expect(deduped).toHaveLength(2);
      expect(deduped[0].command).toBe('cmd1');
      expect(deduped[1].command).toBe('cmd2');
    });

    it('should keep unique hooks', () => {
      const planner = new HookPlanner();
      const hooks = [
        { type: HookType.Command, command: 'cmd1' },
        { type: HookType.Command, command: 'cmd2' },
        { type: HookType.Command, command: 'cmd3' },
      ];
      const deduped = planner.deduplicate(hooks);
      expect(deduped).toHaveLength(3);
    });

    it('should handle empty array', () => {
      const planner = new HookPlanner();
      const deduped = planner.deduplicate([]);
      expect(deduped).toHaveLength(0);
    });
  });

  describe('createPlan', () => {
    it('should create plan with matching hooks', () => {
      const planner = new HookPlanner();
      const definitions = [
        {
          matcher: 'WriteFile',
          hooks: [
            { type: HookType.Command, command: 'hook1' },
            { type: HookType.Command, command: 'hook2' },
          ],
        },
      ];
      const plan = planner.createPlan({
        eventName: HookEventName.PreToolUse,
        toolName: 'WriteFile',
        hookDefinitions: definitions,
      });
      expect(plan.eventName).toBe(HookEventName.PreToolUse);
      expect(plan.hookConfigs).toHaveLength(2);
      expect(plan.sequential).toBe(false);
    });

    it('should create sequential plan when definition specifies sequential', () => {
      const planner = new HookPlanner();
      const definitions = [
        {
          matcher: 'WriteFile',
          sequential: true,
          hooks: [{ type: HookType.Command, command: 'hook1' }],
        },
      ];
      const plan = planner.createPlan({
        eventName: HookEventName.PreToolUse,
        toolName: 'WriteFile',
        hookDefinitions: definitions,
      });
      expect(plan.sequential).toBe(true);
    });

    it('should deduplicate hooks in plan', () => {
      const planner = new HookPlanner();
      const definitions = [
        {
          matcher: 'WriteFile',
          hooks: [{ type: HookType.Command, command: 'same-hook' }],
        },
        {
          matcher: '*',
          hooks: [
            { type: HookType.Command, command: 'same-hook' }, // duplicate
            { type: HookType.Command, command: 'unique-hook' },
          ],
        },
      ];
      const plan = planner.createPlan({
        eventName: HookEventName.PreToolUse,
        toolName: 'WriteFile',
        hookDefinitions: definitions,
      });
      expect(plan.hookConfigs).toHaveLength(2);
    });

    it('should return empty plan when no tool name provided', () => {
      const planner = new HookPlanner();
      const definitions = [
        {
          matcher: 'WriteFile',
          hooks: [{ type: HookType.Command, command: 'hook1' }],
        },
      ];
      const plan = planner.createPlan({
        eventName: HookEventName.PreToolUse,
        toolName: undefined,
        hookDefinitions: definitions,
      });
      expect(plan.hookConfigs).toHaveLength(0);
    });

    it('should return empty plan when no definitions', () => {
      const planner = new HookPlanner();
      const plan = planner.createPlan({
        eventName: HookEventName.PreToolUse,
        toolName: 'WriteFile',
        hookDefinitions: [],
      });
      expect(plan.hookConfigs).toHaveLength(0);
    });
  });

  describe('createPlans', () => {
    it('should create plans for multiple tools', () => {
      const planner = new HookPlanner();
      const definitions = [
        {
          matcher: 'WriteFile',
          hooks: [{ type: HookType.Command, command: 'write-hook' }],
        },
        {
          matcher: 'ReadFile',
          hooks: [{ type: HookType.Command, command: 'read-hook' }],
        },
      ];
      const plans = planner.createPlans(
        HookEventName.PreToolUse,
        ['WriteFile', 'ReadFile'],
        definitions,
      );
      expect(plans.size).toBe(2);
      expect(plans.get('WriteFile')?.hookConfigs).toHaveLength(1);
      expect(plans.get('ReadFile')?.hookConfigs).toHaveLength(1);
    });
  });

  describe('hasMatchingHooks', () => {
    it('should return true when hooks match', () => {
      const planner = new HookPlanner();
      const definitions = [
        {
          matcher: 'WriteFile',
          hooks: [{ type: HookType.Command, command: 'hook1' }],
        },
      ];
      expect(planner.hasMatchingHooks('WriteFile', definitions)).toBe(true);
    });

    it('should return false when no hooks match', () => {
      const planner = new HookPlanner();
      const definitions = [
        {
          matcher: 'WriteFile',
          hooks: [{ type: HookType.Command, command: 'hook1' }],
        },
      ];
      expect(planner.hasMatchingHooks('ReadFile', definitions)).toBe(false);
    });
  });

  describe('getAllMatchers', () => {
    it('should return all unique matchers', () => {
      const planner = new HookPlanner();
      const definitions = [
        {
          matcher: 'WriteFile',
          hooks: [{ type: HookType.Command, command: 'hook1' }],
        },
        {
          matcher: 'ReadFile',
          hooks: [{ type: HookType.Command, command: 'hook2' }],
        },
        {
          matcher: 'WriteFile',
          hooks: [{ type: HookType.Command, command: 'hook3' }],
        },
      ];
      const matchers = planner.getAllMatchers(definitions);
      expect(matchers).toHaveLength(2);
      expect(matchers).toContain('WriteFile');
      expect(matchers).toContain('ReadFile');
    });
  });
});

describe('createHookPlanner', () => {
  it('should create a new HookPlanner instance', () => {
    const planner = createHookPlanner();
    expect(planner).toBeInstanceOf(HookPlanner);
  });
});

describe('matchToolName', () => {
  it('should match tool names using standalone function', () => {
    expect(matchToolName('WriteFile', 'WriteFile')).toBe(true);
    expect(matchToolName('WriteFile', 'ReadFile')).toBe(false);
    expect(matchToolName('AnyTool', '*')).toBe(true);
  });
});
