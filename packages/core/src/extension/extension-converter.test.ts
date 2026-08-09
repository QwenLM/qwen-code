/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';

// Hoisted mock factories consumed by vi.mock below (module load time).
const mocks = vi.hoisted(() => ({
  convertClaudePluginStandalone: vi.fn(),
  convertClaudePluginPackage: vi.fn(),
  isClaudePluginConfig: vi.fn(),
  convertGeminiExtensionPackage: vi.fn(),
  isGeminiExtensionConfig: vi.fn(),
  convertQoderPlugin: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('./claude-converter.js', () => ({
  convertClaudePluginStandalone: mocks.convertClaudePluginStandalone,
  convertClaudePluginPackage: mocks.convertClaudePluginPackage,
  isClaudePluginConfig: mocks.isClaudePluginConfig,
}));

vi.mock('./gemini-converter.js', () => ({
  convertGeminiExtensionPackage: mocks.convertGeminiExtensionPackage,
  isGeminiExtensionConfig: mocks.isGeminiExtensionConfig,
}));

vi.mock('./qoder-converter.js', () => ({
  convertQoderPlugin: mocks.convertQoderPlugin,
  QODER_PLUGIN_MANIFEST: '.qoder-plugin/plugin.json',
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
}));

import { convertCompatibleExtension } from './extension-converter.js';
import { EXTENSIONS_CONFIG_FILENAME } from './variables.js';
import { QODER_PLUGIN_MANIFEST } from './qoder-converter.js';

const convertedDir = '/tmp/converted';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.existsSync.mockReturnValue(false);
  mocks.convertClaudePluginPackage.mockResolvedValue({ convertedDir });
  mocks.convertClaudePluginStandalone.mockResolvedValue({ convertedDir });
  mocks.convertGeminiExtensionPackage.mockResolvedValue({ convertedDir });
  mocks.convertQoderPlugin.mockResolvedValue({ convertedDir });
});

describe('convertCompatibleExtension', () => {
  // Dispatcher order: native → Claude(marketplace/standalone) → Gemini → Qoder.
  // "single" rows assert each converter wins alone; "priority" rows assert the
  // higher-ranked converter wins when both are present.
  it.each([
    // single-manifest routing
    {
      name: 'native manifest',
      native: true,
      claude: null,
      gemini: false,
      qoder: false,
      expected: 'QwenCode',
    },
    {
      name: 'Claude marketplace manifest',
      native: false,
      claude: 'marketplace',
      gemini: false,
      qoder: false,
      expected: 'Claude',
    },
    {
      name: 'Claude standalone manifest',
      native: false,
      claude: 'standalone',
      gemini: false,
      qoder: false,
      expected: 'Claude',
    },
    {
      name: 'Gemini manifest',
      native: false,
      claude: null,
      gemini: true,
      qoder: false,
      expected: 'Gemini',
    },
    {
      name: 'Qoder manifest',
      native: false,
      claude: null,
      gemini: false,
      qoder: true,
      expected: 'Qoder',
    },
    // priority pairs
    {
      name: 'native beats Claude',
      native: true,
      claude: 'marketplace',
      gemini: false,
      qoder: false,
      expected: 'QwenCode',
    },
    {
      name: 'native beats Gemini',
      native: true,
      claude: null,
      gemini: true,
      qoder: false,
      expected: 'QwenCode',
    },
    {
      name: 'Claude beats Gemini',
      native: false,
      claude: 'standalone',
      gemini: true,
      qoder: false,
      expected: 'Claude',
    },
    {
      name: 'Gemini beats Qoder',
      native: false,
      claude: null,
      gemini: true,
      qoder: true,
      expected: 'Gemini',
    },
    {
      name: 'no manifest falls through',
      native: false,
      claude: null,
      gemini: false,
      qoder: false,
      expected: 'QwenCode',
    },
  ])(
    'routes a $name to $expected',
    async ({ native, claude, gemini, qoder, expected }) => {
      mocks.isClaudePluginConfig.mockReturnValue(claude);
      mocks.isGeminiExtensionConfig.mockReturnValue(gemini);
      mocks.existsSync.mockImplementation((p: string) => {
        if (native && p.endsWith(EXTENSIONS_CONFIG_FILENAME)) return true;
        if (qoder && p.endsWith(path.join('', QODER_PLUGIN_MANIFEST)))
          return true;
        return false;
      });

      const result = await convertCompatibleExtension('/dir', 'my-plugin');

      expect(result.originSource).toBe(expected);
    },
  );

  it('routes a native extension without probing converters', async () => {
    mocks.existsSync.mockReturnValue(true);

    const result = await convertCompatibleExtension('/dir');

    expect(result.originSource).toBe('QwenCode');
    expect(mocks.isClaudePluginConfig).not.toHaveBeenCalled();
    expect(mocks.isGeminiExtensionConfig).not.toHaveBeenCalled();
  });

  it('throws when pluginName is not listed in an existing marketplace', async () => {
    mocks.isClaudePluginConfig.mockImplementation(() => {
      throw new Error('Plugin my-plugin not found in marketplace.json');
    });

    await expect(
      convertCompatibleExtension('/dir', 'my-plugin'),
    ).rejects.toThrow('Plugin my-plugin not found in marketplace.json');
  });

  it('falls back to Gemini when the Claude manifest is defective', async () => {
    mocks.isClaudePluginConfig.mockImplementation(() => {
      throw new Error('defective claude manifest');
    });
    mocks.isGeminiExtensionConfig.mockReturnValue(true);

    const result = await convertCompatibleExtension('/dir');

    expect(result.originSource).toBe('Gemini');
    expect(mocks.convertGeminiExtensionPackage).toHaveBeenCalledWith('/dir');
  });
});
