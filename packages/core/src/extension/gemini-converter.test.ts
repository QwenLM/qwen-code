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
  // Imported inside the (hoisted) factory — the top-level `path` import isn't
  // initialized yet when this runs.
  const nodePath = await import('node:path');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    // The Gemini hooks probe calls statSync().isFile() to reject
    // directory-valued hooks/hooks.json. Tests mock this directly.
    statSync: vi.fn(
      () => ({ isFile: () => true, isDirectory: () => false }) as fs.Stats,
    ),
    // The symlink-confinement guard (realPathWithin) resolves both the config
    // path and its dir via realpathSync. These unit tests use in-memory mock
    // dirs that don't exist on disk; normalize via path.resolve (as the real
    // realpathSync would) so the config path and its dir share separators —
    // otherwise on Windows path.join() backslashes vs. the raw forward-slash
    // mock dir make the containment startsWith() spuriously fail.
    realpathSync: vi.fn((p: string) => nodePath.resolve(p)),
  };
});

describe('convertGeminiToQwenConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // readExtensionManifest checks existsSync before reading; these unit tests
    // mock readFileSync and assume the manifest file is present.
    vi.mocked(fs.existsSync).mockReturnValue(true);
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

  it('declares hooks when the default hooks/hooks.json file exists', () => {
    const mockDir = '/mock/extension/dir';
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ name: 'x', version: '1.0.0' }),
    );
    // Manifest exists; hooks/hooks.json also exists as a regular file
    // (The isRegularFile probe shares the statSync mock with existsSync).
    vi.mocked(fs.existsSync).mockImplementation(
      (p: unknown) =>
        String(p).endsWith('gemini-extension.json') ||
        String(p).endsWith(path.join('hooks', 'hooks.json')),
    );
    vi.mocked(fs.statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as fs.Stats);

    const result = convertGeminiToQwenConfig(mockDir);

    expect(result.hooks).toBe('hooks/hooks.json');
  });

  it('omits hooks when no default hooks/hooks.json file exists', () => {
    const mockDir = '/mock/extension/dir';
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ name: 'x', version: '1.0.0' }),
    );
    // Manifest exists; hooks/hooks.json does not.
    vi.mocked(fs.existsSync).mockImplementation(
      (p: unknown) =>
        String(p).endsWith('gemini-extension.json') &&
        !String(p).endsWith(path.join('hooks', 'hooks.json')),
    );

    const result = convertGeminiToQwenConfig(mockDir);

    expect(result.hooks).toBeUndefined();
  });

  it('omits hooks when the default hooks file resolves outside the extension', () => {
    const mockDir = '/mock/extension/dir';
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ name: 'x', version: '1.0.0' }),
    );
    // hooks/hooks.json exists (as a symlink) but its real target escapes the
    // extension; copyDirectory would refuse to ship it, so the manifest must
    // not advertise hooks pointing at a file that never materializes.
    vi.mocked(fs.existsSync).mockImplementation(
      (p: unknown) =>
        String(p).endsWith('gemini-extension.json') ||
        String(p).endsWith(path.join('hooks', 'hooks.json')),
    );
    vi.mocked(fs.realpathSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.includes('hooks.json')) {
        return '/outside/hooks.json';
      }
      return path.resolve(s);
    });

    const result = convertGeminiToQwenConfig(mockDir);

    expect(result.hooks).toBeUndefined();
  });

  it('omits hooks when hooks/hooks.json is a directory, not a file', () => {
    const mockDir = '/mock/extension/dir';
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ name: 'x', version: '1.0.0' }),
    );
    // hooks/hooks.json exists but resolves to a directory — the
    // isRegularFile probe must reject it so the runtime doesn't try to
    // read a directory as JSON.
    vi.mocked(fs.existsSync).mockImplementation(
      (p: unknown) =>
        String(p).endsWith('gemini-extension.json') ||
        String(p).endsWith(path.join('hooks', 'hooks.json')),
    );
    vi.mocked(fs.statSync).mockImplementation((p) => {
      const s = String(p);
      const isHooks = s.endsWith(path.join('hooks', 'hooks.json'));
      return { isFile: () => !isHooks, isDirectory: () => isHooks } as fs.Stats;
    });

    const result = convertGeminiToQwenConfig(mockDir);

    expect(result.hooks).toBeUndefined();
  });

  // Pin the top-level mcpServers container-shape guard — array / scalar
  // would otherwise install with zero servers or surface an opaque TypeError.
  it.each([
    ['array', '[]'],
    ['scalar number', '42'],
  ])('throws when top-level mcpServers is a %s', (_label, raw) => {
    const mockDir = '/mock/extension/dir';
    const geminiConfig = {
      name: 'gemini-shape-extension',
      version: '1.0.0',
      mcpServers: JSON.parse(raw) as unknown,
    };

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(geminiConfig));

    expect(() => convertGeminiToQwenConfig(mockDir)).toThrow(
      /Invalid MCP server "gemini-shape-extension": Invalid MCP configuration/,
    );
  });

  // Gemini treats mcpServers: null as absent (diverges from
  // Claude/Qoder, which throw).
  it('treats top-level mcpServers: null as absent (Gemini design choice)', () => {
    const mockDir = '/mock/extension/dir';
    const geminiConfig = {
      name: 'null-mcp-extension',
      version: '1.0.0',
      mcpServers: null,
    };

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(geminiConfig));

    const result = convertGeminiToQwenConfig(mockDir);
    expect(result.mcpServers).toBeUndefined();
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

  it('throws a precise error for a non-object MCP server entry', () => {
    const mockDir = '/mock/extension/dir';
    const invalidConfig = {
      name: 'test-extension',
      version: '1.0.0',
      mcpServers: { bad: null },
    };

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(invalidConfig));

    expect(() => convertGeminiToQwenConfig(mockDir)).toThrow(
      /server entries must be JSON objects/,
    );
  });

  it('throws a precise error when the manifest is absent', () => {
    const mockDir = '/mock/extension/dir';
    // readExtensionManifest returns null for a missing file; the converter
    // surfaces a clear not-found error instead of a bare deref.
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(() => convertGeminiToQwenConfig(mockDir)).toThrow(
      /Gemini extension config not found/,
    );
  });

  it('sanitizes control bytes from the extension dir in the surfaced not-found error', () => {
    const mockDir = '/mock/ext\u001b[2J\u001b[1;1Hdir';
    vi.mocked(fs.existsSync).mockReturnValue(false);

    let caught: unknown;
    try {
      convertGeminiToQwenConfig(mockDir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      'Gemini extension config not found',
    );
    expect((caught as Error).message).not.toContain('\u001b');
  });

  it('throws when gemini-extension.json resolves through a symlink outside the extension', () => {
    const mockDir = '/mock/extension/dir';
    // realPathWithin resolves the config path first: pretend it points outside
    // the extension dir (a symlink escape). The root resolves normally.
    vi.mocked(fs.realpathSync).mockReturnValueOnce(
      '/outside/extension/gemini-extension.json',
    );

    expect(() => convertGeminiToQwenConfig(mockDir)).toThrow(
      /resolves through a symlink outside/,
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

  it('throws for config content that is not a JSON object', () => {
    const mockDir = '/mock/invalid/dir';

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('null');

    expect(() => isGeminiExtensionConfig(mockDir)).toThrow(
      /expected a JSON object/,
    );
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

  it('throws when gemini-extension.json symlink escapes during detection', () => {
    const mockDir = '/mock/extension/dir';

    vi.mocked(fs.existsSync).mockReturnValue(true);
    // The config path resolves outside the extension dir (symlink escape);
    // detection must refuse to read it and report the escape.
    vi.mocked(fs.realpathSync).mockReturnValueOnce('/outside/path');

    expect(() => isGeminiExtensionConfig(mockDir)).toThrow(/symlink outside/);
  });
});

// Note: convertGeminiExtensionPackage() is tested through integration tests
// as it requires real file system operations
