/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as vscode from 'vscode';
import type { WebViewProvider } from './WebViewProvider.js';

/**
 * Factory function type that lazily creates a WebViewProvider instance.
 * The provider is only instantiated when VS Code actually opens the view.
 */
export type WebViewProviderFactory = () => WebViewProvider;

/**
 * WebviewView host for placing the chat UI in sidebar / panel / secondary sidebar.
 *
 * Accepts a factory function instead of a pre-built WebViewProvider so the
 * heavyweight provider (QwenAgentManager, ConversationStore, etc.) is only
 * created when VS Code actually opens the view, not at extension startup.
 */
export class ChatWebviewViewProvider implements vscode.WebviewViewProvider {
  private webViewProvider: WebViewProvider | null = null;

  /**
   * @param createWebViewProvider - Factory that creates a WebViewProvider on demand
   */
  constructor(private readonly createWebViewProvider: WebViewProviderFactory) {}

  /**
   * Called by VS Code when the webview view becomes visible for the first time.
   * Creates the WebViewProvider lazily and attaches the webview.
   *
   * @param webviewView - The webview view created by VS Code
   */
  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    // Lazily create the provider on first resolve
    if (!this.webViewProvider) {
      this.webViewProvider = this.createWebViewProvider();
    }

    // Webview options (enableScripts, localResourceRoots) are configured
    // inside WebViewProvider.attachToView — no duplication needed here.
    await this.webViewProvider.attachToView(webviewView, webviewView.viewType);
  }
}
