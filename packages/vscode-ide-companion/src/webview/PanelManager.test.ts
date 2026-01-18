/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * PanelManager 测试
 *
 * 测试目标：确保 WebView Panel/Tab 能正确创建和管理，防止 Tab 无法打开问题
 *
 * 关键测试场景：
 * 1. Panel 创建 - 确保能成功创建 WebView Panel
 * 2. Panel 复用 - 确保不会重复创建 Panel
 * 3. Panel 显示 - 确保 Panel 能正确 reveal
 * 4. Tab 捕获 - 确保能正确捕获和追踪 Tab
 * 5. 资源释放 - 确保 dispose 正确清理资源
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { PanelManager } from './PanelManager.js';

describe('PanelManager', () => {
  let panelManager: PanelManager;
  let mockExtensionUri: vscode.Uri;
  let onDisposeCallback: () => void;
  let mockPanel: vscode.WebviewPanel;

  beforeEach(() => {
    vi.clearAllMocks();

    mockExtensionUri = { fsPath: '/path/to/extension' } as vscode.Uri;
    onDisposeCallback = vi.fn();

    // 创建 mock panel
    mockPanel = {
      webview: {
        html: '',
        options: {},
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
        postMessage: vi.fn(),
      },
      viewType: 'qwenCode.chat',
      title: 'Qwen Code',
      iconPath: null,
      visible: true,
      active: true,
      viewColumn: 1,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
      reveal: vi.fn(),
      dispose: vi.fn(),
    } as unknown as vscode.WebviewPanel;

    // Mock vscode.window.createWebviewPanel
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mockPanel);
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);

    // Mock tabGroups
    Object.defineProperty(vi.mocked(vscode.window.tabGroups), 'all', {
      value: [],
      writable: true,
    });
    Object.assign(vi.mocked(vscode.window.tabGroups).activeTabGroup, {
      viewColumn: 1,
      tabs: [],
      isActive: true,
      activeTab: undefined,
    });

    panelManager = new PanelManager(mockExtensionUri, onDisposeCallback);
  });

  afterEach(() => {
    panelManager.dispose();
  });

  describe('createPanel', () => {
    /**
     * 测试：首次创建 Panel
     *
     * 验证 PanelManager 能成功创建新的 WebView Panel
     * 如果创建失败，用户将看不到聊天界面
     */
    it('should create a new panel when none exists', async () => {
      const result = await panelManager.createPanel();

      expect(result).toBe(true);
      expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
        'qwenCode.chat', // viewType
        'Qwen Code', // title
        expect.any(Object), // viewColumn options
        expect.objectContaining({
          enableScripts: true, // 必须启用脚本才能运行 React
          retainContextWhenHidden: true, // 隐藏时保持状态
        }),
      );
    });

    /**
     * 测试：Panel 复用
     *
     * 验证当 Panel 已存在时，不会重复创建
     * 防止创建多个不必要的 Panel
     */
    it('should return false if panel already exists', async () => {
      await panelManager.createPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockClear();

      const result = await panelManager.createPanel();

      expect(result).toBe(false);
      expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
    });

    /**
     * 测试：Panel 图标设置
     *
     * 验证创建 Panel 时设置了正确的图标
     * 图标显示在 Tab 上，帮助用户识别
     */
    it('should set panel icon', async () => {
      await panelManager.createPanel();

      expect(mockPanel.iconPath).toBeDefined();
    });

    /**
     * 测试：启用脚本
     *
     * 验证创建 Panel 时启用了脚本执行
     * 这是 React 应用运行的必要条件
     */
    it('should create panel with scripts enabled', async () => {
      await panelManager.createPanel();

      const createCall = vi.mocked(vscode.window.createWebviewPanel).mock
        .calls[0];
      const options = createCall[3] as vscode.WebviewPanelOptions &
        vscode.WebviewOptions;

      expect(options.enableScripts).toBe(true);
    });

    /**
     * 测试：保持上下文
     *
     * 验证创建 Panel 时设置了 retainContextWhenHidden
     * 防止切换 Tab 时丢失聊天状态
     */
    it('should retain context when hidden', async () => {
      await panelManager.createPanel();

      const createCall = vi.mocked(vscode.window.createWebviewPanel).mock
        .calls[0];
      const options = createCall[3] as vscode.WebviewPanelOptions &
        vscode.WebviewOptions;

      expect(options.retainContextWhenHidden).toBe(true);
    });

    /**
     * 测试：本地资源根目录
     *
     * 验证创建 Panel 时设置了正确的本地资源根目录
     * 这决定了 WebView 能访问哪些本地文件
     */
    it('should set local resource roots', async () => {
      await panelManager.createPanel();

      const createCall = vi.mocked(vscode.window.createWebviewPanel).mock
        .calls[0];
      const options = createCall[3] as vscode.WebviewPanelOptions &
        vscode.WebviewOptions;

      expect(options.localResourceRoots).toBeDefined();
      expect(options.localResourceRoots?.length).toBeGreaterThan(0);
    });
  });

  describe('getPanel', () => {
    /**
     * 测试：获取空 Panel
     *
     * 验证在没有创建 Panel 时返回 null
     */
    it('should return null when no panel exists', () => {
      expect(panelManager.getPanel()).toBeNull();
    });

    /**
     * 测试：获取已创建的 Panel
     *
     * 验证能正确获取已创建的 Panel 实例
     */
    it('should return panel after creation', async () => {
      await panelManager.createPanel();

      expect(panelManager.getPanel()).toBe(mockPanel);
    });
  });

  describe('setPanel', () => {
    /**
     * 测试：设置 Panel（用于恢复）
     *
     * 验证能设置已有的 Panel，用于 VSCode 重启后的恢复
     */
    it('should set panel for restoration', () => {
      panelManager.setPanel(mockPanel);

      expect(panelManager.getPanel()).toBe(mockPanel);
    });
  });

  describe('revealPanel', () => {
    /**
     * 测试：显示 Panel
     *
     * 验证能正确调用 reveal 显示 Panel
     * 当用户点击打开聊天时需要此功能
     */
    it('should reveal panel when it exists', async () => {
      await panelManager.createPanel();

      panelManager.revealPanel();

      expect(mockPanel.reveal).toHaveBeenCalled();
    });

    /**
     * 测试：保持焦点选项
     *
     * 验证 reveal 时能正确传递 preserveFocus 参数
     */
    it('should respect preserveFocus parameter', async () => {
      await panelManager.createPanel();

      panelManager.revealPanel(true);

      expect(mockPanel.reveal).toHaveBeenCalledWith(
        expect.any(Number),
        true, // preserveFocus
      );
    });
  });

  describe('dispose', () => {
    /**
     * 测试：释放资源
     *
     * 验证 dispose 正确清理 Panel 资源
     * 防止内存泄漏
     */
    it('should dispose panel and set to null', async () => {
      await panelManager.createPanel();

      panelManager.dispose();

      expect(mockPanel.dispose).toHaveBeenCalled();
      expect(panelManager.getPanel()).toBeNull();
    });

    /**
     * 测试：安全 dispose
     *
     * 验证在没有 Panel 时 dispose 不会报错
     */
    it('should not throw when disposing without panel', () => {
      expect(() => panelManager.dispose()).not.toThrow();
    });
  });

  describe('registerDisposeHandler', () => {
    /**
     * 测试：注册 dispose 回调
     *
     * 验证能注册 Panel dispose 时的回调
     * 用于清理相关资源
     */
    it('should register dispose handler', async () => {
      await panelManager.createPanel();
      const disposables: vscode.Disposable[] = [];

      panelManager.registerDisposeHandler(disposables);

      expect(mockPanel.onDidDispose).toHaveBeenCalled();
    });
  });

  describe('registerViewStateChangeHandler', () => {
    /**
     * 测试：注册视图状态变更处理器
     *
     * 验证能监听 Panel 的视图状态变更
     * 用于更新 Tab 追踪
     */
    it('should register view state change handler', async () => {
      await panelManager.createPanel();
      const disposables: vscode.Disposable[] = [];

      panelManager.registerViewStateChangeHandler(disposables);

      expect(mockPanel.onDidChangeViewState).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    /**
     * 测试：创建 Panel 失败处理
     *
     * 验证当创建新编辑器组失败时能正确 fallback
     */
    it('should handle newGroupRight command failure gracefully', async () => {
      vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(
        new Error('Command failed'),
      );

      // 应该不抛出错误，而是 fallback 到其他方式
      const result = await panelManager.createPanel();

      expect(result).toBe(true);
    });
  });
});
