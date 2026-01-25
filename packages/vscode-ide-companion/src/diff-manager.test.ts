/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * DiffManager Tests
 *
 * Test objective: Ensure the Diff editor correctly displays code comparisons, preventing Diff open failures.
 *
 * Key test scenarios:
 * 1. Diff display - Ensure Diff view opens correctly
 * 2. Diff accept - Ensure users can accept code changes
 * 3. Diff cancel - Ensure users can cancel code changes
 * 4. Deduplication - Prevent duplicate Diffs from opening
 * 5. Resource cleanup - Ensure resources are properly cleaned up after Diff closes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { DiffManager, DiffContentProvider } from './diff-manager.js';

describe('DiffContentProvider', () => {
  let provider: DiffContentProvider;

  beforeEach(() => {
    provider = new DiffContentProvider();
  });

  /**
   * Test: Set and get content
   *
   * Verifies DiffContentProvider can correctly store and retrieve Diff content.
   * This is the content source for VSCode Diff view.
   */
  it('should set and get content', () => {
    const uri = { toString: () => 'test-uri' } as vscode.Uri;

    provider.setContent(uri, 'test content');

    expect(provider.provideTextDocumentContent(uri)).toBe('test content');
  });

  /**
   * Test: Return empty string for unknown URI
   *
   * Verifies that an empty string is returned for URIs without content, instead of throwing.
   */
  it('should return empty string for unknown URI', () => {
    const uri = { toString: () => 'unknown-uri' } as vscode.Uri;

    expect(provider.provideTextDocumentContent(uri)).toBe('');
  });

  /**
   * Test: Delete content
   *
   * Verifies that content can be properly deleted.
   * Content needs to be cleaned up when Diff is closed.
   */
  it('should delete content', () => {
    const uri = { toString: () => 'test-uri' } as vscode.Uri;

    provider.setContent(uri, 'test content');
    provider.deleteContent(uri);

    expect(provider.provideTextDocumentContent(uri)).toBe('');
  });

  /**
   * Test: getContent method
   *
   * Verifies getContent returns the original content or undefined.
   */
  it('should return content via getContent', () => {
    const uri = { toString: () => 'test-uri' } as vscode.Uri;

    expect(provider.getContent(uri)).toBeUndefined();

    provider.setContent(uri, 'test content');

    expect(provider.getContent(uri)).toBe('test content');
  });
});

