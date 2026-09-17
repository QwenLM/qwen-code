/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isLoopbackHostname } from '../../services/daemonIdeConnection.js';
import { WebViewContent } from './WebViewContent.js';

const envMock = vi.hoisted(() => ({
  language: 'en',
  remoteName: undefined as string | undefined,
}));

vi.mock('vscode', () => ({
  env: envMock,
  Uri: {
    joinPath: vi.fn((_base: unknown, ...parts: string[]) => ({
      fsPath: `/ext/${parts.join('/')}`,
    })),
  },
}));

/**
 * Helper: create a minimal mock vscode.Webview
 */
function createMockWebview() {
  return {
    asWebviewUri: vi.fn((uri: { fsPath: string }) => {
      const toString = () => `https://webview/${uri.fsPath}`;
      return {
        toString,
        with: ({ query }: { query?: string } = {}) => ({
          toString: () => (query ? `${toString()}?${query}` : toString()),
        }),
      };
    }),
    cspSource: 'https://csp.source',
  };
}

describe('WebViewContent', () => {
  const fakeExtensionUri = { fsPath: '/ext' } as never;

  beforeEach(() => {
    envMock.language = 'en';
    envMock.remoteName = undefined;
  });

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

  it('limits connect-src to the loopback in a local window', () => {
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    expect(html).toContain('connect-src http://127.0.0.1:* ws://127.0.0.1:*;');
  });

  it('grants the tunnelled localhost origins in a remote window', () => {
    envMock.remoteName = 'ssh-remote';
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    // The loopback pair stays alongside the tunnelled one: the extension host
    // is still co-located with the daemon.
    expect(html).toContain(
      'connect-src http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* http://[::1]:* ws://[::1]:*;',
    );
  });

  it('grants the IPv6 loopback origins the token guard already accepts', () => {
    envMock.remoteName = 'ssh-remote';
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    // `resolveWebviewDaemonBaseUrl()` gates the forwarded URL on
    // `isLoopbackHostname()`, which accepts the IPv6 loopback forms, and the
    // daemon's Host allowlist carries `[::1]:<port>`. A forwarded URL on
    // `[::1]` therefore clears the guard and carries the bearer token, so the
    // CSP has to grant that origin too — otherwise the shell is blocked after
    // the token guard already said yes.
    for (const hostname of ['::1', '[::1]']) {
      expect(isLoopbackHostname(hostname)).toBe(true);
    }

    const connectSrc = /connect-src ([^;]*);/.exec(html)?.[1] ?? '';
    for (const scheme of ['http', 'ws']) {
      expect(connectSrc).toContain(`${scheme}://[::1]:*`);
    }
  });

  it('keeps non-loopback origins out of the remote connect-src', () => {
    envMock.remoteName = 'ssh-remote';
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    const connectSrc = /connect-src ([^;]*);/.exec(html)?.[1] ?? '';
    // A browser-based remote resolves `asExternalUri` to a relay origin, which
    // the guard rejects. This CSP is the layer that still keeps the bearer
    // token off a third-party host if that guard is ever bypassed, so granting
    // the IPv6 loopback must not grant anything else.
    for (const host of ['relay.vscode.dev', 'example.com']) {
      expect(connectSrc).not.toContain(host);
    }
    expect(connectSrc).not.toContain('://*');
  });

  it('fills the VS Code webview without inherited body padding', () => {
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    expect(html).toContain('html, body, #root {');
    expect(html).toContain('height: 100%;');
    expect(html).toContain('margin: 0;');
    expect(html).toContain('padding: 0;');
    expect(html).toContain('box-sizing: border-box;');
    expect(html).toContain('#root {\n      display: flex;');
  });

  it('does not set data-web-shell-transcript on the body', () => {
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    expect(html).not.toContain('data-web-shell-transcript');
  });

  it('injects the VS Code locale into the html lang attribute', () => {
    envMock.language = 'zh-cn';
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    expect(html).toContain('<html lang="zh-cn">');
  });

  it('falls back to en when the VS Code locale is empty', () => {
    envMock.language = '';
    const webview = createMockWebview();
    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    expect(html).toContain('<html lang="en">');
  });
});
