/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { DiffContentProvider, DiffManager } from './diff-manager.js';
import { DIFF_SCHEME } from './extension.js';

// Mock the vscode module globally
vi.mock('vscode', () => ({
  EventEmitter: vi.fn(() => ({
    event: vi.fn(),
    fire: vi.fn(),
  })),
  Uri: {
    file: vi.fn((path: string) => ({
      toString: vi.fn(() => path),
      fsPath: path,
      scheme: 'file',
    })),
    from: vi.fn((options: { scheme: string; path: string; query: string }) => ({
      toString: vi.fn(() => JSON.stringify(options)),
      scheme: options.scheme,
      path: options.path,
      query: options.query,
    })),
    parse: vi.fn((uri: string) => ({
      toString: vi.fn(() => uri),
      scheme: 'qwen-diff',
    })),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  workspace: {
    openTextDocument: vi.fn((uri: unknown) => ({
      getText: vi.fn(() => 'mocked content'),
      uri: uri || { toString: vi.fn(() => 'mock-uri') },
    })),
    fs: {
      stat: vi.fn(),
    },
    onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    registerTextDocumentContentProvider: vi.fn(),
  },
  window: {
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    activeTextEditor: undefined,
    tabGroups: {
      all: [],
      close: vi.fn(),
    },
  },
}));

describe('DiffContentProvider', () => {
  let provider: DiffContentProvider;

  beforeEach(() => {
    provider = new DiffContentProvider();
  });

  it('should initialize with empty content', () => {
    const uri = { toString: vi.fn(() => 'test-uri') };
    expect(provider.getContent(uri as any)).toBeUndefined(); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it('should set and provide content', () => {
    const uri = { toString: vi.fn(() => 'test-uri') };
    const content = 'test content';

    provider.setContent(uri as any, content); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(provider.provideTextDocumentContent(uri as any)).toBe(content); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(provider.getContent(uri as any)).toBe(content); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it('should delete content', () => {
    const uri = { toString: vi.fn(() => 'test-uri') };
    provider.setContent(uri as any, 'test content'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(provider.getContent(uri as any)).toBe('test content'); // eslint-disable-line @typescript-eslint/no-explicit-any

    provider.deleteContent(uri as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(provider.getContent(uri as any)).toBeUndefined(); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});

describe('DiffManager', () => {
  let diffManager: DiffManager;
  let diffContentProvider: DiffContentProvider;
  let log: (message: string) => void;

  beforeEach(() => {
    log = vi.fn();
    diffContentProvider = new DiffContentProvider();
    diffManager = new DiffManager(log, diffContentProvider);
  });

  afterEach(() => {
    diffManager.dispose();
    vi.clearAllMocks();
  });

  it('should initialize with subscriptions', () => {
    expect(diffManager).toBeDefined();
  });

  it('should show diff and create content', async () => {
    const filePath = '/test/file.ts';
    const newContent = 'console.log("hello world");';

    // Mock the file system stat to return success (file exists)
    vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({} as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    await diffManager.showDiff(filePath, newContent);

    // Verify that the command was executed
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'qwen.diff.isVisible',
      true,
    );
  });

  it('should handle file not existing when showing diff', async () => {
    const filePath = '/test/file.ts';
    const newContent = 'console.log("hello world");';

    // Mock the file system stat to throw an error (file doesn't exist)
    vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(
      new Error('File not found'),
    );

    await diffManager.showDiff(filePath, newContent);

    // Verify that the command was executed
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'qwen.diff.isVisible',
      true,
    );
  });

  it('should close diff and return content', async () => {
    const filePath = '/test/file.ts';
    const newContent = 'console.log("hello world");';

    // First, show a diff to create it
    vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({} as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    await diffManager.showDiff(filePath, newContent);

    // Set the mock content to return the expected value
    const mockTextDocument = {
      getText: vi.fn(() => newContent),
      uri: { toString: vi.fn(() => `${DIFF_SCHEME}:${filePath}`) },
    };
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
      mockTextDocument as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    );

    // Then close the diff
    const result = await diffManager.closeDiff(filePath);

    expect(result).toBe(newContent);
  });

  it('should handle close diff with suppressNotification', async () => {
    const filePath = '/test/file.ts';
    const newContent = 'console.log("hello world");';

    // First, show a diff to create it
    vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({} as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    await diffManager.showDiff(filePath, newContent);

    // Set the mock content to return the expected value
    const mockTextDocument = {
      getText: vi.fn(() => newContent),
      uri: { toString: vi.fn(() => `${DIFF_SCHEME}:${filePath}`) },
    };
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
      mockTextDocument as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    );

    // Then close the diff with suppression
    const result = await diffManager.closeDiff(filePath, true);

    expect(result).toBe(newContent);
  });

  it('should accept diff', async () => {
    const filePath = '/test/file.ts';
    const newContent = 'console.log("hello world");';

    // Show a diff first
    vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({} as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    await diffManager.showDiff(filePath, newContent);

    // Mock the URI for the right document
    const rightDocUri = {
      toString: vi.fn(() => `${DIFF_SCHEME}:${filePath}?rand=test`),
      scheme: DIFF_SCHEME,
      path: filePath,
    };

    // Mock the openTextDocument to return a document with text
    const mockTextDocument = {
      getText: vi.fn(() => newContent),
      uri: rightDocUri,
    };
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
      mockTextDocument as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    );

    // Call acceptDiff
    await diffManager.acceptDiff(rightDocUri as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    // Verify the command was executed
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'qwen.diff.isVisible',
      false,
    );
  });

  it('should cancel diff when diff info exists', async () => {
    const filePath = '/test/file.ts';
    const newContent = 'console.log("hello world");';

    // Show a diff first
    vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({} as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    await diffManager.showDiff(filePath, newContent);

    // Mock the URI for the right document
    const rightDocUri = {
      toString: vi.fn(() => `${DIFF_SCHEME}:${filePath}?rand=test`),
      scheme: DIFF_SCHEME,
      path: filePath,
    };

    // Mock the openTextDocument to return a document with text
    const mockTextDocument = {
      getText: vi.fn(() => newContent),
      uri: rightDocUri,
    };
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
      mockTextDocument as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    );

    // Call cancelDiff
    await diffManager.cancelDiff(rightDocUri as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    // Verify the command was executed
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'qwen.diff.isVisible',
      false,
    );
  });

  it('should cancel diff when diff info does not exist', async () => {
    const rightDocUri = {
      toString: vi.fn(() => `${DIFF_SCHEME}:/nonexistent.ts?rand=test`),
      scheme: DIFF_SCHEME,
    };

    // Call cancelDiff with a URI that doesn't have diff info
    await diffManager.cancelDiff(rightDocUri as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    // Verify the command was executed
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      'qwen.diff.isVisible',
      false,
    );

    // Verify the log was called
    expect(log).toHaveBeenCalledWith(
      `No diff info found for ${rightDocUri.toString()}`,
    );
  });

  it('should dispose correctly', () => {
    const disposeSpy = vi.spyOn(diffManager, 'dispose');
    diffManager.dispose();
    expect(disposeSpy).toHaveBeenCalled();
  });
});
