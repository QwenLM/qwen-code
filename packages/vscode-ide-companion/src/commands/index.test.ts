/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Commands Tests
 *
 * Test objective: Ensure all VSCode commands are correctly registered and executed, preventing command failures.
 *
 * Key test scenarios:
 * 1. Command registration - Ensure all commands are properly registered with VSCode
 * 2. openChat - Ensure the chat panel can be opened
 * 3. showDiff - Ensure Diff view can be displayed
 * 4. openNewChatTab - Ensure a new chat Tab can be opened
 * 5. login - Ensure the login flow can be triggered
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import {
  registerNewCommands,
  openChatCommand,
  showDiffCommand,
  openNewChatTabCommand,
  loginCommand,
} from './index.js';
import type { DiffManager } from '../diff-manager.js';
import type { WebViewProvider } from '../webview/WebViewProvider.js';

describe('Commands', () => {
  let mockContext: vscode.ExtensionContext;
  let mockLog: (message: string) => void;
  let mockDiffManager: DiffManager;
  let mockWebViewProviders: WebViewProvider[];
  let mockGetWebViewProviders: () => WebViewProvider[];
  let mockCreateWebViewProvider: () => WebViewProvider;
  let registeredCommands: Map<string, (...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands = new Map();

    // Mock context
    mockContext = {
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    // Mock logger
    mockLog = vi.fn();

    // Mock DiffManager
    mockDiffManager = {
      showDiff: vi.fn().mockResolvedValue(undefined),
    } as unknown as DiffManager;

    // Mock WebViewProviders
    mockWebViewProviders = [];
    mockGetWebViewProviders = () => mockWebViewProviders;

    // Mock createWebViewProvider
    const mockProvider = {
      show: vi.fn().mockResolvedValue(undefined),
      forceReLogin: vi.fn().mockResolvedValue(undefined),
    } as unknown as WebViewProvider;
    mockCreateWebViewProvider = vi.fn(() => mockProvider);

    // Mock vscode.commands.registerCommand to capture handlers
    vi.mocked(vscode.commands.registerCommand).mockImplementation(
      (command: string, callback: (...args: unknown[]) => unknown) => {
        registeredCommands.set(command, callback);
        return { dispose: vi.fn() } as vscode.Disposable;
      },
    );

    // Mock workspace folders
    vi.mocked(vscode.workspace).workspaceFolders = [
      {
        uri: { fsPath: '/workspace' },
      } as vscode.WorkspaceFolder,
    ];

    vi.mocked(vscode.Uri.joinPath).mockImplementation(
      (base: vscode.Uri, ...paths: string[]) =>
        ({
          fsPath: `${base.fsPath}/${paths.join('/')}`,
        }) as vscode.Uri,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('registerNewCommands', () => {
    /**
     * Test: Command registration
     *
     * Verifies registerNewCommands correctly registers all commands.
     * If commands are not registered, users cannot use keyboard shortcuts or command palette.
     */
    it('should register all required commands', () => {
      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        openChatCommand,
        expect.any(Function),
      );
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        showDiffCommand,
        expect.any(Function),
      );
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        openNewChatTabCommand,
        expect.any(Function),
      );
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        loginCommand,
        expect.any(Function),
      );
    });

    /**
     * Test: Subscription management
     *
     * Verifies command disposables are added to context.subscriptions.
     * Ensures commands are properly cleaned up when extension is deactivated.
     */
    it('should add disposables to context.subscriptions', () => {
      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      // Should register 4 commands, each added to subscriptions
      expect(mockContext.subscriptions.length).toBe(4);
    });
  });

  describe('openChat command', () => {
    /**
     * Test: Open existing chat panel
     *
     * Verifies that when a WebViewProvider already exists, it uses the existing provider.
     * Prevents creating unnecessary new panels.
     */
    it('should show existing provider when providers exist', async () => {
      const mockProvider = {
        show: vi.fn().mockResolvedValue(undefined),
      } as unknown as WebViewProvider;
      mockWebViewProviders.push(mockProvider);

      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      const handler = registeredCommands.get(openChatCommand);
      await handler?.();

      expect(mockProvider.show).toHaveBeenCalled();
      expect(mockCreateWebViewProvider).not.toHaveBeenCalled();
    });

    /**
     * Test: Create new chat panel
     *
     * Verifies that when no provider exists, a new provider is created.
     * Ensures users can always open the chat interface.
     */
    it('should create new provider when no providers exist', async () => {
      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      const handler = registeredCommands.get(openChatCommand);
      await handler?.();

      expect(mockCreateWebViewProvider).toHaveBeenCalled();
    });

    /**
     * Test: Use the latest provider
     *
     * Verifies that when multiple providers exist, the last one (newest) is used.
     */
    it('should use the last provider when multiple exist', async () => {
      const firstProvider = {
        show: vi.fn().mockResolvedValue(undefined),
      } as unknown as WebViewProvider;
      const lastProvider = {
        show: vi.fn().mockResolvedValue(undefined),
      } as unknown as WebViewProvider;
      mockWebViewProviders.push(firstProvider, lastProvider);

      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      const handler = registeredCommands.get(openChatCommand);
      await handler?.();

      expect(lastProvider.show).toHaveBeenCalled();
      expect(firstProvider.show).not.toHaveBeenCalled();
    });
  });

  describe('showDiff command', () => {
    /**
     * Test: Show Diff (absolute path)
     *
     * Verifies that absolute paths are passed directly to diffManager.
     */
    it('should show diff with absolute path', async () => {
      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      const handler = registeredCommands.get(showDiffCommand);
      await handler?.({
        path: '/absolute/path/file.ts',
        oldText: 'old content',
        newText: 'new content',
      });

      expect(mockDiffManager.showDiff).toHaveBeenCalledWith(
        '/absolute/path/file.ts',
        'old content',
        'new content',
      );
    });

    /**
     * Test: Show Diff (relative path)
     *
     * Verifies that relative paths are correctly joined with workspace path.
     * This is a common usage pattern, ensuring relative paths resolve correctly.
     */
    it('should resolve relative path against workspace folder', async () => {
      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      const handler = registeredCommands.get(showDiffCommand);
      await handler?.({
        path: 'src/file.ts',
        oldText: 'old',
        newText: 'new',
      });

      expect(mockDiffManager.showDiff).toHaveBeenCalledWith(
        '/workspace/src/file.ts',
        'old',
        'new',
      );
    });

    /**
     * Test: Log operations
     *
     * Verifies showDiff command logs operations.
     * Useful for debugging and troubleshooting.
     */
    it('should log the diff operation', async () => {
      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      const handler = registeredCommands.get(showDiffCommand);
      await handler?.({
        path: '/test/file.ts',
        oldText: 'old',
        newText: 'new',
      });

      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining('[Command] Showing diff'),
      );
    });

    /**
     * Test: Error handling
     *
     * Verifies diffManager errors are properly caught and displayed.
     * Prevents unhandled exceptions from crashing the extension.
     */
    it('should handle errors and show error message', async () => {
      vi.mocked(mockDiffManager.showDiff).mockRejectedValue(
        new Error('Diff error'),
      );

      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      const handler = registeredCommands.get(showDiffCommand);
      await handler?.({
        path: '/test/file.ts',
        oldText: 'old',
        newText: 'new',
      });

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to show diff'),
      );
      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining('[Command] Error showing diff'),
      );
    });

    /**
     * Test: Windows path handling
     *
     * Verifies Windows-style absolute paths are correctly recognized.
     */
    it('should handle Windows absolute paths', async () => {
      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      const handler = registeredCommands.get(showDiffCommand);
      await handler?.({
        path: 'C:/Users/test/file.ts',
        oldText: 'old',
        newText: 'new',
      });

      // Windows path should be recognized as absolute, no joining needed
      expect(mockDiffManager.showDiff).toHaveBeenCalledWith(
        'C:/Users/test/file.ts',
        'old',
        'new',
      );
    });
  });

  describe('openNewChatTab command', () => {
    /**
     * Test: Create new chat Tab
     *
     * Verifies the command always creates a new WebViewProvider.
     * Allows users to open multiple chat sessions simultaneously.
     */
    it('should always create new provider', async () => {
      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      const handler = registeredCommands.get(openNewChatTabCommand);
      await handler?.();

      expect(mockCreateWebViewProvider).toHaveBeenCalled();
    });

    /**
     * Test: Create new provider even when existing ones exist
     *
     * Unlike openChat, openNewChatTab always creates a new one.
     */
    it('should create new provider even when providers exist', async () => {
      const existingProvider = {
        show: vi.fn(),
      } as unknown as WebViewProvider;
      mockWebViewProviders.push(existingProvider);

      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      const handler = registeredCommands.get(openNewChatTabCommand);
      await handler?.();

      expect(mockCreateWebViewProvider).toHaveBeenCalled();
      expect(existingProvider.show).not.toHaveBeenCalled();
    });
  });

  describe('login command', () => {
    /**
     * Test: Login with existing provider
     *
     * Verifies forceReLogin is called when a provider exists.
     */
    it('should call forceReLogin on existing provider', async () => {
      const mockProvider = {
        forceReLogin: vi.fn().mockResolvedValue(undefined),
      } as unknown as WebViewProvider;
      mockWebViewProviders.push(mockProvider);

      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      const handler = registeredCommands.get(loginCommand);
      await handler?.();

      expect(mockProvider.forceReLogin).toHaveBeenCalled();
    });

    /**
     * Test: Show message when no provider exists
     *
     * Verifies an info message is shown when no provider exists.
     * Guides users to open the chat interface first.
     */
    it('should show info message when no providers exist', async () => {
      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      const handler = registeredCommands.get(loginCommand);
      await handler?.();

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Please open Qwen Code chat first'),
      );
    });

    /**
     * Test: Use latest provider for login
     *
     * Verifies the last provider is used when multiple exist.
     */
    it('should use the last provider for login', async () => {
      const firstProvider = {
        forceReLogin: vi.fn().mockResolvedValue(undefined),
      } as unknown as WebViewProvider;
      const lastProvider = {
        forceReLogin: vi.fn().mockResolvedValue(undefined),
      } as unknown as WebViewProvider;
      mockWebViewProviders.push(firstProvider, lastProvider);

      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      const handler = registeredCommands.get(loginCommand);
      await handler?.();

      expect(lastProvider.forceReLogin).toHaveBeenCalled();
      expect(firstProvider.forceReLogin).not.toHaveBeenCalled();
    });
  });

  describe('command constants', () => {
    /**
     * Test: Command name constants
     *
     * Verifies command name constants are correctly defined.
     * Prevents typos from causing commands to not be found.
     */
    it('should export correct command names', () => {
      expect(openChatCommand).toBe('qwen-code.openChat');
      expect(showDiffCommand).toBe('qwenCode.showDiff');
      expect(openNewChatTabCommand).toBe('qwenCode.openNewChatTab');
      expect(loginCommand).toBe('qwen-code.login');
    });
  });
});