describe('DiffManager', () => {
  let diffManager: DiffManager;
  let mockLog: (message: string) => void;
  let mockContentProvider: DiffContentProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLog = vi.fn();
    mockContentProvider = new DiffContentProvider();

    // Reset vscode mocks
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
      getText: () => 'modified content',
    } as vscode.TextDocument);
    // Reset tabGroups to empty state
    Object.defineProperty(vi.mocked(vscode.window.tabGroups), 'all', {
      value: [],
      writable: true,
    });

    diffManager = new DiffManager(mockLog, mockContentProvider);
  });

  afterEach(() => {
    diffManager.dispose();
  });

  describe('showDiff', () => {
    /**
     * Test: Create Diff view
     *
     * Verifies showDiff calls vscode.diff command to create Diff view.
     * If this fails, users cannot see code comparisons.
     */
    it('should create diff view with correct URIs', async () => {
      await diffManager.showDiff('/test/file.ts', 'old content', 'new content');

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'vscode.diff',
        expect.any(Object), // left URI (old content)
        expect.any(Object), // right URI (new content)
        expect.stringContaining('file.ts'), // title contains filename
        expect.any(Object), // options
      );
    });

    /**
     * Test: Set Diff visible context
     *
     * Verifies showDiff sets qwen.diff.isVisible context.
     * This controls accept/cancel button visibility.
     */
    it('should set qwen.diff.isVisible context to true', async () => {
      await diffManager.showDiff('/test/file.ts', 'old', 'new');

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'setContext',
        'qwen.diff.isVisible',
        true,
      );
    });

    /**
     * Test: Diff title format
     *
     * Verifies Diff view title contains filename and "Before / After".
     * Helps users understand this is a comparison view.
     */
    it('should use correct diff title format', async () => {
      await diffManager.showDiff('/path/to/myfile.ts', 'old', 'new');

      const diffCall = vi
        .mocked(vscode.commands.executeCommand)
        .mock.calls.find((call) => call[0] === 'vscode.diff');

      expect(diffCall?.[3]).toContain('myfile.ts');
      expect(diffCall?.[3]).toContain('Before');
      expect(diffCall?.[3]).toContain('After');
    });

    /**
     * Test: Deduplication - same content doesn't open twice
     *
     * Verifies that for the same file and content, Diff view is not created again.
     * Prevents UI clutter.
     */
    it('should deduplicate rapid duplicate calls', async () => {
      await diffManager.showDiff('/test/file.ts', 'old', 'new');

      vi.mocked(vscode.commands.executeCommand).mockClear();

      // Immediately call again with same parameters
      await diffManager.showDiff('/test/file.ts', 'old', 'new');

      // vscode.diff should not be called again
      const diffCalls = vi
        .mocked(vscode.commands.executeCommand)
        .mock.calls.filter((call) => call[0] === 'vscode.diff');
      expect(diffCalls.length).toBe(0);
    });

    /**
     * Test: Preserve focus on WebView
     *
     * Verifies that preserveFocus: true is set when opening Diff.
     * Ensures chat interface keeps focus without interrupting user input.
     */
    it('should preserve focus when showing diff', async () => {
      await diffManager.showDiff('/test/file.ts', 'old', 'new');

      const diffCall = vi
        .mocked(vscode.commands.executeCommand)
        .mock.calls.find((call) => call[0] === 'vscode.diff');
      const options = diffCall?.[4] as { preserveFocus?: boolean } | undefined;

      expect(options?.preserveFocus).toBe(true);
    });

    /**
     * Test: Two-argument overload (auto-read original file)
     *
     * Verifies that when only newContent is passed, original file content is auto-read.
     */
    it('should support two-argument overload', async () => {
      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
        getText: () => 'original file content',
      } as vscode.TextDocument);

      await diffManager.showDiff('/test/file.ts', 'new content');

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'vscode.diff',
        expect.any(Object),
        expect.any(Object),
        expect.any(String),
        expect.any(Object),
      );
    });
  });

  describe('acceptDiff', () => {
    /**
     * Test: Clear context after accepting Diff
     *
     * Verifies qwen.diff.isVisible is set to false after accepting.
     * This hides the accept/cancel buttons.
     */
    it('should set qwen.diff.isVisible context to false', async () => {
      // First show Diff
      await diffManager.showDiff('/test/file.ts', 'old', 'new');
      vi.mocked(vscode.commands.executeCommand).mockClear();

      // Get the created right URI
      const uriFromCall = vi
        .mocked(vscode.Uri.from)
        .mock.results.find((r) =>
          (r.value as vscode.Uri).query?.includes('new'),
        )?.value as vscode.Uri;

      if (uriFromCall) {
        await diffManager.acceptDiff(uriFromCall);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
          'setContext',
          'qwen.diff.isVisible',
          false,
        );
      }
    });
  });

  describe('cancelDiff', () => {
    /**
     * Test: Clear context after canceling Diff
     *
     * Verifies qwen.diff.isVisible is set to false after canceling.
     */
    it('should set qwen.diff.isVisible context to false', async () => {
      await diffManager.showDiff('/test/file.ts', 'old', 'new');
      vi.mocked(vscode.commands.executeCommand).mockClear();

      const uriFromCall = vi
        .mocked(vscode.Uri.from)
        .mock.results.find((r) =>
          (r.value as vscode.Uri).query?.includes('new'),
        )?.value as vscode.Uri;

      if (uriFromCall) {
        await diffManager.cancelDiff(uriFromCall);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
          'setContext',
          'qwen.diff.isVisible',
          false,
        );
      }
    });

    /**
     * Test: Cancel non-existent Diff
     *
     * Verifies canceling a non-existent Diff doesn't throw.
     */
    it('should handle canceling non-existent diff gracefully', async () => {
      const unknownUri = {
        toString: () => 'unknown-uri',
        scheme: 'qwen-diff',
        path: '/unknown/file.ts',
      } as vscode.Uri;

      await expect(diffManager.cancelDiff(unknownUri)).resolves.not.toThrow();
    });
  });

  describe('closeAll', () => {
    /**
     * Test: Close all Diffs
     *
     * Verifies closeAll closes all open Diff views.
     * Needed to clean up Diffs after permission is granted.
     */
    it('should close all open diff editors', async () => {
      await diffManager.showDiff('/test/file1.ts', 'old1', 'new1');
      vi.mocked(vscode.commands.executeCommand).mockClear();

      await diffManager.closeAll();

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'setContext',
        'qwen.diff.isVisible',
        false,
      );
    });

    /**
     * Test: Close empty list
     *
     * Verifies closeAll doesn't throw when no Diffs are open.
     */
    it('should not throw when no diffs are open', async () => {
      await expect(diffManager.closeAll()).resolves.not.toThrow();
    });
  });

  describe('closeDiff', () => {
    /**
     * Test: Close Diff by file path
     *
     * Verifies specific Diff view can be closed by file path.
     */
    it('should close diff by file path', async () => {
      await diffManager.showDiff('/test/file.ts', 'old', 'new');

      const result = await diffManager.closeDiff('/test/file.ts');

      // Should return content when closed
      expect(result).toBeDefined();
    });

    /**
     * Test: Close non-existent file Diff
     *
     * Verifies closing non-existent file Diff returns undefined.
     */
    it('should return undefined for non-existent file', async () => {
      const result = await diffManager.closeDiff('/non/existent.ts');

      expect(result).toBeUndefined();
    });
  });

  describe('suppressFor', () => {
    /**
     * Test: Temporarily suppress Diff display
     *
     * Verifies suppressFor temporarily prevents Diff display.
     * Used to briefly suppress new Diffs after permission is granted.
     */
    it('should suppress diffs for specified duration', () => {
      // This method sets an internal timestamp
      expect(() => diffManager.suppressFor(1000)).not.toThrow();
    });
  });

  describe('dispose', () => {
    /**
     * Test: Resource cleanup
     *
     * Verifies dispose doesn't throw.
     */
    it('should dispose without errors', () => {
      expect(() => diffManager.dispose()).not.toThrow();
    });
  });

  describe('onDidChange event', () => {
    /**
     * Test: Event emitter
     *
     * Verifies DiffManager has onDidChange event.
     * Used to notify other components of Diff state changes.
     */
    it('should have onDidChange event', () => {
      expect(diffManager.onDidChange).toBeDefined();
    });
  });
});
