/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { DiffManager } from '../diff-manager.js';
import type { WebViewProvider } from '../webview/providers/WebViewProvider.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import {
  CHAT_VIEW_ID_SIDEBAR,
  CHAT_VIEW_ID_SECONDARY,
} from '../constants/viewIds.js';

type Logger = (message: string) => void;

export const runQwenCodeCommand = 'qwen-code.runQwenCode';
export const showDiffCommand = 'qwenCode.showDiff';
export const openChatCommand = 'qwen-code.openChat';
export const openNewChatTabCommand = 'qwenCode.openNewChatTab';
export const loginCommand = 'qwen-code.login';
export const focusChatCommand = 'qwen-code.focusChat';
export const newConversationCommand = 'qwen-code.newConversation';
export const showLogsCommand = 'qwen-code.showLogs';

/**
 * Register all Qwen Code chat-related commands.
 *
 * `openChat` and `newConversation` always open an editor tab, while
 * `focusChat` focuses the secondary sidebar (preferred) or primary sidebar.
 *
 * @param context - VS Code extension context for subscription management
 * @param log - Logger function for debug output
 * @param diffManager - Diff manager for showing file diffs
 * @param getWebViewProviders - Returns all active editor-tab WebView providers
 * @param createWebViewProvider - Factory to create a new editor-tab WebView provider
 * @param outputChannel - Optional output channel for the showLogs command
 * @param supportsSecondarySidebar - Whether the running VS Code supports secondary sidebar
 */
export function registerNewCommands(
  context: vscode.ExtensionContext,
  log: Logger,
  diffManager: DiffManager,
  getWebViewProviders: () => WebViewProvider[],
  createWebViewProvider: () => WebViewProvider,
  outputChannel?: vscode.OutputChannel,
  supportsSecondarySidebar = true,
): void {
  const disposables: vscode.Disposable[] = [];

  // Open Chat: show the most recent editor tab or create a new one
  disposables.push(
    vscode.commands.registerCommand(openChatCommand, async () => {
      const providers = getWebViewProviders();
      if (providers.length > 0) {
        await providers[providers.length - 1].show();
      } else {
        const provider = createWebViewProvider();
        await provider.show();
      }
    }),
  );

  disposables.push(
    vscode.commands.registerCommand(
      showDiffCommand,
      async (args: { path: string; oldText: string; newText: string }) => {
        try {
          let absolutePath = args.path;
          if (!args.path.startsWith('/') && !args.path.match(/^[a-zA-Z]:/)) {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder) {
              absolutePath = vscode.Uri.joinPath(
                workspaceFolder.uri,
                args.path,
              ).fsPath;
            }
          }
          log(`[Command] Showing diff for ${absolutePath}`);
          await diffManager.showDiff(absolutePath, args.oldText, args.newText);
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          log(`[Command] Error showing diff: ${errorMsg}`);
          vscode.window.showErrorMessage(`Failed to show diff: ${errorMsg}`);
        }
      },
    ),
  );

  // Open New Chat Tab: always create a new editor tab
  disposables.push(
    vscode.commands.registerCommand(openNewChatTabCommand, async () => {
      const provider = createWebViewProvider();
      await provider.show();
    }),
  );

  disposables.push(
    vscode.commands.registerCommand(loginCommand, async () => {
      const providers = getWebViewProviders();
      if (providers.length > 0) {
        await providers[providers.length - 1].forceReLogin();
      } else {
        vscode.window.showInformationMessage(
          'Please open Qwen Code chat first before logging in.',
        );
      }
    }),
  );

  // Focus Chat: bring the active chat view to front.
  // Use secondary sidebar when supported; fall back to primary sidebar.
  disposables.push(
    vscode.commands.registerCommand(focusChatCommand, async () => {
      if (supportsSecondarySidebar) {
        await vscode.commands.executeCommand(`${CHAT_VIEW_ID_SECONDARY}.focus`);
      } else {
        await vscode.commands.executeCommand(`${CHAT_VIEW_ID_SIDEBAR}.focus`);
      }
    }),
  );

  // New Conversation: open a new editor tab for a fresh conversation
  disposables.push(
    vscode.commands.registerCommand(newConversationCommand, async () => {
      const provider = createWebViewProvider();
      await provider.show();
    }),
  );

  // Show Logs: reveal the output channel
  disposables.push(
    vscode.commands.registerCommand(showLogsCommand, async () => {
      if (outputChannel) {
        outputChannel.show(true);
      } else {
        vscode.window.showWarningMessage(
          'Qwen Code Companion log channel is not available.',
        );
      }
    }),
  );

  context.subscriptions.push(...disposables);
}
