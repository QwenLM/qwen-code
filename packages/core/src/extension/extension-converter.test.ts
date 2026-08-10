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

import {
  convertCompatibleExtension,
  detectManifest,
} from './extension-converter.js';
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

describe('detectManifest', () => {
  it.each([
    {
      name: 'Claude marketplace',
      claude: 'marketplace',
      gemini: false,
      qoder: false,
      expected: { source: 'Claude', kind: 'marketplace' },
    },
    {
      name: 'Claude standalone',
      claude: 'standalone',
      gemini: false,
      qoder: false,
      expected: { source: 'Claude', kind: 'standalone' },
    },
    {
      name: 'Gemini',
      claude: null,
      gemini: true,
      qoder: false,
      expected: { source: 'Gemini' },
    },
    {
      name: 'Qoder',
      claude: null,
      gemini: false,
      qoder: true,
      expected: { source: 'Qoder' },
    },
    {
      name: 'Claude beats Gemini',
      claude: 'marketplace',
      gemini: true,
      qoder: false,
      expected: { source: 'Claude', kind: 'marketplace' },
    },
    {
      name: 'Claude beats Qoder',
      claude: 'marketplace',
      gemini: false,
      qoder: true,
      expected: { source: 'Claude', kind: 'marketplace' },
    },
    {
      name: 'Gemini beats Qoder',
      claude: null,
      gemini: true,
      qoder: true,
      expected: { source: 'Gemini' },
    },
    {
      name: 'no manifest',
      claude: null,
      gemini: false,
      qoder: false,
      expected: null,
    },
  ])('detects $name', ({ claude, gemini, qoder, expected }) => {
    mocks.isClaudePluginConfig.mockReturnValue(claude);
    mocks.isGeminiExtensionConfig.mockReturnValue(gemini);
    mocks.existsSync.mockImplementation((p: string) =>
      qoder ? p.endsWith(path.join('', QODER_PLUGIN_MANIFEST)) : false,
    );

    expect(detectManifest('/dir')).toEqual(expected);
  });

  it.each([
    {
      kind: 'marketplace',
      expected: { source: 'Claude', kind: 'marketplace' },
    },
    { kind: 'standalone', expected: { source: 'Claude', kind: 'standalone' } },
  ])(
    'returns Claude when a specified pluginName matches its $kind',
    ({ kind, expected }) => {
      mocks.isClaudePluginConfig.mockReturnValue(kind);

      expect(detectManifest('/dir', 'my-plugin')).toEqual(expected);
    },
  );

  it('propagates a detection error when pluginName is specified', () => {
    mocks.isClaudePluginConfig.mockImplementation(() => {
      throw new Error('Plugin "my-plugin" not found');
    });

    expect(() => detectManifest('/dir', 'my-plugin')).toThrow(
      'Plugin "my-plugin" not found',
    );
  });

  it.each([
    {
      name: 'Gemini',
      gemini: true,
      qoder: false,
      expected: { source: 'Gemini' },
    },
    {
      name: 'Qoder',
      gemini: false,
      qoder: true,
      expected: { source: 'Qoder' },
    },
  ])(
    'falls through to $name when Claude detection fails without pluginName',
    ({ gemini, qoder, expected }) => {
      mocks.isClaudePluginConfig.mockImplementation(() => {
        throw new Error('Invalid plugin manifest');
      });
      mocks.isGeminiExtensionConfig.mockReturnValue(gemini);
      mocks.existsSync.mockImplementation((p: string) =>
        qoder ? p.endsWith(path.join('', QODER_PLUGIN_MANIFEST)) : false,
      );

      expect(detectManifest('/dir')).toEqual(expected);
    },
  );

  it('falls through to Qoder when Gemini detection fails without pluginName', () => {
    mocks.isClaudePluginConfig.mockReturnValue(null);
    mocks.isGeminiExtensionConfig.mockImplementation(() => {
      throw new Error('Invalid gemini extension');
    });
    mocks.existsSync.mockImplementation((p: string) =>
      p.endsWith(path.join('', QODER_PLUGIN_MANIFEST)),
    );

    expect(detectManifest('/dir')).toEqual({ source: 'Qoder' });
  });

  it('throws the recorded detection error when no manifest matches', () => {
    mocks.isClaudePluginConfig.mockImplementation(() => {
      throw new Error('Invalid plugin manifest');
    });
    mocks.isGeminiExtensionConfig.mockImplementation(() => {
      throw new Error('Invalid gemini extension');
    });
    mocks.existsSync.mockReturnValue(false);

    expect(() => detectManifest('/dir')).toThrow('Invalid plugin manifest');
  });
});

describe('convertCompatibleExtension', () => {
  it('returns a native extension without probing converters', async () => {
    mocks.existsSync.mockReturnValue(true);

    const result = await convertCompatibleExtension('/dir');

    expect(result.originSource).toBe('QwenCode');
    expect(mocks.isClaudePluginConfig).not.toHaveBeenCalled();
    expect(mocks.isGeminiExtensionConfig).not.toHaveBeenCalled();
  });

  it('converts a detected Claude marketplace to its package', async () => {
    mocks.isClaudePluginConfig.mockReturnValue('marketplace');

    const result = await convertCompatibleExtension('/dir', 'my-plugin');

    expect(result.originSource).toBe('Claude');
    expect(result.extensionDir).toBe(convertedDir);
    expect(mocks.convertClaudePluginPackage).toHaveBeenCalledWith(
      '/dir',
      'my-plugin',
      undefined,
      undefined,
    );
  });

  it('converts a detected Claude standalone plugin', async () => {
    mocks.isClaudePluginConfig.mockReturnValue('standalone');

    const result = await convertCompatibleExtension('/dir');

    expect(result.originSource).toBe('Claude');
    expect(mocks.convertClaudePluginStandalone).toHaveBeenCalledWith('/dir');
  });

  it('converts a detected Gemini extension', async () => {
    mocks.isClaudePluginConfig.mockReturnValue(null);
    mocks.isGeminiExtensionConfig.mockReturnValue(true);

    const result = await convertCompatibleExtension('/dir');

    expect(result.originSource).toBe('Gemini');
    expect(mocks.convertGeminiExtensionPackage).toHaveBeenCalledWith('/dir');
  });

  it('converts a detected Qoder plugin', async () => {
    mocks.isClaudePluginConfig.mockReturnValue(null);
    mocks.isGeminiExtensionConfig.mockReturnValue(false);
    mocks.existsSync.mockImplementation((p: string) =>
      p.endsWith(path.join('', QODER_PLUGIN_MANIFEST)),
    );

    const result = await convertCompatibleExtension('/dir');

    expect(result.originSource).toBe('Qoder');
    expect(mocks.convertQoderPlugin).toHaveBeenCalledWith('/dir');
  });

  it('propagates a conversion failure for a matched manifest', async () => {
    mocks.isClaudePluginConfig.mockReturnValue('marketplace');
    mocks.convertClaudePluginPackage.mockRejectedValue(
      new Error('clone failed'),
    );
    mocks.isGeminiExtensionConfig.mockReturnValue(true);

    await expect(
      convertCompatibleExtension('/dir', 'my-plugin'),
    ).rejects.toThrow('clone failed');
    expect(mocks.convertGeminiExtensionPackage).not.toHaveBeenCalled();
  });
});
