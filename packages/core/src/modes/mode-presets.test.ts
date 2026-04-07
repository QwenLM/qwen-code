/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ModePresetRegistry, BUILTIN_PRESETS } from './mode-presets.js';

describe('ModePresetRegistry', () => {
  let registry: ModePresetRegistry;

  beforeEach(() => {
    registry = new ModePresetRegistry();
  });

  describe('constructor', () => {
    it('should register all built-in presets', () => {
      const presets = registry.getAllPresets();
      expect(presets).toHaveLength(BUILTIN_PRESETS.length);

      const names = presets.map((p) => p.name);
      expect(names).toContain('react-app');
      expect(names).toContain('api-service');
      expect(names).toContain('data-pipeline');
      expect(names).toContain('full-stack');
      expect(names).toContain('mobile-app');
      expect(names).toContain('cli-tool');
    });
  });

  describe('getPreset', () => {
    it('should return a preset by name', () => {
      const preset = registry.getPreset('react-app');

      expect(preset).toBeDefined();
      expect(preset?.name).toBe('react-app');
      expect(preset?.displayName).toBe('React Application');
      expect(preset?.icon).toBe('⚛️');
    });

    it('should return undefined for unknown preset', () => {
      expect(registry.getPreset('nonexistent')).toBeUndefined();
    });
  });

  describe('getAllPresets', () => {
    it('should return all presets', () => {
      const presets = registry.getAllPresets();
      expect(presets.length).toBeGreaterThanOrEqual(6);
    });

    it('should include preset properties', () => {
      const presets = registry.getAllPresets();
      const reactApp = presets.find((p) => p.name === 'react-app');

      expect(reactApp).toBeDefined();
      expect(reactApp?.defaultMode).toBe('developer');
      expect(reactApp?.workflow).toBeDefined();
      expect(reactApp?.projectType).toBeDefined();
    });
  });

  describe('registerPreset', () => {
    it('should register a custom preset', () => {
      const customPreset = {
        name: 'custom-preset',
        displayName: 'Custom Preset',
        description: 'A custom preset',
        icon: '🎯',
        defaultMode: 'developer',
      };

      registry.registerPreset(customPreset);

      expect(registry.getPreset('custom-preset')).toBeDefined();
      expect(registry.getPreset('custom-preset')?.displayName).toBe(
        'Custom Preset',
      );
    });

    it('should overwrite existing preset with same name', () => {
      const original = registry.getPreset('react-app');
      expect(original?.displayName).toBe('React Application');

      registry.registerPreset({
        name: 'react-app',
        displayName: 'Overwritten React',
        description: 'Updated',
        icon: '⚛️',
        defaultMode: 'developer',
      });

      expect(registry.getPreset('react-app')?.displayName).toBe(
        'Overwritten React',
      );
    });
  });

  describe('detectPreset', () => {
    it('should detect react-app preset by files', async () => {
      const files = [
        'package.json',
        'src/App.tsx',
        'src/components/Button.tsx',
        'vite.config.ts',
      ];
      const dependencies = ['react', 'react-dom'];

      const preset = await registry.detectPreset(
        '/project',
        files,
        dependencies,
      );

      expect(preset).toBeDefined();
      expect(preset?.name).toBe('react-app');
    });

    it('should detect api-service preset by files', async () => {
      const files = [
        'package.json',
        'Dockerfile',
        'src/routes/auth.ts',
        'prisma/schema.prisma',
      ];
      const dependencies = ['express', 'prisma'];

      const preset = await registry.detectPreset(
        '/project',
        files,
        dependencies,
      );

      expect(preset).toBeDefined();
      expect(preset?.name).toBe('api-service');
    });

    it('should detect data-pipeline preset by files', async () => {
      const files = ['requirements.txt', 'pipelines/etl.py', 'Dockerfile'];
      const dependencies = ['pandas', 'apache-beam'];

      const preset = await registry.detectPreset(
        '/project',
        files,
        dependencies,
      );

      expect(preset).toBeDefined();
      expect(preset?.name).toBe('data-pipeline');
    });

    it('should return null when no preset matches', async () => {
      const files = ['random.txt'];
      const dependencies = ['unknown-lib'];

      const preset = await registry.detectPreset(
        '/project',
        files,
        dependencies,
      );

      expect(preset).toBeNull();
    });

    it('should score higher on dependency matches', async () => {
      // Files alone might not be enough, but with deps it should match
      const files = ['package.json'];
      const dependencies = ['react', 'react-dom', 'next'];

      const preset = await registry.detectPreset(
        '/project',
        files,
        dependencies,
      );

      expect(preset).toBeDefined();
      expect(preset?.name).toBe('react-app');
    });

    it('should detect mobile-app preset', async () => {
      const files = ['pubspec.yaml', 'lib/main.dart', 'ios/Runner.xcodeproj'];
      const dependencies = ['flutter'];

      const preset = await registry.detectPreset(
        '/project',
        files,
        dependencies,
      );

      expect(preset).toBeDefined();
      expect(preset?.name).toBe('mobile-app');
    });

    it('should detect cli-tool preset', async () => {
      const files = ['package.json', 'bin/cli.js', 'src/commands/run.ts'];
      const dependencies = [];

      const preset = await registry.detectPreset(
        '/project',
        files,
        dependencies,
      );

      expect(preset).toBeDefined();
      expect(preset?.name).toBe('cli-tool');
    });
  });

  describe('built-in presets content', () => {
    it('should have valid workflow for react-app', () => {
      const preset = registry.getPreset('react-app');
      expect(preset?.workflow).toEqual([
        'product',
        'architect',
        'developer',
        'tester',
        'reviewer',
      ]);
    });

    it('should have valid quickStart for react-app', () => {
      const preset = registry.getPreset('react-app');
      expect(preset?.quickStart).toBeDefined();
      expect(preset?.quickStart?.length).toBeGreaterThan(0);
    });

    it('should have modes config for react-app', () => {
      const preset = registry.getPreset('react-app');
      expect(preset?.modes?.developer).toBeDefined();
      expect(preset?.modes?.developer?.temperatureOverride).toBe(0.5);
    });

    it('should have recommended subagents', () => {
      const preset = registry.getPreset('react-app');
      expect(preset?.recommendedSubagents).toContain('general-purpose');
      expect(preset?.recommendedSubagents).toContain('Explore');
    });

    it('should have hooks in preset modes', () => {
      const preset = registry.getPreset('react-app');
      const devConfig = preset?.modes?.developer;
      expect(devConfig?.hooks).toBeDefined();
      expect(devConfig?.hooks?.length).toBeGreaterThan(0);
    });
  });
});
