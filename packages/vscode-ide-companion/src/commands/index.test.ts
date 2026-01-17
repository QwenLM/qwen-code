/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Commands 测试
 *
 * 测试目标：确保所有 VSCode 命令能正确注册和执行，防止命令失效
 *
 * 关键测试场景：
 * 1. 命令注册 - 确保所有命令都正确注册到 VSCode
 * 2. openChat - 确保能打开聊天面板
 * 3. showDiff - 确保能显示 Diff 视图
 * 4. openNewChatTab - 确保能打开新的聊天 Tab
 * 5. login - 确保能触发登录流程
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
     * 测试：命令注册
     *
     * 验证 registerNewCommands 正确注册所有命令
     * 如果命令未注册，用户将无法使用快捷键或命令面板执行操作
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
     * 测试：订阅管理
     *
     * 验证命令 disposable 被添加到 context.subscriptions
     * 确保扩展停用时能正确清理命令
     */
    it('should add disposables to context.subscriptions', () => {
      registerNewCommands(
        mockContext,
        mockLog,
        mockDiffManager,
        mockGetWebViewProviders,
        mockCreateWebViewProvider,
      );

      // 应该注册 4 个命令，每个都添加到 subscriptions
      expect(mockContext.subscriptions.length).toBe(4);
    });
  });

  describe('openChat command', () => {
    /**
     * 测试：打开现有聊天面板
     *
     * 验证当已有 WebViewProvider 时，使用现有的 provider
     * 防止创建不必要的新面板
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
     * 测试：创建新聊天面板
     *
     * 验证当没有现有 provider 时，创建新的 provider
     * 确保用户总能打开聊天界面
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
     * 测试：使用最新的 provider
     *
     * 验证当有多个 provider 时，使用最后一个（最新的）
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
     * 测试：显示 Diff（绝对路径）
     *
     * 验证使用绝对路径时直接调用 diffManager
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
     * 测试：显示 Diff（相对路径）
     *
     * 验证使用相对路径时正确拼接工作区路径
     * 这是常见用法，确保相对路径能正确解析
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
     * 测试：记录日志
     *
     * 验证 showDiff 命令记录日志
     * 便于调试和问题排查
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
     * 测试：错误处理
     *
     * 验证 diffManager 错误被正确捕获和显示
     * 防止未处理异常导致扩展崩溃
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
     * 测试：Windows 路径处理
     *
     * 验证 Windows 风格的绝对路径被正确识别
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

      // Windows 路径应该被识别为绝对路径，不进行拼接
      expect(mockDiffManager.showDiff).toHaveBeenCalledWith(
        'C:/Users/test/file.ts',
        'old',
        'new',
      );
    });
  });

  describe('openNewChatTab command', () => {
    /**
     * 测试：创建新聊天 Tab
     *
     * 验证命令总是创建新的 WebViewProvider
     * 允许用户同时打开多个聊天会话
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
     * 测试：即使有现有 provider 也创建新的
     *
     * 与 openChat 不同，openNewChatTab 总是创建新的
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
     * 测试：登录已有 provider
     *
     * 验证有 provider 时调用 forceReLogin
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
     * 测试：无 provider 时提示用户
     *
     * 验证没有 provider 时显示提示信息
     * 引导用户先打开聊天界面
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
     * 测试：使用最新的 provider 进行登录
     *
     * 验证有多个 provider 时使用最后一个
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
     * 测试：命令名称常量
     *
     * 验证命令名称常量正确定义
     * 防止拼写错误导致命令无法找到
     */
    it('should export correct command names', () => {
      expect(openChatCommand).toBe('qwen-code.openChat');
      expect(showDiffCommand).toBe('qwenCode.showDiff');
      expect(openNewChatTabCommand).toBe('qwenCode.openNewChatTab');
      expect(loginCommand).toBe('qwen-code.login');
    });
  });
});
