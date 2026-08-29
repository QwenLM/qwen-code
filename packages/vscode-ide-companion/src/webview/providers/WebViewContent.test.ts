/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { WebViewContent } from './WebViewContent.js';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
  Uri: {
    joinPath: vi.fn((_base: unknown, ...parts: string[]) => ({
      fsPath: `/ext/${parts.join('/')}`,
    })),
  },
  env: {
    language: 'en'
  }
}));

/**
 * Helper: create a minimal mock vscode.Webview
 */
function createMockWebview() {
  return {
    asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
      toString: () => `https://webview/${uri.fsPath}`,
    })),
    cspSource: 'https://csp.source',
  };
}

describe('WebViewContent', () => {
  const fakeExtensionUri = { fsPath: '/ext' } as never;

  it('generates HTML when given a raw Webview', () => {
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Qwen Code');
    expect(html).toContain(webview.cspSource);
    expect(webview.asWebviewUri).toHaveBeenCalled();
  });

  it('generates HTML when given a WebviewPanel (has .webview property)', () => {
    const webview = createMockWebview();
    const panel = { webview };

    const html = WebViewContent.generate(panel as never, fakeExtensionUri);

    expect(html).toContain('<!DOCTYPE html>');
    expect(webview.asWebviewUri).toHaveBeenCalled();
  });

  it('generates HTML when given a WebviewView (has .webview property)', () => {
    const webview = createMockWebview();
    const view = { webview, viewType: 'sidebar' };

    const html = WebViewContent.generate(view as never, fakeExtensionUri);

    expect(html).toContain('<!DOCTYPE html>');
    expect(webview.asWebviewUri).toHaveBeenCalled();
  });

  it('includes the script tag with the correct URI', () => {
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    expect(html).toContain('<script type="module" src=');
    expect(html).toContain('webview.js');
  });

  it('sets extension-uri data attribute on the body', () => {
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    expect(html).toContain('data-extension-uri=');
  });

  it('grants wasm-unsafe-eval to script-src unconditionally', () => {
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    expect(html).toContain("script-src https://csp.source 'wasm-unsafe-eval';");
  });

  it('allows the WebShell transcript to use its inlined fonts', () => {
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    expect(html).toContain('font-src data:;');
  });

  it('does not set data-web-shell-transcript on the body', () => {
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    expect(html).not.toContain('data-web-shell-transcript');
  });

  it('injects vscode.env.language into html lang attribute (zh-CN)', () => {
    vscode.env.language = 'zh-CN';
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);
    expect(html).toContain('<html lang="zh-CN">');
  });

  it('injects vscode.env.language into html lang attribute (en)', () => {
    vscode.env.language = 'en';
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);
    expect(html).toContain('<html lang="en">');
  });
});
