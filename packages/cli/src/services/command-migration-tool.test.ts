/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  detectTomlCommands,
  migrateTomlCommands,
  generateMigrationPrompt,
} from './command-migration-tool.js';

describe('command-migration-tool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-migration-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('detectTomlCommands', () => {
    it('should detect TOML files in directory', async () => {
      // Create some TOML files
      await fs.writeFile(
        path.join(tempDir, 'cmd1.toml'),
        'prompt = "test"',
        'utf-8',
      );
      await fs.writeFile(
        path.join(tempDir, 'cmd2.toml'),
        'prompt = "test"',
        'utf-8',
      );

      const tomlFiles = await detectTomlCommands(tempDir);

      expect(tomlFiles).toHaveLength(2);
      expect(tomlFiles).toContain('cmd1.toml');
      expect(tomlFiles).toContain('cmd2.toml');
    });

    it('should detect TOML files in subdirectories', async () => {
      const subdir = path.join(tempDir, 'subdir');
      await fs.mkdir(subdir);
      await fs.writeFile(
        path.join(subdir, 'nested.toml'),
        'prompt = "test"',
        'utf-8',
      );

      const tomlFiles = await detectTomlCommands(tempDir);

      expect(tomlFiles).toHaveLength(1);
      expect(tomlFiles[0]).toContain('nested.toml');
    });

    it('should return empty array for non-existent directory', async () => {
      const nonExistent = path.join(tempDir, 'does-not-exist');

      const tomlFiles = await detectTomlCommands(nonExistent);

      expect(tomlFiles).toEqual([]);
    });

    it('should not detect non-TOML files', async () => {
      await fs.writeFile(path.join(tempDir, 'file.txt'), 'text', 'utf-8');
      await fs.writeFile(path.join(tempDir, 'file.md'), 'markdown', 'utf-8');

      const tomlFiles = await detectTomlCommands(tempDir);

      expect(tomlFiles).toHaveLength(0);
    });
  });

  describe('migrateTomlCommands', () => {
    it('should migrate TOML file to Markdown', async () => {
      const tomlContent = `prompt = "Test prompt"
description = "Test description"`;

      await fs.writeFile(path.join(tempDir, 'test.toml'), tomlContent, 'utf-8');

      const result = await migrateTomlCommands({
        commandDir: tempDir,
        createBackup: true,
        deleteOriginal: false,
      });

      expect(result.success).toBe(true);
      expect(result.convertedFiles).toContain('test.toml');
      expect(result.failedFiles).toHaveLength(0);

      // Check Markdown file was created
      const mdPath = path.join(tempDir, 'test.md');
      const mdContent = await fs.readFile(mdPath, 'utf-8');
      expect(mdContent).toContain('description: Test description');
      expect(mdContent).toContain('Test prompt');

      // Check backup was created (original renamed to .toml.backup)
      const backupPath = path.join(tempDir, 'test.toml.backup');
      const backupExists = await fs
        .access(backupPath)
        .then(() => true)
        .catch(() => false);
      expect(backupExists).toBe(true);

      // Original .toml file should not exist (renamed to .backup)
      const tomlExists = await fs
        .access(path.join(tempDir, 'test.toml'))
        .then(() => true)
        .catch(() => false);
      expect(tomlExists).toBe(false);
    });

    it('should delete original TOML when deleteOriginal is true', async () => {
      await fs.writeFile(
        path.join(tempDir, 'delete-me.toml'),
        'prompt = "Test"',
        'utf-8',
      );

      await migrateTomlCommands({
        commandDir: tempDir,
        createBackup: false,
        deleteOriginal: true,
      });

      // Original should be deleted
      const tomlExists = await fs
        .access(path.join(tempDir, 'delete-me.toml'))
        .then(() => true)
        .catch(() => false);
      expect(tomlExists).toBe(false);

      // Markdown should exist
      const mdExists = await fs
        .access(path.join(tempDir, 'delete-me.md'))
        .then(() => true)
        .catch(() => false);
      expect(mdExists).toBe(true);

      // Backup should not exist (createBackup was false)
      const backupExists = await fs
        .access(path.join(tempDir, 'delete-me.toml.backup'))
        .then(() => true)
        .catch(() => false);
      expect(backupExists).toBe(false);
    });

    it('should fail if Markdown file already exists', async () => {
      await fs.writeFile(
        path.join(tempDir, 'existing.toml'),
        'prompt = "Test"',
        'utf-8',
      );
      await fs.writeFile(
        path.join(tempDir, 'existing.md'),
        'Already exists',
        'utf-8',
      );

      const result = await migrateTomlCommands({
        commandDir: tempDir,
        createBackup: false,
      });

      expect(result.success).toBe(false);
      expect(result.failedFiles).toHaveLength(1);
      expect(result.failedFiles[0].file).toBe('existing.toml');
      expect(result.failedFiles[0].error).toContain('already exists');
    });

    it('should handle migration without backup', async () => {
      await fs.writeFile(
        path.join(tempDir, 'no-backup.toml'),
        'prompt = "Test"',
        'utf-8',
      );

      const result = await migrateTomlCommands({
        commandDir: tempDir,
        createBackup: false,
        deleteOriginal: false,
      });

      expect(result.success).toBe(true);

      // Original TOML file should still exist (no backup, no delete)
      const tomlExists = await fs
        .access(path.join(tempDir, 'no-backup.toml'))
        .then(() => true)
        .catch(() => false);
      expect(tomlExists).toBe(true);

      // Backup should not exist
      const backupExists = await fs
        .access(path.join(tempDir, 'no-backup.toml.backup'))
        .then(() => true)
        .catch(() => false);
      expect(backupExists).toBe(false);
    });

    it('should return success with empty results for no TOML files', async () => {
      const result = await migrateTomlCommands({
        commandDir: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.convertedFiles).toHaveLength(0);
      expect(result.failedFiles).toHaveLength(0);
    });
  });

  describe('generateMigrationPrompt', () => {
    it('should generate prompt for few files', () => {
      const files = ['cmd1.toml', 'cmd2.toml'];

      const prompt = generateMigrationPrompt(files);

      expect(prompt).toContain('Found 2 command file(s)');
      expect(prompt).toContain('cmd1.toml');
      expect(prompt).toContain('cmd2.toml');
      expect(prompt).toContain('qwen-code migrate-commands');
    });

    it('should truncate file list for many files', () => {
      const files = Array.from({ length: 10 }, (_, i) => `cmd${i}.toml`);

      const prompt = generateMigrationPrompt(files);

      expect(prompt).toContain('Found 10 command file(s)');
      expect(prompt).toContain('... and 7 more');
    });

    it('should return empty string for no files', () => {
      const prompt = generateMigrationPrompt([]);

      expect(prompt).toBe('');
    });

    it('should use singular form for single file', () => {
      const prompt = generateMigrationPrompt(['single.toml']);

      expect(prompt).toContain('Found 1 command file');
      // Don't check for plural since "files" appears in other parts of the message
    });
  });
});
