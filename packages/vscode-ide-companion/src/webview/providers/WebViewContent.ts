/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { escapeHtml } from '../utils/webviewUtils.js';

/** Anything that exposes a `.webview` property (WebviewPanel, WebviewView, etc.) */
type WebviewHost = vscode.Webview | { webview: vscode.Webview };

/**
 * WebView HTML Content Generator
 * Responsible for generating the HTML content of the WebView
 */
export class WebViewContent {
  /**
   * Extract the underlying Webview from various host types.
   * Accepts a raw Webview, a WebviewPanel, or WebviewView — so callers
   * never have to worry about passing the wrong wrapper.
   */
  private static getWebview(host: WebviewHost): vscode.Webview {
    return 'webview' in host && host.webview instanceof Object
      ? (host as { webview: vscode.Webview }).webview
      : (host as vscode.Webview);
  }

  /**
   * Generate HTML content for the WebView
   * @param host - A Webview, WebviewPanel, or WebviewView
   * @param extensionUri Extension URI
   * @returns HTML string
   */
  static generate(host: WebviewHost, extensionUri: vscode.Uri): string {
    const webview = this.getWebview(host);
    const scriptUri = webview
      .asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'))
      .with({ query: `v=${Date.now()}` });

    // Convert extension URI for webview access - this allows frontend to construct resource paths
    const extensionUriForWebview = webview.asWebviewUri(extensionUri);

    // Escape URI for HTML to prevent potential injection attacks
    const safeExtensionUri = escapeHtml(extensionUriForWebview.toString());
    const safeScriptUri = escapeHtml(scriptUri.toString());

    // Web Shell and the chrome strings read the locale from
    // `document.documentElement.lang`; VS Code's own locale never reaches
    // the webview unless it is injected here.
    const language = escapeHtml(vscode.env.language || 'en');

    // The WebShell transcript bundles Shiki, whose Oniguruma engine compiles
    // WASM at runtime, and self-contained KaTeX fonts as data URLs, so the CSP
    // grants both wasm-unsafe-eval and data: fonts.
    const csp = `default-src 'none'; connect-src http://127.0.0.1:* ws://127.0.0.1:*; img-src ${webview.cspSource} data:; font-src data:; script-src ${webview.cspSource} 'wasm-unsafe-eval'; style-src ${webview.cspSource} 'unsafe-inline';`;

    return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Qwen Code</title>
  <style>
    html, body, #root {
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
    }
    html, body {
      margin: 0;
      padding: 0;
      overflow: hidden;
    }
    *, *::before, *::after {
      box-sizing: border-box;
    }
    body {
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-chat-font-family, var(--vscode-font-family, system-ui, sans-serif));
      font-size: var(--vscode-chat-font-size, 13px);
    }
    #root {
      display: flex;
      flex-direction: column;
    }
  </style>
</head>
<body data-extension-uri="${safeExtensionUri}">
  <div id="root"></div>
  <script type="module" src="${safeScriptUri}"></script>
</body>
</html>`;
  }
}
