/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptRegistry } from './prompt-registry.js';
import type { DiscoveredMCPPrompt } from '../tools/mcp-client.js';

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makePrompt(name: string, serverName: string): DiscoveredMCPPrompt {
  return {
    name,
    serverName,
    invoke: vi.fn(),
  };
}

describe('PromptRegistry', () => {
  let registry: PromptRegistry;

  beforeEach(() => {
    registry = new PromptRegistry();
  });

  describe('registerPrompt', () => {
    it('should register a prompt by name', () => {
      const prompt = makePrompt('greet', 'server-a');
      registry.registerPrompt(prompt);

      expect(registry.getPrompt('greet')).toBe(prompt);
    });

    it('should rename duplicate prompts with server prefix', () => {
      const prompt1 = makePrompt('greet', 'server-a');
      const prompt2 = makePrompt('greet', 'server-b');

      registry.registerPrompt(prompt1);
      registry.registerPrompt(prompt2);

      expect(registry.getPrompt('greet')).toBe(prompt1);
      const renamed = registry.getPrompt('server-b_greet');
      expect(renamed).toBeDefined();
      expect(renamed!.serverName).toBe('server-b');
      expect(renamed!.name).toBe('server-b_greet');
      expect(renamed!.invoke).toBe(prompt2.invoke);
    });
  });

  describe('getAllPrompts', () => {
    it('should return empty array when no prompts registered', () => {
      expect(registry.getAllPrompts()).toEqual([]);
    });

    it('should return all prompts sorted by name', () => {
      registry.registerPrompt(makePrompt('zulu', 'server-a'));
      registry.registerPrompt(makePrompt('alpha', 'server-a'));
      registry.registerPrompt(makePrompt('mike', 'server-b'));

      const all = registry.getAllPrompts();
      expect(all.map((p) => p.name)).toEqual(['alpha', 'mike', 'zulu']);
    });
  });

  describe('getPrompt', () => {
    it('should return undefined for non-existent prompt', () => {
      expect(registry.getPrompt('nonexistent')).toBeUndefined();
    });
  });

  describe('getPromptsByServer', () => {
    it('should return prompts from a specific server', () => {
      registry.registerPrompt(makePrompt('a', 'server-a'));
      registry.registerPrompt(makePrompt('b', 'server-a'));
      registry.registerPrompt(makePrompt('c', 'server-b'));

      const serverAPrompts = registry.getPromptsByServer('server-a');
      expect(serverAPrompts).toHaveLength(2);
      expect(serverAPrompts.map((p) => p.name)).toEqual(['a', 'b']);
    });

    it('should return empty array for unknown server', () => {
      expect(registry.getPromptsByServer('unknown')).toEqual([]);
    });

    it('should return prompts sorted by name', () => {
      registry.registerPrompt(makePrompt('z-prompt', 'server-a'));
      registry.registerPrompt(makePrompt('a-prompt', 'server-a'));

      const prompts = registry.getPromptsByServer('server-a');
      expect(prompts.map((p) => p.name)).toEqual(['a-prompt', 'z-prompt']);
    });
  });

  describe('clear', () => {
    it('should remove all prompts', () => {
      registry.registerPrompt(makePrompt('a', 'server-a'));
      registry.registerPrompt(makePrompt('b', 'server-b'));

      registry.clear();

      expect(registry.getAllPrompts()).toEqual([]);
    });
  });

  describe('removePromptsByServer', () => {
    it('should remove only prompts from the specified server', () => {
      registry.registerPrompt(makePrompt('a', 'server-a'));
      registry.registerPrompt(makePrompt('b', 'server-a'));
      registry.registerPrompt(makePrompt('c', 'server-b'));

      registry.removePromptsByServer('server-a');

      const remaining = registry.getAllPrompts();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe('c');
    });

    it('should do nothing for unknown server', () => {
      registry.registerPrompt(makePrompt('a', 'server-a'));

      registry.removePromptsByServer('unknown');

      expect(registry.getAllPrompts()).toHaveLength(1);
    });
  });

  describe('SystemPromptLayer management & assembleLayeredPrompt', () => {
    it('should register and retrieve a system prompt layer', () => {
      registry.registerPromptLayer({
        id: 'core-base',
        category: 'core_instructions',
        priority: 1,
        content: 'You are an AI coding assistant.',
      });

      const layer = registry.getPromptLayer('core-base');
      expect(layer).toBeDefined();
      expect(layer?.content).toBe('You are an AI coding assistant.');
    });

    it('should throw an error when registering empty or invalid layers', () => {
      expect(() =>
        registry.registerPromptLayer({
          id: '',
          category: 'persona',
          priority: 1,
          content: 'valid',
        }),
      ).toThrow();

      expect(() =>
        registry.registerPromptLayer({
          id: 'invalid-content',
          category: 'persona',
          priority: 1,
          content: '   ',
        }),
      ).toThrow();
    });

    it('should correctly assemble layered prompts ordering by category then priority', () => {
      registry.registerPromptLayer({
        id: 'volatile-mem',
        category: 'volatile_context',
        priority: 1,
        content: '[Volatile Memory Context]',
      });
      registry.registerPromptLayer({
        id: 'core-base',
        category: 'core_instructions',
        priority: 10,
        content: '[Core Base Instructions]',
      });
      registry.registerPromptLayer({
        id: 'skills-layer',
        category: 'skills',
        priority: 5,
        content: '[Loaded Skills List]',
      });
      registry.registerPromptLayer({
        id: 'persona-layer',
        category: 'persona',
        priority: 1,
        content: '[Agent Persona Persona]',
      });

      const assembled = registry.assembleLayeredPrompt();

      // Expected category order: core_instructions (10) -> persona (20) -> skills (40) -> volatile_context (60)
      expect(assembled).toBe(
        '[Core Base Instructions]\n\n[Agent Persona Persona]\n\n[Loaded Skills List]\n\n[Volatile Memory Context]',
      );
    });

    it('should delete specified layers and reset upon clear', () => {
      registry.registerPromptLayer({
        id: 'layer-1',
        category: 'core_instructions',
        priority: 1,
        content: 'Layer 1',
      });
      expect(registry.removePromptLayer('layer-1')).toBe(true);
      expect(registry.getPromptLayer('layer-1')).toBeUndefined();

      registry.registerPromptLayer({
        id: 'layer-2',
        category: 'persona',
        priority: 2,
        content: 'Layer 2',
      });
      registry.clear();
      expect(registry.assembleLayeredPrompt()).toBe('');
    });
  });
});
