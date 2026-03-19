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
   * Accepts a raw Webview, a WebviewPanel, or a WebviewView — so callers
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
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'),
    );

    // Convert extension URI for webview access - this allows frontend to construct resource paths
    const extensionUriForWebview = webview.asWebviewUri(extensionUri);

    // Escape URI for HTML to prevent potential injection attacks
    const safeExtensionUri = escapeHtml(extensionUriForWebview.toString());
    const safeScriptUri = escapeHtml(scriptUri.toString());

    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline';">
  <title>Qwen Code</title>
</head>
<body data-extension-uri="${safeExtensionUri}">
  <div id="root"></div>
  <script src="${safeScriptUri}"></script>
</body>
</html>`;
  }
}
