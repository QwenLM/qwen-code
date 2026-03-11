/**
 * @license
 * Copyright 2025 Google LLC
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
});
