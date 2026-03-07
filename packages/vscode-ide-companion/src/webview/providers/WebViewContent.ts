/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { escapeHtml } from '../utils/webviewUtils.js';

/**
 * WebView HTML Content Generator
 * Responsible for generating the HTML content of the WebView
 */
export class WebViewContent {
  /**
   * Generate HTML content for the WebView
   * @param webview VS Code Webview (panel or view)
   * @param extensionUri Extension URI
   * @returns HTML string
   */
  static generate(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'),
    );

    // Convert extension URI for webview access - this allows frontend to construct resource paths
    const extensionUriForWebview = webview.asWebviewUri(extensionUri);

    // Escape URI for HTML to prevent potential injection attacks
    const safeExtensionUri = escapeHtml(extensionUriForWebview.toString());
    const safeScriptUri = escapeHtml(scriptUri.toString());

    return `<!DOCTYPE html>
<html lang="en">
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
