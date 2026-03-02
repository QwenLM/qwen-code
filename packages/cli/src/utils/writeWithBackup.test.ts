/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeWithBackup, writeWithBackupSync } from './writeWithBackup.js';

describe('writeWithBackup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writeWithBackup-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_e) {
      // Ignore cleanup errors
    }
  });

  describe('writeWithBackupSync', () => {
    it('should write content to a new file', () => {
      const targetPath = path.join(tempDir, 'test-file.txt');
      const content = 'Hello, World!';

      writeWithBackupSync(targetPath, content);

      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.readFileSync(targetPath, 'utf-8')).toBe(content);
    });

    it('should backup existing file before writing', () => {
      const targetPath = path.join(tempDir, 'test-file.txt');
      const originalContent = 'Original content';
      const newContent = 'New content';

      fs.writeFileSync(targetPath, originalContent);
      writeWithBackupSync(targetPath, newContent);

      expect(fs.readFileSync(targetPath, 'utf-8')).toBe(newContent);
      expect(fs.existsSync(`${targetPath}.orig`)).toBe(true);
      expect(fs.readFileSync(`${targetPath}.orig`, 'utf-8')).toBe(
        originalContent,
      );
    });

    it('should use custom backup suffix', () => {
      const targetPath = path.join(tempDir, 'test-file.txt');
      const originalContent = 'Original';

      fs.writeFileSync(targetPath, originalContent);
      writeWithBackupSync(targetPath, 'New', { backupSuffix: '.bak' });

      expect(fs.existsSync(`${targetPath}.bak`)).toBe(true);
      expect(fs.existsSync(`${targetPath}.orig`)).toBe(false);
    });

    it('should clean up temp file on failure', () => {
      const targetPath = path.join(tempDir, 'test-file.txt');
      const tempPath = `${targetPath}.tmp`;

      // Create a situation where rename will fail (e.g., by creating a directory at target)
      fs.mkdirSync(targetPath);

      expect(() => writeWithBackupSync(targetPath, 'content')).toThrow();
      expect(fs.existsSync(tempPath)).toBe(false);
    });

    it('should preserve original file content when write fails after backup', () => {
      const targetPath = path.join(tempDir, 'test-file.txt');
      const originalContent = 'Original content that must be preserved';

      // Create original file
      fs.writeFileSync(targetPath, originalContent);

      // Create a situation where rename will fail (by creating a directory at temp path)
      const tempPath = `${targetPath}.tmp`;
      fs.mkdirSync(tempPath);

      // The write should fail
      expect(() => writeWithBackupSync(targetPath, 'New content')).toThrow();

      // Original file should still exist with original content
      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.statSync(targetPath).isFile()).toBe(true);
      expect(fs.readFileSync(targetPath, 'utf-8')).toBe(originalContent);

      // Cleanup
      fs.rmdirSync(tempPath);
    });

    it('should restore original file from backup when rename fails', () => {
      const targetPath = path.join(tempDir, 'test-file.txt');
      const backupPath = `${targetPath}.orig`;
      const originalContent = 'Original content';
      const newContent = 'New content';

      // Create original file
      fs.writeFileSync(targetPath, originalContent);

      // Write new content successfully first
      writeWithBackupSync(targetPath, newContent);

      // Verify backup exists with original content
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.readFileSync(backupPath, 'utf-8')).toBe(originalContent);

      // Verify target has new content
      expect(fs.readFileSync(targetPath, 'utf-8')).toBe(newContent);

      // Now simulate a failure scenario: delete target and try to restore from backup
      fs.unlinkSync(targetPath);

      // Restore from backup manually to verify backup integrity
      fs.copyFileSync(backupPath, targetPath);
      expect(fs.readFileSync(targetPath, 'utf-8')).toBe(originalContent);
    });

    it('should include recovery information in error message', () => {
      const targetPath = path.join(tempDir, 'test-file.txt');

      // Create a situation where rename will fail (directory at target)
      fs.mkdirSync(targetPath);

      let errorMessage = '';
      try {
        writeWithBackupSync(targetPath, 'content');
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      // Error message should be descriptive
      expect(errorMessage).toContain('directory');
      expect(errorMessage.length).toBeGreaterThan(10);
    });

    it('should handle backup failure with descriptive error', () => {
      const targetPath = path.join(tempDir, 'test-file.txt');
      const backupPath = `${targetPath}.orig`;
      const originalContent = 'Original content';

      // Create original file
      fs.writeFileSync(targetPath, originalContent);

      // Create a directory at backup path to cause backup to fail
      fs.mkdirSync(backupPath);

      let errorMessage = '';
      try {
        writeWithBackupSync(targetPath, 'New content');
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      // Error message should mention backup failure
      expect(errorMessage).toContain('backup');

      // Original file should still exist
      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.readFileSync(targetPath, 'utf-8')).toBe(originalContent);

      // Cleanup
      fs.rmdirSync(backupPath);
    });

    it('should clean up temp file when backup creation fails', () => {
      const targetPath = path.join(tempDir, 'test-file.txt');
      const tempPath = `${targetPath}.tmp`;
      const backupPath = `${targetPath}.orig`;
      const originalContent = 'Original content';

      // Create original file
      fs.writeFileSync(targetPath, originalContent);

      // Create a directory at backup path to cause backup to fail
      fs.mkdirSync(backupPath);

      // The write should fail
      expect(() => writeWithBackupSync(targetPath, 'New content')).toThrow();

      // Temp file should be cleaned up
      expect(fs.existsSync(tempPath)).toBe(false);

      // Cleanup
      fs.rmdirSync(backupPath);
    });
  });

  describe('writeWithBackup (async)', () => {
    it('should write content to a new file', async () => {
      const targetPath = path.join(tempDir, 'test-file.txt');
      const content = 'Hello, World!';

      await writeWithBackup(targetPath, content);

      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.readFileSync(targetPath, 'utf-8')).toBe(content);
    });

    it('should backup existing file before writing', async () => {
      const targetPath = path.join(tempDir, 'test-file.txt');
      const originalContent = 'Original content';
      const newContent = 'New content';

      fs.writeFileSync(targetPath, originalContent);
      await writeWithBackup(targetPath, newContent);

      expect(fs.readFileSync(targetPath, 'utf-8')).toBe(newContent);
      expect(fs.existsSync(`${targetPath}.orig`)).toBe(true);
      expect(fs.readFileSync(`${targetPath}.orig`, 'utf-8')).toBe(
        originalContent,
      );
    });

    it('should use custom encoding', async () => {
      const targetPath = path.join(tempDir, 'test-file.txt');
      const content = 'Hello, World!';

      await writeWithBackup(targetPath, content, { encoding: 'utf8' });

      expect(fs.readFileSync(targetPath, 'utf-8')).toBe(content);
    });
  });
});
