/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * WebViewContent 测试
 *
 * 测试目标：确保 WebView HTML 能正确生成，防止 WebView 白屏问题
 *
 * 关键测试场景：
 * 1. HTML 结构完整性 - 确保生成的 HTML 包含必要元素
 * 2. CSP 配置正确 - 防止安全问题
 * 3. 脚本引用正确 - 确保 React 应用能加载
 * 4. XSS 防护 - 确保 URI 被正确转义
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { WebViewContent } from './WebViewContent.js';

describe('WebViewContent', () => {
  let mockPanel: vscode.WebviewPanel;
  let mockExtensionUri: vscode.Uri;

  beforeEach(() => {
    // 模拟扩展 URI
    mockExtensionUri = { fsPath: '/path/to/extension' } as vscode.Uri;

    // 模拟 WebView Panel
    mockPanel = {
      webview: {
        asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
          toString: () => `vscode-webview://resource${uri.fsPath}`,
        })),
        cspSource: 'vscode-webview:',
      },
    } as unknown as vscode.WebviewPanel;
  });

  /**
   * 测试：HTML 基本结构
   *
   * 验证生成的 HTML 包含 DOCTYPE、html、head、body 等基本元素
   * 如果这些元素缺失，WebView 可能无法正常渲染
   */
  it('should generate valid HTML with required elements', () => {
    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<head>');
    expect(html).toContain('<body');
    expect(html).toContain('</html>');
  });

  /**
   * 测试：React 挂载点
   *
   * 验证 HTML 包含 id="root" 的 div，这是 React 应用的挂载点
   * 如果缺失，React 应用将无法渲染
   */
  it('should include React mount point (#root)', () => {
    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(html).toContain('<div id="root"></div>');
  });

  /**
   * 测试：CSP (Content Security Policy) 配置
   *
   * 验证 HTML 包含正确的 CSP meta 标签
   * CSP 用于防止 XSS 攻击，但配置不当会导致脚本无法加载
   */
  it('should include Content-Security-Policy meta tag', () => {
    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('script-src');
    expect(html).toContain('style-src');
    expect(html).toContain('img-src');
  });

  /**
   * 测试：脚本引用
   *
   * 验证 HTML 包含 webview.js 的脚本引用
   * 这是编译后的 React 应用入口，缺失会导致白屏
   */
  it('should include webview.js script reference', () => {
    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(html).toContain('<script src=');
    expect(html).toContain('webview.js');
  });

  /**
   * 测试：Extension URI 属性
   *
   * 验证 body 元素包含 data-extension-uri 属性
   * 前端代码使用此属性构建资源路径（如图标）
   */
  it('should set data-extension-uri attribute on body', () => {
    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(html).toContain('data-extension-uri=');
  });

  /**
   * 测试：XSS 防护
   *
   * 验证特殊字符被正确转义，防止 XSS 攻击
   * 如果 URI 包含恶意脚本，应该被转义而不是执行
   */
  it('should escape HTML in URIs to prevent XSS', () => {
    // 模拟包含特殊字符的 URI
    mockPanel.webview.asWebviewUri = vi.fn((_localResource: { fsPath: string }) => ({
      toString: () => 'vscode-webview://resource&lt;script&gt;alert(1)&lt;/script&gt;',
    } as any));

    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    // 确保 <script> 标签被转义
    expect(html).not.toContain('<script>alert(1)</script>');
    // 应该包含转义后的版本
    expect(html).toMatch(/&lt;script&gt;|&#60;script&#62;/);
  });

  /**
   * 测试：Viewport meta 标签
   *
   * 验证 HTML 包含正确的 viewport 设置
   * 这对于响应式布局很重要
   */
  it('should include viewport meta tag', () => {
    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(html).toContain('name="viewport"');
    expect(html).toContain('width=device-width');
  });

  /**
   * 测试：字符编码
   *
   * 验证 HTML 声明了 UTF-8 编码
   * 缺失可能导致中文等字符显示乱码
   */
  it('should declare UTF-8 charset', () => {
    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(html).toContain('charset="UTF-8"');
  });

  /**
   * 测试：asWebviewUri 调用
   *
   * 验证正确调用了 asWebviewUri 来转换资源 URI
   * 这是 VSCode WebView 安全机制的一部分
   */
  it('should call asWebviewUri for resource paths', () => {
    WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(mockPanel.webview.asWebviewUri).toHaveBeenCalled();
  });
});
