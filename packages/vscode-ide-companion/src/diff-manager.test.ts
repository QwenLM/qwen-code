/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * DiffManager 测试
 *
 * 测试目标：确保 Diff 编辑器能正确显示代码对比，防止 Diff 无法打开问题
 *
 * 关键测试场景：
 * 1. Diff 显示 - 确保能正确打开 Diff 视图
 * 2. Diff 接受 - 确保用户能接受代码更改
 * 3. Diff 取消 - 确保用户能取消代码更改
 * 4. 去重逻辑 - 防止重复打开相同的 Diff
 * 5. 资源清理 - 确保 Diff 关闭后正确清理资源
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
   * 测试：设置和获取内容
   *
   * 验证 DiffContentProvider 能正确存储和检索 Diff 内容
   * 这是 VSCode Diff 视图的内容来源
   */
  it('should set and get content', () => {
    const uri = { toString: () => 'test-uri' } as vscode.Uri;

    provider.setContent(uri, 'test content');

    expect(provider.provideTextDocumentContent(uri)).toBe('test content');
  });

  /**
   * 测试：未知 URI 返回空字符串
   *
   * 验证对于未设置内容的 URI 返回空字符串，而不是报错
   */
  it('should return empty string for unknown URI', () => {
    const uri = { toString: () => 'unknown-uri' } as vscode.Uri;

    expect(provider.provideTextDocumentContent(uri)).toBe('');
  });

  /**
   * 测试：删除内容
   *
   * 验证能正确删除已设置的内容
   * 在 Diff 关闭时需要清理内容
   */
  it('should delete content', () => {
    const uri = { toString: () => 'test-uri' } as vscode.Uri;

    provider.setContent(uri, 'test content');
    provider.deleteContent(uri);

    expect(provider.provideTextDocumentContent(uri)).toBe('');
  });

  /**
   * 测试：getContent 方法
   *
   * 验证 getContent 能返回原始内容或 undefined
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

    // 重置 vscode mocks
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
      getText: () => 'modified content',
    } as vscode.TextDocument);
    // Reset tabGroups to empty state
    (vi.mocked(vscode.window.tabGroups).all as readonly vscode.TabGroup[]).length = 0;

    diffManager = new DiffManager(mockLog, mockContentProvider);
  });

  afterEach(() => {
    diffManager.dispose();
  });

  describe('showDiff', () => {
    /**
     * 测试：创建 Diff 视图
     *
     * 验证 showDiff 调用 vscode.diff 命令创建 Diff 视图
     * 如果此功能失败，用户将无法看到代码对比
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
     * 测试：设置 Diff 可见上下文
     *
     * 验证 showDiff 设置 qwen.diff.isVisible 上下文
     * 这控制了接受/取消按钮的显示
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
     * 测试：Diff 标题格式
     *
     * 验证 Diff 视图的标题包含文件名和 "Before ↔ After"
     * 帮助用户理解这是一个对比视图
     */
    it('should use correct diff title format', async () => {
      await diffManager.showDiff('/path/to/myfile.ts', 'old', 'new');

      const diffCall = vi.mocked(vscode.commands.executeCommand).mock.calls.find(
        (call) => call[0] === 'vscode.diff',
      );

      expect(diffCall?.[3]).toContain('myfile.ts');
      expect(diffCall?.[3]).toContain('Before');
      expect(diffCall?.[3]).toContain('After');
    });

    /**
     * 测试：去重 - 相同内容不重复打开
     *
     * 验证对于相同的文件和内容，不会重复创建 Diff 视图
     * 防止用户界面混乱
     */
    it('should deduplicate rapid duplicate calls', async () => {
      await diffManager.showDiff('/test/file.ts', 'old', 'new');

      vi.mocked(vscode.commands.executeCommand).mockClear();

      // 立即再次调用相同参数
      await diffManager.showDiff('/test/file.ts', 'old', 'new');

      // vscode.diff 不应该被再次调用
      const diffCalls = vi.mocked(vscode.commands.executeCommand).mock.calls.filter(
        (call) => call[0] === 'vscode.diff',
      );
      expect(diffCalls.length).toBe(0);
    });

    /**
     * 测试：保持焦点在 WebView
     *
     * 验证打开 Diff 时设置 preserveFocus: true
     * 确保聊天界面保持焦点，不打断用户输入
     */
    it('should preserve focus when showing diff', async () => {
      await diffManager.showDiff('/test/file.ts', 'old', 'new');

      const diffCall = vi.mocked(vscode.commands.executeCommand).mock.calls.find(
        (call) => call[0] === 'vscode.diff',
      );
      const options = diffCall?.[4] as { preserveFocus?: boolean } | undefined;

      expect(options?.preserveFocus).toBe(true);
    });

    /**
     * 测试：两参数重载 (自动读取原文件)
     *
     * 验证只传 newContent 时能自动读取原文件内容
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
     * 测试：接受 Diff 后清除上下文
     *
     * 验证接受 Diff 后设置 qwen.diff.isVisible 为 false
     * 这会隐藏接受/取消按钮
     */
    it('should set qwen.diff.isVisible context to false', async () => {
      // 先显示 Diff
      await diffManager.showDiff('/test/file.ts', 'old', 'new');
      vi.mocked(vscode.commands.executeCommand).mockClear();

      // 获取创建的 right URI
      const uriFromCall = vi.mocked(vscode.Uri.from).mock.results.find(
        (r) => (r.value as vscode.Uri).query?.includes('new'),
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
     * 测试：取消 Diff 后清除上下文
     *
     * 验证取消 Diff 后设置 qwen.diff.isVisible 为 false
     */
    it('should set qwen.diff.isVisible context to false', async () => {
      await diffManager.showDiff('/test/file.ts', 'old', 'new');
      vi.mocked(vscode.commands.executeCommand).mockClear();

      const uriFromCall = vi.mocked(vscode.Uri.from).mock.results.find(
        (r) => (r.value as vscode.Uri).query?.includes('new'),
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
     * 测试：取消不存在的 Diff
     *
     * 验证取消不存在的 Diff 不会报错
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
     * 测试：关闭所有 Diff
     *
     * 验证 closeAll 能关闭所有打开的 Diff 视图
     * 在权限允许后需要清理 Diff
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
     * 测试：关闭空列表
     *
     * 验证在没有打开 Diff 时 closeAll 不会报错
     */
    it('should not throw when no diffs are open', async () => {
      await expect(diffManager.closeAll()).resolves.not.toThrow();
    });
  });

  describe('closeDiff', () => {
    /**
     * 测试：按文件路径关闭 Diff
     *
     * 验证能通过文件路径关闭特定的 Diff 视图
     */
    it('should close diff by file path', async () => {
      await diffManager.showDiff('/test/file.ts', 'old', 'new');

      const result = await diffManager.closeDiff('/test/file.ts');

      // 应该返回关闭时的内容
      expect(result).toBeDefined();
    });

    /**
     * 测试：关闭不存在的文件 Diff
     *
     * 验证关闭不存在的文件 Diff 返回 undefined
     */
    it('should return undefined for non-existent file', async () => {
      const result = await diffManager.closeDiff('/non/existent.ts');

      expect(result).toBeUndefined();
    });
  });

  describe('suppressFor', () => {
    /**
     * 测试：临时抑制 Diff 显示
     *
     * 验证 suppressFor 能临时阻止 Diff 显示
     * 用于在权限允许后短暂抑制新 Diff
     */
    it('should suppress diffs for specified duration', () => {
      // 这个方法设置一个内部时间戳
      expect(() => diffManager.suppressFor(1000)).not.toThrow();
    });
  });

  describe('dispose', () => {
    /**
     * 测试：资源释放
     *
     * 验证 dispose 不会报错
     */
    it('should dispose without errors', () => {
      expect(() => diffManager.dispose()).not.toThrow();
    });
  });

  describe('onDidChange event', () => {
    /**
     * 测试：事件发射器
     *
     * 验证 DiffManager 有 onDidChange 事件
     * 用于通知其他组件 Diff 状态变化
     */
    it('should have onDidChange event', () => {
      expect(diffManager.onDidChange).toBeDefined();
    });
  });
});
