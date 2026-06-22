/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAtCompletion } from './useAtCompletion.js';
import type {
  Config,
  FileSearch,
  FileSystemStructure,
} from '@qwen-code/qwen-code-core';
import {
  FileSearchFactory,
  createTmpDir,
  cleanupTmpDir,
} from '@qwen-code/qwen-code-core';
import { useState } from 'react';
import type { Suggestion } from '../components/SuggestionsDisplay.js';

// Test harness to capture the state from the hook's callbacks.
function useTestHarnessForAtCompletion(
  enabled: boolean,
  pattern: string,
  config: Config | undefined,
  cwd: string,
) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);

  useAtCompletion({
    enabled,
    pattern,
    config,
    cwd,
    setSuggestions,
    setIsLoadingSuggestions,
  });

  return { suggestions, isLoadingSuggestions };
}

describe('useAtCompletion', () => {
  let testRootDir: string;
  let mockConfig: Config;

  beforeEach(() => {
    mockConfig = {
      getFileFilteringOptions: vi.fn(() => ({
        respectGitIgnore: true,
        respectQwenIgnore: true,
      })),
      getEnableRecursiveFileSearch: () => true,
      getFileFilteringEnableFuzzySearch: () => true,
    } as unknown as Config;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (testRootDir) {
      await cleanupTmpDir(testRootDir);
    }
    vi.restoreAllMocks();
  });

  describe('File Search Logic', () => {
    it('should perform a recursive search for an empty pattern', async () => {
      const structure: FileSystemStructure = {
        'file.txt': '',
        src: {
          'index.js': '',
          components: ['Button.tsx', 'Button with spaces.tsx'],
        },
      };
      testRootDir = await createTmpDir(structure);

      const { result } = renderHook(() =>
        useTestHarnessForAtCompletion(true, '', mockConfig, testRootDir),
      );

      await waitFor(() => {
        expect(result.current.suggestions.length).toBeGreaterThan(0);
      });

      expect(result.current.suggestions.map((s) => s.value)).toEqual([
        'src/',
        'src/components/',
        'file.txt',
        'src/components/Button\\ with\\ spaces.tsx',
        'src/components/Button.tsx',
        'src/index.js',
      ]);
    });

    it('should correctly filter the recursive list based on a pattern', async () => {
      const structure: FileSystemStructure = {
        'file.txt': '',
        src: {
          'index.js': '',
          components: {
            'Button.tsx': '',
          },
        },
      };
      testRootDir = await createTmpDir(structure);

      const { result } = renderHook(() =>
        useTestHarnessForAtCompletion(true, 'src/', mockConfig, testRootDir),
      );

      await waitFor(() => {
        expect(result.current.suggestions.length).toBeGreaterThan(0);
      });

      const suggestionValues = result.current.suggestions.map((s) => s.value);
      expect(suggestionValues).toHaveLength(4);
      expect(suggestionValues).toEqual(
        expect.arrayContaining([
          'src/',
          'src/components/',
          'src/components/Button.tsx',
          'src/index.js',
        ]),
      );
    });

    it('should append a trailing slash to directory paths in suggestions', async () => {
      const structure: FileSystemStructure = {
        'file.txt': '',
        dir: {},
      };
      testRootDir = await createTmpDir(structure);

      const { result } = renderHook(() =>
        useTestHarnessForAtCompletion(true, '', mockConfig, testRootDir),
      );

      await waitFor(() => {
        expect(result.current.suggestions.length).toBeGreaterThan(0);
      });

      expect(result.current.suggestions.map((s) => s.value)).toEqual([
        'dir/',
        'file.txt',
      ]);
      // Verify isDirectory flag
      const dirSuggestion = result.current.suggestions.find(
        (s) => s.value === 'dir/',
      );
      const fileSuggestion = result.current.suggestions.find(
        (s) => s.value === 'file.txt',
      );
      expect(dirSuggestion?.isDirectory).toBe(true);
      expect(fileSuggestion?.isDirectory).toBe(false);
    });
  });

  describe('UI State and Loading Behavior', () => {
    it('should be in a loading state during initial file system crawl', async () => {
      testRootDir = await createTmpDir({});
      const { result } = renderHook(() =>
        useTestHarnessForAtCompletion(true, '', mockConfig, testRootDir),
      );

      // It's initially true because the effect runs synchronously.
      expect(result.current.isLoadingSuggestions).toBe(true);

      // Wait for the loading to complete.
      await waitFor(() => {
        expect(result.current.isLoadingSuggestions).toBe(false);
      });
    });

    it('should NOT show a loading indicator for subsequent searches that complete under 200ms', async () => {
      const structure: FileSystemStructure = { 'a.txt': '', 'b.txt': '' };
      testRootDir = await createTmpDir(structure);

      const { result, rerender } = renderHook(
        ({ pattern }) =>
          useTestHarnessForAtCompletion(true, pattern, mockConfig, testRootDir),
        { initialProps: { pattern: 'a' } },
      );

      await waitFor(() => {
        expect(result.current.suggestions.map((s) => s.value)).toEqual([
          'a.txt',
        ]);
      });
      expect(result.current.isLoadingSuggestions).toBe(false);

      rerender({ pattern: 'b' });

      // Wait for the final result
      await waitFor(() => {
        expect(result.current.suggestions.map((s) => s.value)).toEqual([
          'b.txt',
        ]);
      });

      expect(result.current.isLoadingSuggestions).toBe(false);
    });

    it('should show a loading indicator and clear old suggestions for subsequent searches that take longer than 200ms', async () => {
      const structure: FileSystemStructure = { 'a.txt': '', 'b.txt': '' };
      testRootDir = await createTmpDir(structure);

      const realFileSearch = FileSearchFactory.create({
        projectRoot: testRootDir,
        ignoreDirs: [],
        useGitignore: true,
        useQwenignore: true,
        cache: false,
        cacheTtl: 0,
        enableRecursiveFileSearch: true,
        enableFuzzySearch: true,
      });
      await realFileSearch.initialize();

      // Mock that returns results immediately but we'll control timing with fake timers
      const mockFileSearch: FileSearch = {
        initialize: vi.fn().mockResolvedValue(undefined),
        search: vi
          .fn()
          .mockImplementation(async (...args) =>
            realFileSearch.search(...args),
          ),
      };
      vi.spyOn(FileSearchFactory, 'create').mockReturnValue(mockFileSearch);

      const { result, rerender } = renderHook(
        ({ pattern }) =>
          useTestHarnessForAtCompletion(true, pattern, mockConfig, testRootDir),
        { initialProps: { pattern: 'a' } },
      );

      // Wait for the initial search to complete (using real timers)
      await waitFor(() => {
        expect(result.current.suggestions.map((s) => s.value)).toEqual([
          'a.txt',
        ]);
      });

      // Now switch to fake timers for precise control of the loading behavior
      vi.useFakeTimers();

      // Trigger the second search
      act(() => {
        rerender({ pattern: 'b' });
      });

      // Initially, loading should be false (before 200ms timer)
      expect(result.current.isLoadingSuggestions).toBe(false);

      // Advance time by exactly 200ms to trigger the loading state
      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Now loading should be true and suggestions should be cleared
      expect(result.current.isLoadingSuggestions).toBe(true);
      expect(result.current.suggestions).toEqual([]);

      // Switch back to real timers for the final waitFor
      vi.useRealTimers();

      // Wait for the search results to be processed
      await waitFor(() => {
        expect(result.current.suggestions.map((s) => s.value)).toEqual([
          'b.txt',
        ]);
      });

      expect(result.current.isLoadingSuggestions).toBe(false);
    });

    it('should abort the previous search when a new one starts', async () => {
      const structure: FileSystemStructure = { 'a.txt': '', 'b.txt': '' };
      testRootDir = await createTmpDir(structure);

      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
      const mockFileSearch: FileSearch = {
        initialize: vi.fn().mockResolvedValue(undefined),
        search: vi.fn().mockImplementation(async (pattern: string) => {
          const delay = pattern === 'a' ? 500 : 50;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return [pattern];
        }),
      };
      vi.spyOn(FileSearchFactory, 'create').mockReturnValue(mockFileSearch);

      const { result, rerender } = renderHook(
        ({ pattern }) =>
          useTestHarnessForAtCompletion(true, pattern, mockConfig, testRootDir),
        { initialProps: { pattern: 'a' } },
      );

      // Wait for the hook to be ready (initialization is complete)
      await waitFor(() => {
        expect(mockFileSearch.search).toHaveBeenCalledWith(
          'a',
          expect.any(Object),
        );
      });

      // Now that the first search is in-flight, trigger the second one.
      act(() => {
        rerender({ pattern: 'b' });
      });

      // The abort should have been called for the first search.
      expect(abortSpy).toHaveBeenCalledTimes(1);

      // Wait for the final result, which should be from the second, faster search.
      await waitFor(
        () => {
          expect(result.current.suggestions.map((s) => s.value)).toEqual(['b']);
        },
        { timeout: 1000 },
      );

      // The search spy should have been called for both patterns.
      expect(mockFileSearch.search).toHaveBeenCalledWith(
        'b',
        expect.any(Object),
      );
    });
  });

  describe('State Management', () => {
    it('should reset the state when disabled after being in a READY state', async () => {
      const structure: FileSystemStructure = { 'a.txt': '' };
      testRootDir = await createTmpDir(structure);

      const { result, rerender } = renderHook(
        ({ enabled }) =>
          useTestHarnessForAtCompletion(enabled, 'a', mockConfig, testRootDir),
        { initialProps: { enabled: true } },
      );

      // Wait for the hook to be ready and have suggestions
      await waitFor(() => {
        expect(result.current.suggestions.map((s) => s.value)).toEqual([
          'a.txt',
        ]);
      });

      // Now, disable the hook
      rerender({ enabled: false });

      // The suggestions should be cleared immediately because of the RESET action
      expect(result.current.suggestions).toEqual([]);
    });

    it('should reset the state when disabled after being in an ERROR state', async () => {
      testRootDir = await createTmpDir({});

      // Force an error during initialization
      const mockFileSearch: FileSearch = {
        initialize: vi
          .fn()
          .mockRejectedValue(new Error('Initialization failed')),
        search: vi.fn(),
      };
      vi.spyOn(FileSearchFactory, 'create').mockReturnValue(mockFileSearch);

      const { result, rerender } = renderHook(
        ({ enabled }) =>
          useTestHarnessForAtCompletion(enabled, '', mockConfig, testRootDir),
        { initialProps: { enabled: true } },
      );

      // Wait for the hook to enter the error state
      await waitFor(() => {
        expect(result.current.isLoadingSuggestions).toBe(false);
      });
      expect(result.current.suggestions).toEqual([]); // No suggestions on error

      // Now, disable the hook
      rerender({ enabled: false });

      // The state should still be reset (though visually it's the same)
      // We can't directly inspect the internal state, but we can ensure it doesn't crash
      // and the suggestions remain empty.
      expect(result.current.suggestions).toEqual([]);
    });
  });

  describe('Filtering and Configuration', () => {
    it('should respect .gitignore files', async () => {
      const gitignoreContent = ['dist/', '*.log'].join('\n');
      const structure: FileSystemStructure = {
        '.git': {},
        '.gitignore': gitignoreContent,
        dist: {},
        'test.log': '',
        src: {},
      };
      testRootDir = await createTmpDir(structure);

      const { result } = renderHook(() =>
        useTestHarnessForAtCompletion(true, '', mockConfig, testRootDir),
      );

      await waitFor(() => {
        expect(result.current.suggestions.length).toBeGreaterThan(0);
      });

      expect(result.current.suggestions.map((s) => s.value)).toEqual([
        'src/',
        '.gitignore',
      ]);
    });

    it('should work correctly when config is undefined', async () => {
      const structure: FileSystemStructure = {
        node_modules: {},
        src: {},
      };
      testRootDir = await createTmpDir(structure);

      const { result } = renderHook(() =>
        useTestHarnessForAtCompletion(true, '', undefined, testRootDir),
      );

      await waitFor(() => {
        expect(result.current.suggestions.length).toBeGreaterThan(0);
      });

      expect(result.current.suggestions.map((s) => s.value)).toEqual([
        'node_modules/',
        'src/',
      ]);
    });

    it('should reset and re-initialize when the cwd changes', async () => {
      const structure1: FileSystemStructure = { 'file1.txt': '' };
      const rootDir1 = await createTmpDir(structure1);
      const structure2: FileSystemStructure = { 'file2.txt': '' };
      const rootDir2 = await createTmpDir(structure2);

      const { result, rerender } = renderHook(
        ({ cwd, pattern }) =>
          useTestHarnessForAtCompletion(true, pattern, mockConfig, cwd),
        {
          initialProps: {
            cwd: rootDir1,
            pattern: 'file',
          },
        },
      );

      // Wait for initial suggestions from the first directory
      await waitFor(() => {
        expect(result.current.suggestions.map((s) => s.value)).toEqual([
          'file1.txt',
        ]);
      });

      // Change the CWD
      act(() => {
        rerender({ cwd: rootDir2, pattern: 'file' });
      });

      // After CWD changes, suggestions should be cleared and it should load again.
      await waitFor(() => {
        expect(result.current.isLoadingSuggestions).toBe(true);
        expect(result.current.suggestions).toEqual([]);
      });

      // Wait for the new suggestions from the second directory
      await waitFor(() => {
        expect(result.current.suggestions.map((s) => s.value)).toEqual([
          'file2.txt',
        ]);
      });
      expect(result.current.isLoadingSuggestions).toBe(false);

      await cleanupTmpDir(rootDir1);
      await cleanupTmpDir(rootDir2);
    });

    it('should perform a non-recursive search when enableRecursiveFileSearch is false', async () => {
      const structure: FileSystemStructure = {
        'file.txt': '',
        src: {
          'index.js': '',
        },
      };
      testRootDir = await createTmpDir(structure);

      const nonRecursiveConfig = {
        getEnableRecursiveFileSearch: () => false,
        getFileFilteringOptions: vi.fn(() => ({
          respectGitIgnore: true,
          respectQwenIgnore: true,
        })),
        getFileFilteringEnableFuzzySearch: () => true,
      } as unknown as Config;

      const { result } = renderHook(() =>
        useTestHarnessForAtCompletion(
          true,
          '',
          nonRecursiveConfig,
          testRootDir,
        ),
      );

      await waitFor(() => {
        expect(result.current.suggestions.length).toBeGreaterThan(0);
      });

      // Should only contain top-level items
      expect(result.current.suggestions.map((s) => s.value)).toEqual([
        'src/',
        'file.txt',
      ]);
    });
  });

  describe('MCP resource completion', () => {
    it('suggests resource URIs for @server: when the server is configured', async () => {
      testRootDir = await createTmpDir({ 'file.txt': '' });
      const resourceConfig = {
        ...mockConfig,
        getMcpServers: () => ({ myserver: {} }),
        getResourceRegistry: () => ({
          getResourcesByServer: (name: string) =>
            name === 'myserver'
              ? [
                  { uri: 'res://alpha', name: 'a', serverName: 'myserver' },
                  { uri: 'res://beta', name: 'b', serverName: 'myserver' },
                ]
              : [],
        }),
      } as unknown as Config;

      const { result } = renderHook(() =>
        useTestHarnessForAtCompletion(
          true,
          'myserver:res://a',
          resourceConfig,
          testRootDir,
        ),
      );

      await waitFor(() => {
        expect(result.current.suggestions.length).toBeGreaterThan(0);
      });
      // Only 'res://alpha' prefix-matches 'res://a'.
      expect(result.current.suggestions.map((s) => s.value)).toEqual([
        'myserver:res://alpha',
      ]);
    });

    it('falls through to filesystem search when the prefix is not a configured server', async () => {
      testRootDir = await createTmpDir({ 'notes.txt': '' });
      const resourceConfig = {
        ...mockConfig,
        getMcpServers: () => ({ myserver: {} }),
        getResourceRegistry: () => ({ getResourcesByServer: () => [] }),
      } as unknown as Config;

      const { result } = renderHook(() =>
        useTestHarnessForAtCompletion(
          true,
          'notes',
          resourceConfig,
          testRootDir,
        ),
      );

      await waitFor(() => {
        expect(result.current.suggestions.length).toBeGreaterThan(0);
      });
      // 'notes' has no ':' → not a resource pattern → filesystem search.
      expect(result.current.suggestions.map((s) => s.value)).toContain(
        'notes.txt',
      );
    });

    it('ranks prefix matches above mid-string matches', async () => {
      testRootDir = await createTmpDir({ 'file.txt': '' });
      const resourceConfig = {
        ...mockConfig,
        getMcpServers: () => ({ myserver: {} }),
        getResourceRegistry: () => ({
          getResourcesByServer: () => [
            // contains 'doc' mid-string
            { uri: 'api/doc', name: 'a', serverName: 'myserver' },
            // starts with 'doc'
            { uri: 'doc/readme', name: 'b', serverName: 'myserver' },
          ],
        }),
      } as unknown as Config;

      const { result } = renderHook(() =>
        useTestHarnessForAtCompletion(
          true,
          'myserver:doc',
          resourceConfig,
          testRootDir,
        ),
      );

      await waitFor(() => {
        expect(result.current.suggestions.length).toBeGreaterThan(0);
      });
      // Prefix match first, then the mid-string match.
      expect(result.current.suggestions.map((s) => s.value)).toEqual([
        'myserver:doc/readme',
        'myserver:api/doc',
      ]);
    });

    it('does not surface resource URIs in an untrusted folder', async () => {
      testRootDir = await createTmpDir({ 'file.txt': '' });
      const resourceConfig = {
        ...mockConfig,
        isTrustedFolder: () => false,
        getMcpServers: () => ({ myserver: {} }),
        getResourceRegistry: () => ({
          getResourcesByServer: () => [
            { uri: 'res://secret', name: 's', serverName: 'myserver' },
          ],
        }),
      } as unknown as Config;

      const { result } = renderHook(() =>
        useTestHarnessForAtCompletion(
          true,
          'myserver:res',
          resourceConfig,
          testRootDir,
        ),
      );

      // getMcpResourceSuggestions returns null in an untrusted folder, so the
      // hook falls through to filesystem search (which finds nothing for
      // 'myserver:res'); the resource URI must never appear.
      await new Promise((r) => setTimeout(r, 300));
      expect(result.current.suggestions.map((s) => s.value)).not.toContain(
        'myserver:res://secret',
      );
    });

    it('resolves a server name containing a colon (longest-prefix)', async () => {
      testRootDir = await createTmpDir({ 'file.txt': '' });
      // Both "my" and "my:server" configured → longest-prefix picks "my:server".
      const resourceConfig = {
        ...mockConfig,
        getMcpServers: () => ({ my: {}, 'my:server': {} }),
        getResourceRegistry: () => ({
          getResourcesByServer: (name: string) =>
            name === 'my:server'
              ? [{ uri: 'res://doc', name: 'd', serverName: 'my:server' }]
              : [],
        }),
      } as unknown as Config;

      const { result } = renderHook(() =>
        useTestHarnessForAtCompletion(
          true,
          'my:server:res',
          resourceConfig,
          testRootDir,
        ),
      );

      await waitFor(() => {
        expect(result.current.suggestions.length).toBeGreaterThan(0);
      });
      expect(result.current.suggestions.map((s) => s.value)).toEqual([
        'my:server:res://doc',
      ]);
    });
  });
});
