/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  readFileRange,
  tailFile,
  countLines,
  lastNLines,
  fileExistsSync,
} from './fsOperations.js';

function tmpPath(): string {
  return path.join(
    os.tmpdir(),
    `fsops-test-${crypto.randomBytes(8).toString('hex')}`,
  );
}

describe('fsOperations', () => {
  const tempFiles: string[] = [];

  function createTempFile(content: string): string {
    const p = tmpPath();
    fs.writeFileSync(p, content, 'utf-8');
    tempFiles.push(p);
    return p;
  }

  afterEach(() => {
    for (const f of tempFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    tempFiles.length = 0;
  });

  describe('readFileRange', () => {
    it('reads from offset 0', async () => {
      const filePath = createTempFile('hello world');
      const result = await readFileRange(filePath, 0, 1024);
      expect(result).not.toBeNull();
      expect(result!.content).toBe('hello world');
      expect(result!.bytesRead).toBe(11);
      expect(result!.bytesTotal).toBe(11);
    });

    it('reads from a non-zero offset', async () => {
      const filePath = createTempFile('hello world');
      const result = await readFileRange(filePath, 6, 1024);
      expect(result).not.toBeNull();
      expect(result!.content).toBe('world');
      expect(result!.bytesRead).toBe(5);
    });

    it('limits bytes read to maxBytes', async () => {
      const filePath = createTempFile('hello world');
      const result = await readFileRange(filePath, 0, 5);
      expect(result).not.toBeNull();
      expect(result!.content).toBe('hello');
      expect(result!.bytesRead).toBe(5);
    });

    it('returns null when offset equals file size', async () => {
      const filePath = createTempFile('hello');
      const result = await readFileRange(filePath, 5, 1024);
      expect(result).toBeNull();
    });

    it('returns null when offset exceeds file size', async () => {
      const filePath = createTempFile('hello');
      const result = await readFileRange(filePath, 100, 1024);
      expect(result).toBeNull();
    });
  });

  describe('tailFile', () => {
    it('reads the last N bytes of a file', async () => {
      const filePath = createTempFile('hello world');
      const result = await tailFile(filePath, 5);
      expect(result.content).toBe('world');
      expect(result.bytesRead).toBe(5);
      expect(result.bytesTotal).toBe(11);
    });

    it('reads entire file when maxBytes exceeds file size', async () => {
      const filePath = createTempFile('hello');
      const result = await tailFile(filePath, 1024);
      expect(result.content).toBe('hello');
      expect(result.bytesRead).toBe(5);
      expect(result.bytesTotal).toBe(5);
    });

    it('reads entire file when maxBytes equals file size', async () => {
      const filePath = createTempFile('abc');
      const result = await tailFile(filePath, 3);
      expect(result.content).toBe('abc');
      expect(result.bytesRead).toBe(3);
    });
  });

  describe('countLines', () => {
    it('returns 0 for an empty string', () => {
      expect(countLines('')).toBe(0);
    });

    it('returns 1 for a single line without newline', () => {
      expect(countLines('hello')).toBe(1);
    });

    it('returns 1 for a single line with trailing newline', () => {
      expect(countLines('hello\n')).toBe(1);
    });

    it('counts multiple lines correctly', () => {
      expect(countLines('a\nb\nc')).toBe(3);
    });

    it('counts multiple lines with trailing newline', () => {
      expect(countLines('a\nb\nc\n')).toBe(3);
    });
  });

  describe('lastNLines', () => {
    it('extracts the last N lines', () => {
      expect(lastNLines('a\nb\nc\nd', 2)).toBe('c\nd');
    });

    it('returns all lines when n exceeds available lines', () => {
      expect(lastNLines('a\nb', 10)).toBe('a\nb');
    });

    it('handles trailing newline by not including empty trailing element', () => {
      expect(lastNLines('a\nb\nc\n', 2)).toBe('b\nc');
    });

    it('returns empty string for n <= 0', () => {
      expect(lastNLines('a\nb', 0)).toBe('');
      expect(lastNLines('a\nb', -1)).toBe('');
    });

    it('returns empty string for empty content', () => {
      expect(lastNLines('', 5)).toBe('');
    });
  });

  describe('fileExistsSync', () => {
    it('returns true for an existing file', () => {
      const filePath = createTempFile('test');
      expect(fileExistsSync(filePath)).toBe(true);
    });

    it('returns false for a non-existing file', () => {
      const filePath = tmpPath();
      expect(fileExistsSync(filePath)).toBe(false);
    });
  });
});
