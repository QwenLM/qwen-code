/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock factories consumed by vi.mock below (module load time).
const mocks = vi.hoisted(() => ({
  convertClaudePluginStandalone: vi.fn(),
  convertClaudePluginPackage: vi.fn(),
  isClaudePluginConfig: vi.fn(),
  isClaudePluginStandaloneConfig: vi.fn(),
  convertGeminiExtensionPackage: vi.fn(),
  isGeminiExtensionConfig: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('./claude-converter.js', () => ({
  convertClaudePluginStandalone: mocks.convertClaudePluginStandalone,
  convertClaudePluginPackage: mocks.convertClaudePluginPackage,
  isClaudePluginConfig: mocks.isClaudePluginConfig,
  isClaudePluginStandaloneConfig: mocks.isClaudePluginStandaloneConfig,
}));

vi.mock('./gemini-converter.js', () => ({
  convertGeminiExtensionPackage: mocks.convertGeminiExtensionPackage,
  isGeminiExtensionConfig: mocks.isGeminiExtensionConfig,
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
}));

import { convertGeminiOrClaudeExtension } from './extension-converter.js';

const convertedDir = '/tmp/converted';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.existsSync.mockReturnValue(false);
  mocks.convertClaudePluginPackage.mockResolvedValue({ convertedDir });
  mocks.convertClaudePluginStandalone.mockResolvedValue({ convertedDir });
  mocks.convertGeminiExtensionPackage.mockResolvedValue({ convertedDir });
});

describe('convertGeminiOrClaudeExtension', () => {
  it('uses a native Qwen extension when qwen-extension.json exists', async () => {
    mocks.existsSync.mockReturnValue(true);

    const result = await convertGeminiOrClaudeExtension('/dir');

    expect(result.originSource).toBe('QwenCode');
    expect(result.extensionDir).toBe('/dir');
    expect(mocks.convertClaudePluginPackage).not.toHaveBeenCalled();
    expect(mocks.convertGeminiExtensionPackage).not.toHaveBeenCalled();
  });

  it('routes to the Claude marketplace converter when pluginName matches a marketplace entry', async () => {
    mocks.isClaudePluginConfig.mockReturnValue(true);

    const result = await convertGeminiOrClaudeExtension('/dir', 'my-plugin');

    expect(result.originSource).toBe('Claude');
    expect(result.extensionDir).toBe(convertedDir);
    expect(mocks.convertClaudePluginPackage).toHaveBeenCalledWith(
      '/dir',
      'my-plugin',
      undefined,
      undefined,
    );
    expect(mocks.convertGeminiExtensionPackage).not.toHaveBeenCalled();
  });

  it('routes to the standalone Claude converter when plugin.json is present', async () => {
    mocks.isClaudePluginStandaloneConfig.mockReturnValue(true);

    const result = await convertGeminiOrClaudeExtension('/dir');

    expect(result.originSource).toBe('Claude');
    expect(result.extensionDir).toBe(convertedDir);
    expect(mocks.convertClaudePluginStandalone).toHaveBeenCalledWith('/dir');
    expect(mocks.convertGeminiExtensionPackage).not.toHaveBeenCalled();
  });

  it('falls back to Gemini when no Claude manifest is present', async () => {
    mocks.isGeminiExtensionConfig.mockReturnValue(true);

    const result = await convertGeminiOrClaudeExtension('/dir');

    expect(result.originSource).toBe('Gemini');
    expect(result.extensionDir).toBe(convertedDir);
    expect(mocks.convertGeminiExtensionPackage).toHaveBeenCalledWith('/dir');
  });

  it('prefers Claude over Gemini when both manifests are present', async () => {
    mocks.isClaudePluginConfig.mockReturnValue(true);
    mocks.isGeminiExtensionConfig.mockReturnValue(true);

    const result = await convertGeminiOrClaudeExtension('/dir', 'my-plugin');

    expect(result.originSource).toBe('Claude');
    expect(mocks.convertClaudePluginPackage).toHaveBeenCalled();
    expect(mocks.convertGeminiExtensionPackage).not.toHaveBeenCalled();
  });
});
