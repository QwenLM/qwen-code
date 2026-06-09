/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  convertGeminiToQwenConfig,
  convertGeminiExtensionPackage,
  isGeminiExtensionConfig,
  type GeminiExtensionConfig,
} from './gemini-converter.js';

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

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

describe('convertGeminiExtensionPackage - auto-detection', () => {
  let testDir: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fs.existsSync).mockImplementation(actualFs.existsSync);
    vi.mocked(fs.readFileSync).mockImplementation(
      actualFs.readFileSync as typeof fs.readFileSync,
    );
    testDir = actualFs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-'));
    actualFs.writeFileSync(
      path.join(testDir, 'gemini-extension.json'),
      JSON.stringify({ name: 'test-ext', version: '1.0.0' }),
    );
  });

  afterEach(() => {
    actualFs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should auto-detect non-empty agents directory', async () => {
    const agentsDir = path.join(testDir, 'agents');
    actualFs.mkdirSync(agentsDir);
    actualFs.writeFileSync(path.join(agentsDir, 'helper.md'), '# Agent');

    const { config, convertedDir } =
      await convertGeminiExtensionPackage(testDir);

    try {
      expect(config.agents).toBe('agents');
    } finally {
      actualFs.rmSync(convertedDir, { recursive: true, force: true });
    }
  });

  it('should auto-detect non-empty skills directory', async () => {
    const skillsDir = path.join(testDir, 'skills');
    actualFs.mkdirSync(skillsDir);
    actualFs.writeFileSync(path.join(skillsDir, 'deploy.md'), '# Skill');

    const { config, convertedDir } =
      await convertGeminiExtensionPackage(testDir);

    try {
      expect(config.skills).toBe('skills');
    } finally {
      actualFs.rmSync(convertedDir, { recursive: true, force: true });
    }
  });

  it('should auto-detect non-empty commands directory', async () => {
    const cmdsDir = path.join(testDir, 'commands');
    actualFs.mkdirSync(cmdsDir);
    actualFs.writeFileSync(path.join(cmdsDir, 'run.md'), '# Command');

    const { config, convertedDir } =
      await convertGeminiExtensionPackage(testDir);

    try {
      expect(config.commands).toBe('commands');
    } finally {
      actualFs.rmSync(convertedDir, { recursive: true, force: true });
    }
  });

  it('should NOT auto-detect empty directories', async () => {
    actualFs.mkdirSync(path.join(testDir, 'agents'));
    actualFs.mkdirSync(path.join(testDir, 'skills'));
    actualFs.mkdirSync(path.join(testDir, 'commands'));

    const { config, convertedDir } =
      await convertGeminiExtensionPackage(testDir);

    try {
      expect(config.agents).toBeUndefined();
      expect(config.skills).toBeUndefined();
      expect(config.commands).toBeUndefined();
    } finally {
      actualFs.rmSync(convertedDir, { recursive: true, force: true });
    }
  });

  it('should NOT auto-detect when directories do not exist', async () => {
    const { config, convertedDir } =
      await convertGeminiExtensionPackage(testDir);

    try {
      expect(config.agents).toBeUndefined();
      expect(config.skills).toBeUndefined();
      expect(config.commands).toBeUndefined();
    } finally {
      actualFs.rmSync(convertedDir, { recursive: true, force: true });
    }
  });

  it('should NOT auto-detect regular files named agents/skills/commands', async () => {
    actualFs.writeFileSync(path.join(testDir, 'agents'), 'not a directory');
    actualFs.writeFileSync(path.join(testDir, 'skills'), 'not a directory');
    actualFs.writeFileSync(path.join(testDir, 'commands'), 'not a directory');

    const { config, convertedDir } =
      await convertGeminiExtensionPackage(testDir);

    try {
      expect(config.agents).toBeUndefined();
      expect(config.skills).toBeUndefined();
      expect(config.commands).toBeUndefined();
    } finally {
      actualFs.rmSync(convertedDir, { recursive: true, force: true });
    }
  });

  it('should not pass through custom directory paths from gemini config', async () => {
    actualFs.writeFileSync(
      path.join(testDir, 'gemini-extension.json'),
      JSON.stringify({
        name: 'test-ext',
        version: '1.0.0',
        agents: 'custom-agents',
        skills: 'custom-skills',
        commands: 'custom-cmds',
      }),
    );

    const { config, convertedDir } =
      await convertGeminiExtensionPackage(testDir);

    try {
      expect(config.agents).toBeUndefined();
      expect(config.skills).toBeUndefined();
      expect(config.commands).toBeUndefined();
    } finally {
      actualFs.rmSync(convertedDir, { recursive: true, force: true });
    }
  });
});
