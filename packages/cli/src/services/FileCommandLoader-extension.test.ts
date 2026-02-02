/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import mock from 'mock-fs';
import { FileCommandLoader } from './FileCommandLoader.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { Storage } from '@qwen-code/qwen-code-core';

describe('FileCommandLoader - Extension Commands Support', () => {
  const projectRoot = '/test/project';
  const userCommandsDir = Storage.getUserCommandsDir();
  const projectCommandsDir = path.join(projectRoot, '.qwen', 'commands');

  afterEach(() => {
    mock.restore();
  });

  it('should load commands from extension with config.commands path', async () => {
    const extensionDir = path.join(
      projectRoot,
      '.qwen',
      'extensions',
      'test-ext',
    );

    const extensionConfig = {
      name: 'test-ext',
      version: '1.0.0',
      commands: 'custom-cmds',
    };

    mock({
      [userCommandsDir]: {},
      [projectCommandsDir]: {},
      [extensionDir]: {
        'qwen-extension.json': JSON.stringify(extensionConfig),
        'custom-cmds': {
          'test.md':
            '---\ndescription: Test command from extension\n---\nDo something',
        },
      },
    });

    const mockConfig = {
      getFolderTrustFeature: vi.fn(() => false),
      getFolderTrust: vi.fn(() => true),
      getProjectRoot: vi.fn(() => projectRoot),
      storage: new Storage(projectRoot),
      getExtensions: vi.fn(() => [
        {
          id: 'test-ext',
          config: extensionConfig,
          name: 'test-ext',
          version: '1.0.0',
          isActive: true,
          path: extensionDir,
          contextFiles: [],
        },
      ]),
    } as unknown as Config;

    const loader = new FileCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('test');
    expect(commands[0].extensionName).toBe('test-ext');
    expect(commands[0].description).toBe(
      '[test-ext] Test command from extension',
    );
  });

  it('should load commands from extension with multiple commands paths', async () => {
    const extensionDir = path.join(
      projectRoot,
      '.qwen',
      'extensions',
      'multi-ext',
    );

    const extensionConfig = {
      name: 'multi-ext',
      version: '1.0.0',
      commands: ['commands1', 'commands2'],
    };

    mock({
      [userCommandsDir]: {},
      [projectCommandsDir]: {},
      [extensionDir]: {
        'qwen-extension.json': JSON.stringify(extensionConfig),
        commands1: {
          'cmd1.md': '---\n---\nCommand 1',
        },
        commands2: {
          'cmd2.md': '---\n---\nCommand 2',
        },
      },
    });

    const mockConfig = {
      getFolderTrustFeature: vi.fn(() => false),
      getFolderTrust: vi.fn(() => true),
      getProjectRoot: vi.fn(() => projectRoot),
      storage: new Storage(projectRoot),
      getExtensions: vi.fn(() => [
        {
          id: 'multi-ext',
          config: extensionConfig,
          contextFiles: [],
          name: 'multi-ext',
          version: '1.0.0',
          isActive: true,
          path: extensionDir,
        },
      ]),
    } as unknown as Config;

    const loader = new FileCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    expect(commands).toHaveLength(2);
    const commandNames = commands.map((c) => c.name).sort();
    expect(commandNames).toEqual(['cmd1', 'cmd2']);
    expect(commands.every((c) => c.extensionName === 'multi-ext')).toBe(true);
  });

  it('should fallback to default "commands" directory when config.commands not specified', async () => {
    const extensionDir = path.join(
      projectRoot,
      '.qwen',
      'extensions',
      'default-ext',
    );

    const extensionConfig = {
      name: 'default-ext',
      version: '1.0.0',
    };

    mock({
      [userCommandsDir]: {},
      [projectCommandsDir]: {},
      [extensionDir]: {
        'qwen-extension.json': JSON.stringify(extensionConfig),
        commands: {
          'default.md': '---\n---\nDefault command',
        },
      },
    });

    const mockConfig = {
      getFolderTrustFeature: vi.fn(() => false),
      getFolderTrust: vi.fn(() => true),
      getProjectRoot: vi.fn(() => projectRoot),
      storage: new Storage(projectRoot),
      getExtensions: vi.fn(() => [
        {
          id: 'default-ext',
          config: extensionConfig,
          contextFiles: [],
          name: 'default-ext',
          version: '1.0.0',
          isActive: true,
          path: extensionDir,
        },
      ]),
    } as unknown as Config;

    const loader = new FileCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('default');
    expect(commands[0].extensionName).toBe('default-ext');
  });

  it('should handle extension without commands directory gracefully', async () => {
    const extensionDir = path.join(
      projectRoot,
      '.qwen',
      'extensions',
      'no-cmds-ext',
    );

    const extensionConfig = {
      name: 'no-cmds-ext',
      version: '1.0.0',
    };

    mock({
      [userCommandsDir]: {},
      [projectCommandsDir]: {},
      [extensionDir]: {
        'qwen-extension.json': JSON.stringify(extensionConfig),
        // No commands directory
      },
    });

    const mockConfig = {
      getFolderTrustFeature: vi.fn(() => false),
      getFolderTrust: vi.fn(() => true),
      getProjectRoot: vi.fn(() => projectRoot),
      storage: new Storage(projectRoot),
      getExtensions: vi.fn(() => [
        {
          id: 'no-cmds-ext',
          config: extensionConfig,
          contextFiles: [],
          name: 'no-cmds-ext',
          version: '1.0.0',
          isActive: true,
          path: extensionDir,
        },
      ]),
    } as unknown as Config;

    const loader = new FileCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    // Should not throw and return empty array
    expect(commands).toHaveLength(0);
  });

  it('should set extensionName property for extension commands', async () => {
    const extensionDir = path.join(
      projectRoot,
      '.qwen',
      'extensions',
      'prefix-ext',
    );

    const extensionConfig = {
      name: 'prefix-ext',
      version: '1.0.0',
    };

    mock({
      [userCommandsDir]: {},
      [projectCommandsDir]: {},
      [extensionDir]: {
        'qwen-extension.json': JSON.stringify(extensionConfig),
        commands: {
          'mycommand.md': '---\n---\nMy command',
        },
      },
    });

    const mockConfig = {
      getFolderTrustFeature: vi.fn(() => false),
      getFolderTrust: vi.fn(() => true),
      getProjectRoot: vi.fn(() => projectRoot),
      storage: new Storage(projectRoot),
      getExtensions: vi.fn(() => [
        {
          id: 'prefix-ext',
          config: extensionConfig,
          contextFiles: [],
          name: 'prefix-ext',
          version: '1.0.0',
          isActive: true,
          path: extensionDir,
        },
      ]),
    } as unknown as Config;

    const loader = new FileCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('mycommand');
    expect(commands[0].extensionName).toBe('prefix-ext');
    expect(commands[0].description).toMatch(/^\[prefix-ext\]/);
  });

  it('should load commands from multiple extensions in alphabetical order', async () => {
    const ext1Dir = path.join(projectRoot, '.qwen', 'extensions', 'ext-b');
    const ext2Dir = path.join(projectRoot, '.qwen', 'extensions', 'ext-a');

    mock({
      [userCommandsDir]: {},
      [projectCommandsDir]: {},
      [ext1Dir]: {
        'qwen-extension.json': JSON.stringify({
          name: 'ext-b',
          version: '1.0.0',
        }),
        commands: {
          'cmd.md': '---\n---\nCommand B',
        },
      },
      [ext2Dir]: {
        'qwen-extension.json': JSON.stringify({
          name: 'ext-a',
          version: '1.0.0',
        }),
        commands: {
          'cmd.md': '---\n---\nCommand A',
        },
      },
    });

    const mockConfig = {
      getFolderTrustFeature: vi.fn(() => false),
      getFolderTrust: vi.fn(() => true),
      getProjectRoot: vi.fn(() => projectRoot),
      storage: new Storage(projectRoot),
      getExtensions: vi.fn(() => [
        {
          id: 'ext-b',
          config: { name: 'ext-b', version: '1.0.0' },
          contextFiles: [],
          name: 'ext-b',
          version: '1.0.0',
          isActive: true,
          path: ext1Dir,
        },
        {
          id: 'ext-a',
          config: { name: 'ext-a', version: '1.0.0' },
          contextFiles: [],
          name: 'ext-a',
          version: '1.0.0',
          isActive: true,
          path: ext2Dir,
        },
      ]),
    } as unknown as Config;

    const loader = new FileCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    expect(commands).toHaveLength(2);
    // Extensions are sorted alphabetically, so ext-a comes before ext-b
    expect(commands[0].extensionName).toBe('ext-a');
    expect(commands[1].extensionName).toBe('ext-b');
  });
});
