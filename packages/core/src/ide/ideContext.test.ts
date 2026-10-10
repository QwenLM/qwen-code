/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  IDE_MAX_OPEN_FILES,
  IDE_MAX_SELECTED_TEXT_LENGTH,
} from './constants.js';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { IdeContextStore } from './ideContext.js';
import {
  type IdeContext,
  FileSchema,
  IdeContextSchema,
  type File,
} from './types.js';

/** A context whose workspace has exactly `openFiles` open. */
const contextWith = (...openFiles: File[]): IdeContext => ({
  workspaceState: { openFiles },
});

/** An active file at `path` with '1234' selected. */
const selected = (path: string): File => ({
  path,
  isActive: true,
  selectedText: '1234',
  timestamp: 0,
});

describe('ideContext', () => {
  describe('createIdeContextStore', () => {
    let ideContextStore: IdeContextStore;

    beforeEach(() => {
      // Create a fresh, isolated instance for each test
      ideContextStore = new IdeContextStore();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const openFiles = () => ideContextStore.get()?.workspaceState?.openFiles;

    it('should return undefined initially for ide context', () => {
      expect(ideContextStore.get()).toBeUndefined();
    });

    it('should set and retrieve the ide context', () => {
      const testFile = contextWith(selected('/path/to/test/file.ts'));

      ideContextStore.set(testFile);

      const activeFile = ideContextStore.get();
      expect(activeFile).toEqual(testFile);
    });

    it('should update the ide context when called multiple times', () => {
      ideContextStore.set(contextWith(selected('/path/to/first.js')));

      const secondFile = contextWith({
        path: '/path/to/second.py',
        isActive: true,
        cursor: { line: 20, character: 30 },
        timestamp: 0,
      });
      ideContextStore.set(secondFile);

      const activeFile = ideContextStore.get();
      expect(activeFile).toEqual(secondFile);
    });

    it('should handle empty string for file path', () => {
      const testFile = contextWith(selected(''));
      ideContextStore.set(testFile);
      expect(ideContextStore.get()).toEqual(testFile);
    });

    it('should notify subscribers when ide context changes', () => {
      const subscriber1 = vi.fn();
      const subscriber2 = vi.fn();

      ideContextStore.subscribe(subscriber1);
      ideContextStore.subscribe(subscriber2);

      const testFile = contextWith({
        path: '/path/to/subscribed.ts',
        isActive: true,
        cursor: { line: 15, character: 25 },
        timestamp: 0,
      });
      ideContextStore.set(testFile);

      expect(subscriber1).toHaveBeenCalledTimes(1);
      expect(subscriber1).toHaveBeenCalledWith(testFile);
      expect(subscriber2).toHaveBeenCalledTimes(1);
      expect(subscriber2).toHaveBeenCalledWith(testFile);

      const newFile = contextWith(selected('/path/to/new.js'));
      ideContextStore.set(newFile);

      expect(subscriber1).toHaveBeenCalledTimes(2);
      expect(subscriber1).toHaveBeenCalledWith(newFile);
      expect(subscriber2).toHaveBeenCalledTimes(2);
      expect(subscriber2).toHaveBeenCalledWith(newFile);
    });

    it('should stop notifying a subscriber after unsubscribe', () => {
      const subscriber1 = vi.fn();
      const subscriber2 = vi.fn();

      const unsubscribe1 = ideContextStore.subscribe(subscriber1);
      ideContextStore.subscribe(subscriber2);

      ideContextStore.set(contextWith(selected('/path/to/file1.txt')));
      expect(subscriber1).toHaveBeenCalledTimes(1);
      expect(subscriber2).toHaveBeenCalledTimes(1);

      unsubscribe1();

      ideContextStore.set(contextWith(selected('/path/to/file2.txt')));
      expect(subscriber1).toHaveBeenCalledTimes(1); // Should not be called again
      expect(subscriber2).toHaveBeenCalledTimes(2);
    });

    it('should clear the ide context', () => {
      const testFile = contextWith(selected('/path/to/test/file.ts'));

      ideContextStore.set(testFile);

      expect(ideContextStore.get()).toEqual(testFile);

      ideContextStore.clear();

      expect(ideContextStore.get()).toBeUndefined();
    });

    it('should set the context and notify subscribers when no workspaceState is present', () => {
      const subscriber = vi.fn();
      ideContextStore.subscribe(subscriber);
      const context: IdeContext = {};
      ideContextStore.set(context);
      expect(ideContextStore.get()).toBe(context);
      expect(subscriber).toHaveBeenCalledWith(context);
    });

    it('should handle an empty openFiles array', () => {
      ideContextStore.set(contextWith());
      expect(openFiles()).toEqual([]);
    });

    it('should sort openFiles by timestamp in descending order', () => {
      ideContextStore.set(
        contextWith(
          { path: 'file1.ts', timestamp: 100, isActive: false },
          { path: 'file2.ts', timestamp: 300, isActive: true },
          { path: 'file3.ts', timestamp: 200, isActive: false },
        ),
      );
      expect(openFiles()?.[0]?.path).toBe('file2.ts');
      expect(openFiles()?.[1]?.path).toBe('file3.ts');
      expect(openFiles()?.[2]?.path).toBe('file1.ts');
    });

    it('should mark only the most recent file as active and clear other active files', () => {
      ideContextStore.set(
        contextWith(
          {
            path: 'file1.ts',
            timestamp: 100,
            isActive: true,
            selectedText: 'hello',
          },
          {
            path: 'file2.ts',
            timestamp: 300,
            isActive: true,
            cursor: { line: 1, character: 1 },
            selectedText: 'hello',
          },
          {
            path: 'file3.ts',
            timestamp: 200,
            isActive: false,
            selectedText: 'hello',
          },
        ),
      );
      const files = openFiles();
      expect(files?.[0]?.isActive).toBe(true);
      expect(files?.[0]?.cursor).toBeDefined();
      expect(files?.[0]?.selectedText).toBeDefined();
      for (const other of [files?.[1], files?.[2]]) {
        expect(other?.isActive).toBe(false);
        expect(other?.cursor).toBeUndefined();
        expect(other?.selectedText).toBeUndefined();
      }
    });

    it('should truncate selectedText if it exceeds the max length', () => {
      const longText = 'a'.repeat(IDE_MAX_SELECTED_TEXT_LENGTH + 10);
      ideContextStore.set(
        contextWith({
          path: 'file1.ts',
          timestamp: 100,
          isActive: true,
          selectedText: longText,
        }),
      );
      const selectedText = openFiles()?.[0]?.selectedText;
      expect(selectedText).toHaveLength(
        IDE_MAX_SELECTED_TEXT_LENGTH + '... [TRUNCATED]'.length,
      );
      expect(selectedText?.endsWith('... [TRUNCATED]')).toBe(true);
    });

    it('should not truncate selectedText if it is within the max length', () => {
      const shortText = 'a'.repeat(IDE_MAX_SELECTED_TEXT_LENGTH);
      ideContextStore.set(
        contextWith({
          path: 'file1.ts',
          timestamp: 100,
          isActive: true,
          selectedText: shortText,
        }),
      );
      expect(openFiles()?.[0]?.selectedText).toBe(shortText);
    });

    it('should truncate the openFiles list if it exceeds the max length', () => {
      const files: File[] = Array.from(
        { length: IDE_MAX_OPEN_FILES + 5 },
        (_, i) => ({
          path: `file${i}.ts`,
          timestamp: i,
          isActive: false,
        }),
      );
      ideContextStore.set(contextWith(...files));
      expect(openFiles()).toHaveLength(IDE_MAX_OPEN_FILES);
    });
  });

  describe('FileSchema', () => {
    it.each([
      [
        'should validate a file with only required fields',
        { path: '/path/to/file.ts', timestamp: 12345 },
        true,
      ],
      [
        'should validate a file with all fields',
        {
          path: '/path/to/file.ts',
          timestamp: 12345,
          isActive: true,
          selectedText: 'const x = 1;',
          cursor: { line: 10, character: 20 },
        },
        true,
      ],
      [
        'should fail validation if path is missing',
        { timestamp: 12345 },
        false,
      ],
      [
        'should fail validation if timestamp is missing',
        { path: '/path/to/file.ts' },
        false,
      ],
    ])('%s', (_title, file, valid) => {
      expect(FileSchema.safeParse(file).success).toBe(valid);
    });
  });

  describe('IdeContextSchema', () => {
    it.each([
      ['should validate an empty context', {}, true],
      [
        'should validate a context with an empty workspaceState',
        { workspaceState: {} },
        true,
      ],
      [
        'should validate a context with an empty openFiles array',
        { workspaceState: { openFiles: [] } },
        true,
      ],
      [
        'should validate a context with a valid file',
        {
          workspaceState: {
            openFiles: [{ path: '/path/to/file.ts', timestamp: 12345 }],
          },
        },
        true,
      ],
      [
        'should fail validation with an invalid file',
        { workspaceState: { openFiles: [{ timestamp: 12345 }] } }, // path is missing
        false,
      ],
    ])('%s', (_title, context, valid) => {
      expect(IdeContextSchema.safeParse(context).success).toBe(valid);
    });
  });
});
