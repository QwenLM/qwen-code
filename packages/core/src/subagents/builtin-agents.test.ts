/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
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
