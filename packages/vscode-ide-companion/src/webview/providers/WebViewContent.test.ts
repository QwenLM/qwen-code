/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebViewContent } from './WebViewContent.js';

const { getWebShellTranscriptFlag, setWebShellTranscriptFlag } = vi.hoisted(
  () => {
    let enabled = false;
    return {
      getWebShellTranscriptFlag: () => enabled,
      setWebShellTranscriptFlag: (value: boolean) => {
        enabled = value;
      },
    };
  },
);

vi.mock('vscode', () => ({
  Uri: {
    joinPath: vi.fn((_base: unknown, ...parts: string[]) => ({
      fsPath: `/ext/${parts.join('/')}`,
    })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (key: string, fallback: unknown) =>
        key === 'experimental.webShellTranscript'
          ? getWebShellTranscriptFlag()
          : fallback,
    })),
  },
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
  beforeEach(() => {
    setWebShellTranscriptFlag(false);
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
  it('omits data-web-shell-transcript when the flag is off', () => {
    setWebShellTranscriptFlag(false);
    const webview = createMockWebview();

    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    expect(html).not.toContain('data-web-shell-transcript');
  });

  it('sets data-web-shell-transcript="true" when the flag is on', () => {
    setWebShellTranscriptFlag(true);
    const webview = createMockWebview();

    const html = WebViewContent.generate(webview as never, fakeExtensionUri);

    expect(html).toContain('data-web-shell-transcript="true"');
  });
});
