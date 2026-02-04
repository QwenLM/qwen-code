/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileCommandLoader } from './FileCommandLoader.js';

describe('FileCommandLoader - Markdown support', () => {
  let tempDir: string;

  beforeAll(async () => {
    // Create a temporary directory for test commands
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-md-test-'));
  });

  afterAll(async () => {
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should load markdown commands with frontmatter', async () => {
    // Create a test markdown command file
    const mdContent = `---
description: Test markdown command
---

This is a test prompt from markdown.`;

    const commandPath = path.join(tempDir, 'test-command.md');
    await fs.writeFile(commandPath, mdContent, 'utf-8');

    // Create loader with temp dir as command source
    const loader = new FileCommandLoader(null);

    // Mock the getCommandDirectories to return our temp dir
    const originalMethod = loader['getCommandDirectories'];
    loader['getCommandDirectories'] = () => [{ path: tempDir }];

    try {
      const commands = await loader.loadCommands(new AbortController().signal);

      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe('test-command');
      expect(commands[0].description).toBe('Test markdown command');
    } finally {
      // Restore original method
      loader['getCommandDirectories'] = originalMethod;
    }
  });

  it('should load markdown commands without frontmatter', async () => {
    // Create a test markdown command file without frontmatter
    const mdContent = 'This is a simple prompt without frontmatter.';

    const commandPath = path.join(tempDir, 'simple-command.md');
    await fs.writeFile(commandPath, mdContent, 'utf-8');

    const loader = new FileCommandLoader(null);
    const originalMethod = loader['getCommandDirectories'];
    loader['getCommandDirectories'] = () => [{ path: tempDir }];

    try {
      const commands = await loader.loadCommands(new AbortController().signal);

      const simpleCommand = commands.find(
        (cmd) => cmd.name === 'simple-command',
      );
      expect(simpleCommand).toBeDefined();
      expect(simpleCommand?.description).toContain('Custom command from');
    } finally {
      loader['getCommandDirectories'] = originalMethod;
    }
  });

  it('should load both toml and markdown commands', async () => {
    // Create both TOML and Markdown files
    const tomlContent = `prompt = "TOML prompt"
description = "TOML command"`;

    const mdContent = `---
description: Markdown command
---

Markdown prompt`;

    await fs.writeFile(
      path.join(tempDir, 'toml-cmd.toml'),
      tomlContent,
      'utf-8',
    );
    await fs.writeFile(path.join(tempDir, 'md-cmd.md'), mdContent, 'utf-8');

    const loader = new FileCommandLoader(null);
    const originalMethod = loader['getCommandDirectories'];
    loader['getCommandDirectories'] = () => [{ path: tempDir }];

    try {
      const commands = await loader.loadCommands(new AbortController().signal);

      const tomlCommand = commands.find((cmd) => cmd.name === 'toml-cmd');
      const mdCommand = commands.find((cmd) => cmd.name === 'md-cmd');

      expect(tomlCommand).toBeDefined();
      expect(tomlCommand?.description).toBe('TOML command');

      expect(mdCommand).toBeDefined();
      expect(mdCommand?.description).toBe('Markdown command');
    } finally {
      loader['getCommandDirectories'] = originalMethod;
    }
  });
});
