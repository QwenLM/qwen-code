/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import {
  CHAT_VIEW_ID_SECONDARY,
  CHAT_VIEW_ID_SIDEBAR,
} from '../../constants/viewIds.js';
import {
  ChatWebviewViewProvider,
  type WebViewProviderFactory,
} from './ChatWebviewViewProvider.js';

const SECONDARY_SIDEBAR_CONTEXT_KEY =
  'qwen-code:doesNotSupportSecondarySidebar';

export function detectSecondarySidebarSupport(vscodeVersion: string): boolean {
  const [major, minor] = vscodeVersion.split('.').map(Number);
  return (major ?? 0) > 1 || ((major ?? 0) === 1 && (minor ?? 0) >= 106);
}

export function registerChatViewProviders(params: {
  context: vscode.ExtensionContext;
  createViewProvider: WebViewProviderFactory;
  vscodeVersion?: string;
}): boolean {
  const {
    context,
    createViewProvider,
    vscodeVersion = vscode.version,
  } = params;

  const supportsSecondarySidebar = detectSecondarySidebarSupport(vscodeVersion);

  if (!supportsSecondarySidebar) {
    void vscode.commands.executeCommand(
      'setContext',
      SECONDARY_SIDEBAR_CONTEXT_KEY,
      true,
    );
  }

  const chatViewProvider = new ChatWebviewViewProvider(createViewProvider);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CHAT_VIEW_ID_SIDEBAR,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.registerWebviewViewProvider(
      CHAT_VIEW_ID_SECONDARY,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  return supportsSecondarySidebar;
}
