/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * WebViewContent Tests
 *
 * Test objective: Ensure WebView HTML is correctly generated, preventing WebView blank screen issues.
 *
 * Key test scenarios:
 * 1. HTML structure integrity - Ensure generated HTML contains required elements
 * 2. CSP configuration - Prevent security issues
 * 3. Script references - Ensure React app can load
 * 4. XSS protection - Ensure URIs are properly escaped
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { WebViewContent } from './WebViewContent.js';

describe('WebViewContent', () => {
  let mockPanel: vscode.WebviewPanel;
  let mockExtensionUri: vscode.Uri;

  beforeEach(() => {
    // Mock extension URI
    mockExtensionUri = { fsPath: '/path/to/extension' } as vscode.Uri;

    // Mock WebView Panel
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
   * Test: Basic HTML structure
   *
   * Verifies generated HTML contains DOCTYPE, html, head, body elements.
   * WebView may fail to render if these elements are missing.
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
   * Test: React mount point
   *
   * Verifies HTML contains div with id="root", the React app mount point.
   * React app cannot render if this is missing.
   */
  it('should include React mount point (#root)', () => {
    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(html).toContain('<div id="root"></div>');
  });

  /**
   * Test: CSP (Content Security Policy) configuration
   *
   * Verifies HTML contains correct CSP meta tag.
   * CSP prevents XSS attacks, but misconfiguration can prevent scripts from loading.
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
   * Test: Script reference
   *
   * Verifies HTML contains webview.js script reference.
   * This is the compiled React app entry point; missing it causes blank screen.
   */
  it('should include webview.js script reference', () => {
    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(html).toContain('<script src=');
    expect(html).toContain('webview.js');
  });

  /**
   * Test: Extension URI attribute
   *
   * Verifies body element contains data-extension-uri attribute.
   * Frontend code uses this attribute to build resource paths (like icons).
   */
  it('should set data-extension-uri attribute on body', () => {
    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(html).toContain('data-extension-uri=');
  });

  /**
   * Test: XSS protection
   *
   * Verifies special characters are properly escaped to prevent XSS attacks.
   * If URI contains malicious scripts, they should be escaped, not executed.
   */
  it('should escape HTML in URIs to prevent XSS', () => {
    // Mock URI containing special characters
    mockPanel.webview.asWebviewUri = vi.fn(
      (_localResource: { fsPath: string }) =>
        ({
          toString: () =>
            'vscode-webview://resource&lt;script&gt;alert(1)&lt;/script&gt;',
        }) as vscode.Uri,
    );

    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    // Ensure <script> tag is escaped
    expect(html).not.toContain('<script>alert(1)</script>');
    // Should contain escaped version
    expect(html).toMatch(/&lt;script&gt;|&#60;script&#62;/);
  });

  /**
   * Test: Viewport meta tag
   *
   * Verifies HTML contains correct viewport settings.
   * This is important for responsive layout.
   */
  it('should include viewport meta tag', () => {
    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(html).toContain('name="viewport"');
    expect(html).toContain('width=device-width');
  });

  /**
   * Test: Character encoding
   *
   * Verifies HTML declares UTF-8 encoding.
   * Missing this may cause garbled display of non-ASCII characters.
   */
  it('should declare UTF-8 charset', () => {
    const html = WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(html).toContain('charset="UTF-8"');
  });

  /**
   * Test: asWebviewUri calls
   *
   * Verifies asWebviewUri is correctly called to convert resource URIs.
   * This is part of VSCode WebView security mechanism.
   */
  it('should call asWebviewUri for resource paths', () => {
    WebViewContent.generate(mockPanel, mockExtensionUri);

    expect(mockPanel.webview.asWebviewUri).toHaveBeenCalled();
  });
});
