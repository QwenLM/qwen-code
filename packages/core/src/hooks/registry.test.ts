/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { HookRegistry, createHookRegistry } from './registry.js';
import { HookType } from './types.js';

describe('HookRegistry', () => {
  describe('register', () => {
    it('should register a hook definition', () => {
      const registry = new HookRegistry();
      const definition = {
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test-hook' }],
      };
      registry.register(definition);
      expect(registry.count).toBe(1);
    });

    it('should register multiple definitions', () => {
      const registry = new HookRegistry();
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'hook1' }],
      });
      registry.register({
        matcher: 'ReadFile',
        hooks: [{ type: HookType.Command, command: 'hook2' }],
      });
      expect(registry.count).toBe(2);
    });

    it('should deduplicate identical definitions', () => {
      const registry = new HookRegistry();
      const definition = {
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test-hook' }],
      };
      registry.register(definition);
      registry.register(definition);
      expect(registry.count).toBe(1);
    });

    it('should validate definition when validation enabled', () => {
      const registry = new HookRegistry({ validate: true });
      expect(() => {
        registry.register({
          hooks: [], // Empty hooks should fail validation
        });
      }).toThrow('Hook definition must have at least one hook');
    });

    it('should validate command hook has non-empty command', () => {
      const registry = new HookRegistry({ validate: true });
      expect(() => {
        registry.register({
          hooks: [{ type: HookType.Command, command: '' }],
        });
      }).toThrow('Command hook must have a non-empty command');
    });
  });

  describe('unregister', () => {
    it('should unregister a definition', () => {
      const registry = new HookRegistry();
      const definition = {
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test-hook' }],
      };
      registry.register(definition);
      expect(registry.count).toBe(1);

      const result = registry.unregister(definition);
      expect(result).toBe(true);
      expect(registry.count).toBe(0);
    });

    it('should return false when unregistering non-existent definition', () => {
      const registry = new HookRegistry();
      const definition = {
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test-hook' }],
      };
      const result = registry.unregister(definition);
      expect(result).toBe(false);
    });
  });

  describe('unregisterByKey', () => {
    it('should unregister by key', () => {
      const registry = new HookRegistry();
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test-hook' }],
      });
      expect(registry.count).toBe(1);

      const result = registry.unregisterByKey('WriteFile::test-hook');
      expect(result).toBe(true);
      expect(registry.count).toBe(0);
    });
  });

  describe('getAllDefinitions', () => {
    it('should return all definitions', () => {
      const registry = new HookRegistry();
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'hook1' }],
      });
      registry.register({
        matcher: 'ReadFile',
        hooks: [{ type: HookType.Command, command: 'hook2' }],
      });

      const definitions = registry.getAllDefinitions();
      expect(definitions).toHaveLength(2);
    });

    it('should return empty array when no definitions', () => {
      const registry = new HookRegistry();
      const definitions = registry.getAllDefinitions();
      expect(definitions).toHaveLength(0);
    });
  });

  describe('getAllHookConfigs', () => {
    it('should return all hook configs flattened', () => {
      const registry = new HookRegistry();
      registry.register({
        matcher: 'WriteFile',
        hooks: [
          { type: HookType.Command, command: 'hook1' },
          { type: HookType.Command, command: 'hook2' },
        ],
      });

      const configs = registry.getAllHookConfigs();
      expect(configs).toHaveLength(2);
    });
  });

  describe('findByMatcher', () => {
    it('should find definitions by matcher', () => {
      const registry = new HookRegistry();
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'hook1' }],
      });
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'hook2' }],
      });
      registry.register({
        matcher: 'ReadFile',
        hooks: [{ type: HookType.Command, command: 'hook3' }],
      });

      const matches = registry.findByMatcher('WriteFile');
      // Two definitions with same matcher but different commands have different keys
      expect(matches).toHaveLength(2);
    });
  });

  describe('findMatchingTool', () => {
    it('should find definitions matching tool name', () => {
      const registry = new HookRegistry();
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'hook1' }],
      });
      registry.register({
        matcher: 'Read.*',
        hooks: [{ type: HookType.Command, command: 'hook2' }],
      });

      const writeMatches = registry.findMatchingTool('WriteFile');
      expect(writeMatches).toHaveLength(1);

      const readMatches = registry.findMatchingTool('ReadFile');
      expect(readMatches).toHaveLength(1);
    });

    it('should match wildcard definitions', () => {
      const registry = new HookRegistry();
      registry.register({
        hooks: [{ type: HookType.Command, command: 'universal-hook' }],
      });

      const matches = registry.findMatchingTool('AnyTool');
      expect(matches).toHaveLength(1);
    });
  });

  describe('clear', () => {
    it('should clear all definitions', () => {
      const registry = new HookRegistry();
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'hook1' }],
      });
      expect(registry.count).toBe(1);

      registry.clear();
      expect(registry.count).toBe(0);
    });
  });

  describe('loadFromConfig', () => {
    it('should load definitions from config object', () => {
      const registry = new HookRegistry();
      registry.loadFromConfig({
        hooks: [
          {
            matcher: 'WriteFile',
            hooks: [{ type: HookType.Command, command: 'hook1' }],
          },
          {
            matcher: 'ReadFile',
            hooks: [{ type: HookType.Command, command: 'hook2' }],
          },
        ],
      });
      expect(registry.count).toBe(2);
    });

    it('should handle config without hooks', () => {
      const registry = new HookRegistry();
      registry.loadFromConfig({});
      expect(registry.count).toBe(0);
    });
  });

  describe('exportToConfig', () => {
    it('should export definitions to config object', () => {
      const registry = new HookRegistry();
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'hook1' }],
      });

      const config = registry.exportToConfig();
      expect(config.hooks).toHaveLength(1);
      expect(config.hooks[0].matcher).toBe('WriteFile');
    });
  });

  describe('merge', () => {
    it('should merge another registry', () => {
      const registry1 = new HookRegistry();
      registry1.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'hook1' }],
      });

      const registry2 = new HookRegistry();
      registry2.register({
        matcher: 'ReadFile',
        hooks: [{ type: HookType.Command, command: 'hook2' }],
      });

      registry1.merge(registry2);
      expect(registry1.count).toBe(2);
    });
  });

  describe('initial definitions', () => {
    it('should load initial definitions from constructor', () => {
      const registry = new HookRegistry({
        definitions: [
          {
            matcher: 'WriteFile',
            hooks: [{ type: HookType.Command, command: 'hook1' }],
          },
        ],
      });
      expect(registry.count).toBe(1);
    });
  });
});

describe('createHookRegistry', () => {
  it('should create a new HookRegistry instance', () => {
    const registry = createHookRegistry();
    expect(registry).toBeInstanceOf(HookRegistry);
  });

  it('should pass config to registry', () => {
    const registry = createHookRegistry({ validate: true });
    expect(registry.count).toBe(0);
  });
});
