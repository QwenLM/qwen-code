/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  convertGeminiToQwenConfig,
  isGeminiExtensionConfig,
  type GeminiExtensionConfig,
} from './gemini-converter.js';

// Mock fs module
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

describe('convertGeminiToQwenConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should convert basic Gemini config from directory', () => {
    const mockDir = '/mock/extension/dir';
    const geminiConfig: GeminiExtensionConfig = {
      name: 'test-extension',
      version: '1.0.0',
    };

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(geminiConfig));

    const result = convertGeminiToQwenConfig(mockDir);

    expect(result.name).toBe('test-extension');
    expect(result.version).toBe('1.0.0');
    expect(fs.readFileSync).toHaveBeenCalledWith(
      path.join(mockDir, 'gemini-extension.json'),
      'utf-8',
    );
  });

  it('should convert config with all optional fields', () => {
    const mockDir = '/mock/extension/dir';
    const geminiConfig = {
      name: 'full-extension',
      version: '2.0.0',
      mcpServers: { server1: {} },
      contextFileName: 'context.txt',
      settings: [
        { name: 'Setting1', envVar: 'VAR1', description: 'Test setting' },
      ],
    };

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(geminiConfig));

    const result = convertGeminiToQwenConfig(mockDir);

    expect(result.name).toBe('full-extension');
    expect(result.version).toBe('2.0.0');
    expect(result.mcpServers).toEqual({ server1: {} });
    expect(result.contextFileName).toBe('context.txt');
    expect(result.settings).toHaveLength(1);
    expect(result.settings?.[0].name).toBe('Setting1');
  });

  it('should throw error for missing name', () => {
    const mockDir = '/mock/extension/dir';
    const invalidConfig = {
      version: '1.0.0',
    };

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(invalidConfig));

    expect(() => convertGeminiToQwenConfig(mockDir)).toThrow(
      'Gemini extension config must have name and version fields',
    );
  });

  it('should throw error for missing version', () => {
    const mockDir = '/mock/extension/dir';
    const invalidConfig = {
      name: 'test-extension',
    };

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(invalidConfig));

    expect(() => convertGeminiToQwenConfig(mockDir)).toThrow(
      'Gemini extension config must have name and version fields',
    );
  });
});

describe('isGeminiExtensionConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should identify Gemini extension directory with valid config', () => {
    const mockDir = '/mock/extension/dir';
    const mockConfig = {
      name: 'test',
      version: '1.0.0',
      settings: [{ name: 'Test', envVar: 'TEST', description: 'Test' }],
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockConfig));

    expect(isGeminiExtensionConfig(mockDir)).toBe(true);

    expect(fs.existsSync).toHaveBeenCalledWith(
      path.join(mockDir, 'gemini-extension.json'),
    );
  });

  it('should return false when gemini-extension.json does not exist', () => {
    const mockDir = '/mock/nonexistent/dir';

    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(isGeminiExtensionConfig(mockDir)).toBe(false);
  });

  it('should return false for invalid config content', () => {
    const mockDir = '/mock/invalid/dir';

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('null');

    expect(isGeminiExtensionConfig(mockDir)).toBe(false);
  });

  it('should return false for config missing required fields', () => {
    const mockDir = '/mock/invalid/dir';
    const invalidConfig = {
      name: 'test',
      // missing version
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(invalidConfig));

    expect(isGeminiExtensionConfig(mockDir)).toBe(false);
  });

  it('should return true for basic config without settings', () => {
    const mockDir = '/mock/extension/dir';
    const basicConfig = {
      name: 'test',
      version: '1.0.0',
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(basicConfig));

    expect(isGeminiExtensionConfig(mockDir)).toBe(true);
  });
});

// Note: convertGeminiExtensionPackage() is tested through integration tests
// as it requires real file system operations
