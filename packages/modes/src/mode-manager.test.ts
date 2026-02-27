/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ModeManager,
  DEFAULT_MODE,
  BUILTIN_MODES,
  ARCHITECT_MODE,
  CODE_MODE,
} from '../src/index.js';
import type { CustomModeConfig } from '../mode-definition.js';

describe('ModeManager', () => {
  let modeManager: ModeManager;

  beforeEach(() => {
    modeManager = new ModeManager();
  });

  describe('constructor', () => {
    it('should initialize with default mode (Code)', () => {
      expect(modeManager.getCurrentMode().id).toBe('code');
    });

    it('should initialize with specified default mode', () => {
      const manager = new ModeManager('architect');
      expect(manager.getCurrentMode().id).toBe('architect');
    });
  });

  describe('fromSettings', () => {
    it('should create manager from settings with custom modes', () => {
      const customMode: CustomModeConfig = {
        id: 'test-mode',
        name: 'Test Mode',
        description: 'A test mode',
        roleSystemPrompt: 'You are a test mode agent.',
        allowedTools: ['read_file', 'memory'],
        useCases: ['Testing'],
      };

      const manager = ModeManager.fromSettings({
        customModes: [customMode],
        defaultMode: 'test-mode',
        globalInstructions: 'Global test instructions',
      });

      expect(manager.getCurrentMode().id).toBe('test-mode');
      expect(manager.getGlobalInstructions()).toBe('Global test instructions');
    });

    it('should handle settings with only global instructions', () => {
      const manager = ModeManager.fromSettings({
        globalInstructions: 'Be helpful and concise',
      });

      expect(manager.getGlobalInstructions()).toBe('Be helpful and concise');
      expect(manager.getCurrentMode().id).toBe('code');
    });
  });

  describe('switchMode', () => {
    it('should switch to built-in mode', async () => {
      const newMode = await modeManager.switchMode('architect');
      expect(newMode.id).toBe('architect');
      expect(modeManager.getCurrentMode().id).toBe('architect');
    });

    it('should throw error for non-existent mode', async () => {
      await expect(
        modeManager.switchMode('non-existent-mode'),
      ).rejects.toThrow('Режим "non-existent-mode" не найден');
    });

    it('should switch to custom mode', async () => {
      const customMode: CustomModeConfig = {
        id: 'custom-test',
        name: 'Custom Test',
        description: 'Test',
        roleSystemPrompt: 'Test prompt',
        allowedTools: ['read_file'],
      };

      modeManager.registerCustomMode(customMode);
      const newMode = await modeManager.switchMode('custom-test');
      expect(newMode.id).toBe('custom-test');
    });
  });

  describe('registerCustomMode', () => {
    it('should register custom mode successfully', () => {
      const customMode: CustomModeConfig = {
        id: 'custom',
        name: 'Custom',
        description: 'Custom mode',
        roleSystemPrompt: 'Custom prompt',
        allowedTools: ['read_file'],
      };

      expect(() => modeManager.registerCustomMode(customMode)).not.toThrow();
      expect(modeManager.getAvailableModes()).toHaveLength(
        BUILTIN_MODES.length + 1,
      );
    });

    it('should throw error when registering mode with built-in ID', () => {
      const customMode: CustomModeConfig = {
        id: 'architect',
        name: 'My Architect',
        description: 'Custom architect',
        roleSystemPrompt: 'Custom',
        allowedTools: ['read_file'],
      };

      expect(() => modeManager.registerCustomMode(customMode)).toThrow(
        'Нельзя зарегистрировать кастомный режим с ID "architect"',
      );
    });
  });

  describe('getAvailableModes', () => {
    it('should return all built-in modes by default', () => {
      const modes = modeManager.getAvailableModes();
      expect(modes).toHaveLength(BUILTIN_MODES.length);
      expect(modes.map((m) => m.id)).toEqual(
        expect.arrayContaining(BUILTIN_MODES.map((m) => m.id)),
      );
    });

    it('should include custom modes', () => {
      const customMode: CustomModeConfig = {
        id: 'custom-1',
        name: 'Custom 1',
        description: 'Test',
        roleSystemPrompt: 'Test',
        allowedTools: ['read_file'],
      };

      modeManager.registerCustomMode(customMode);
      const modes = modeManager.getAvailableModes();
      expect(modes).toHaveLength(BUILTIN_MODES.length + 1);
    });
  });

  describe('onModeChange', () => {
    it('should call callback when mode changes', async () => {
      const callback = vi.fn();
      modeManager.onModeChange(callback);

      await modeManager.switchMode('architect');

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'architect' }),
      );
    });

    it('should unsubscribe callback', async () => {
      const callback = vi.fn();
      const unsubscribe = modeManager.onModeChange(callback);
      unsubscribe();

      await modeManager.switchMode('architect');

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('getModeById', () => {
    it('should return current mode when ID matches', () => {
      const mode = modeManager.getModeById('code');
      expect(mode?.id).toBe('code');
    });

    it('should return built-in mode by ID', () => {
      const mode = modeManager.getModeById('architect');
      expect(mode?.id).toBe('architect');
    });

    it('should return custom mode by ID', () => {
      const customMode: CustomModeConfig = {
        id: 'custom-lookup',
        name: 'Custom',
        description: 'Test',
        roleSystemPrompt: 'Test',
        allowedTools: ['read_file'],
      };

      modeManager.registerCustomMode(customMode);
      const mode = modeManager.getModeById('custom-lookup');
      expect(mode?.id).toBe('custom-lookup');
    });

    it('should return undefined for non-existent mode', () => {
      const mode = modeManager.getModeById('non-existent');
      expect(mode).toBeUndefined();
    });
  });

  describe('resetToDefault', () => {
    it('should reset to default mode', async () => {
      await modeManager.switchMode('architect');
      expect(modeManager.getCurrentMode().id).toBe('architect');

      const resetMode = await modeManager.resetToDefault();
      expect(resetMode.id).toBe('code');
      expect(modeManager.getCurrentMode().id).toBe('code');
    });
  });
});

describe('Built-in Modes', () => {
  it('should have all required modes defined', () => {
    const modeIds = BUILTIN_MODES.map((m) => m.id);
    expect(modeIds).toContain('architect');
    expect(modeIds).toContain('code');
    expect(modeIds).toContain('ask');
    expect(modeIds).toContain('debug');
    expect(modeIds).toContain('review');
    expect(modeIds).toContain('orchestrator');
  });

  it('should have valid tool lists for each mode', () => {
    for (const mode of BUILTIN_MODES) {
      expect(mode.allowedTools).toBeDefined();
      expect(mode.allowedTools).toBeInstanceOf(Array);
      expect(mode.allowedTools.length).toBeGreaterThan(0);
    }
  });

  it('should have safety constraints for each mode', () => {
    for (const mode of BUILTIN_MODES) {
      expect(mode.safetyConstraints).toBeDefined();
      expect(mode.safetyConstraints).toBeInstanceOf(Array);
    }
  });

  it('should have use cases for each mode', () => {
    for (const mode of BUILTIN_MODES) {
      expect(mode.useCases).toBeDefined();
      expect(mode.useCases).toBeInstanceOf(Array);
      expect(mode.useCases.length).toBeGreaterThan(0);
    }
  });
});

describe('Architect Mode', () => {
  it('should have read-only tools', () => {
    expect(ARCHITECT_MODE.allowedTools).not.toContain('write_file');
    expect(ARCHITECT_MODE.allowedTools).not.toContain('edit');
    expect(ARCHITECT_MODE.allowedTools).not.toContain('shell');
  });

  it('should have planning-focused tools', () => {
    expect(ARCHITECT_MODE.allowedTools).toContain('read_file');
    expect(ARCHITECT_MODE.allowedTools).toContain('list_dir');
    expect(ARCHITECT_MODE.allowedTools).toContain('todo_write');
  });
});

describe('Code Mode', () => {
  it('should have full write access', () => {
    expect(CODE_MODE.allowedTools).toContain('write_file');
    expect(CODE_MODE.allowedTools).toContain('edit');
  });

  it('should have shell access', () => {
    expect(CODE_MODE.allowedTools).toContain('shell');
  });
});
