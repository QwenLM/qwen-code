/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ToolNames } from '../tools/tool-names.js';
import { BuiltinAgentRegistry } from './builtin-agents.js';

describe('BuiltinAgentRegistry', () => {
  describe('getBuiltinAgents', () => {
    it('should return array of builtin agents with correct properties', () => {
      const agents = BuiltinAgentRegistry.getBuiltinAgents();

      expect(agents).toBeInstanceOf(Array);
      expect(agents.length).toBeGreaterThan(0);

      agents.forEach((agent) => {
        expect(agent).toMatchObject({
          name: expect.any(String),
          description: expect.any(String),
          systemPrompt: expect.any(String),
          level: 'builtin',
          filePath: `<builtin:${agent.name}>`,
          isBuiltin: true,
        });
      });
    });

    it('should include general-purpose agent', () => {
      const agents = BuiltinAgentRegistry.getBuiltinAgents();
      const generalAgent = agents.find(
        (agent) => agent.name === 'general-purpose',
      );

      expect(generalAgent).toBeDefined();
      expect(generalAgent?.description).toContain('General-purpose agent');
      expect(generalAgent?.systemPrompt).toContain(
        'general-purpose subagent working for a parent agent',
      );
      expect(generalAgent?.systemPrompt).toContain(
        'Preserve unrelated user changes',
      );
      expect(generalAgent?.systemPrompt).toContain(
        'Verify factual claims before reporting',
      );
      expect(generalAgent?.systemPrompt).toContain(
        'run the smallest relevant checks',
      );
      expect(generalAgent?.systemPrompt).toContain(
        'Report uncertainty or blockers',
      );
    });

    it('should let the Explore agent inherit the main model', () => {
      const exploreAgent = BuiltinAgentRegistry.getBuiltinAgent('Explore');

      expect(exploreAgent).toBeDefined();
      expect(exploreAgent?.model).toBeUndefined();
    });

    it('keeps the Explore agent read-only without banning shell pipelines', () => {
      const exploreAgent = BuiltinAgentRegistry.getBuiltinAgent('Explore');

      expect(exploreAgent?.tools).not.toContain(ToolNames.TODO_WRITE);
      expect(exploreAgent?.tools).not.toContain(ToolNames.MEMORY);
      expect(exploreAgent?.tools).not.toContain(ToolNames.ASK_USER_QUESTION);
      expect(exploreAgent?.systemPrompt).toContain(
        'pipelines are allowed when every command is read-only',
      );
      expect(exploreAgent?.systemPrompt).not.toContain('(>, >>, |)');
    });

    // Regression for #7126: Explore is a read-only search worker that
    // typically runs as a subagent with no human in the loop. An
    // interactive question tool would block the pipeline forever.
    it('should not give the Explore agent the interactive question tool', () => {
      const exploreAgent = BuiltinAgentRegistry.getBuiltinAgent('Explore');

      expect(exploreAgent?.tools).toBeDefined();
      expect(exploreAgent?.tools).not.toContain('ask_user_question');
    });
  });

  describe('getBuiltinAgent', () => {
    it('should return correct agent for valid name', () => {
      const agent = BuiltinAgentRegistry.getBuiltinAgent('general-purpose');

      expect(agent).toMatchObject({
        name: 'general-purpose',
        level: 'builtin',
        filePath: '<builtin:general-purpose>',
        isBuiltin: true,
      });
    });

    it('should return null for invalid name', () => {
      expect(BuiltinAgentRegistry.getBuiltinAgent('invalid')).toBeNull();
      expect(BuiltinAgentRegistry.getBuiltinAgent('')).toBeNull();
    });
  });

  describe('isBuiltinAgent', () => {
    it('should return true for valid builtin agent names', () => {
      expect(BuiltinAgentRegistry.isBuiltinAgent('general-purpose')).toBe(true);
    });

    it('should return false for invalid names', () => {
      expect(BuiltinAgentRegistry.isBuiltinAgent('invalid')).toBe(false);
      expect(BuiltinAgentRegistry.isBuiltinAgent('')).toBe(false);
    });
  });

  describe('getBuiltinAgentNames', () => {
    it('should return array of agent names', () => {
      const names = BuiltinAgentRegistry.getBuiltinAgentNames();

      expect(names).toBeInstanceOf(Array);
      expect(names).toContain('general-purpose');
      expect(names.every((name) => typeof name === 'string')).toBe(true);
    });
  });

  describe('consistency', () => {
    it('should maintain consistency across all methods', () => {
      const agents = BuiltinAgentRegistry.getBuiltinAgents();
      const names = BuiltinAgentRegistry.getBuiltinAgentNames();

      // Names should match agents
      expect(names).toEqual(agents.map((agent) => agent.name));

      // Each name should be valid
      names.forEach((name) => {
        expect(BuiltinAgentRegistry.isBuiltinAgent(name)).toBe(true);
        expect(BuiltinAgentRegistry.getBuiltinAgent(name)).toBeDefined();
      });
    });
  });
});
