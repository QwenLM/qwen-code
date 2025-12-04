import * as vscode from 'vscode';
import type { DiffManager } from '../diff-manager.js';
import type { WebViewProvider } from '../webview/WebViewProvider.js';

type Logger = (message: string) => void;

export function registerNewCommands(
  context: vscode.ExtensionContext,
  log: Logger,
  diffManager: DiffManager,
  getWebViewProviders: () => WebViewProvider[],
  createWebViewProvider: () => WebViewProvider,
): void {
  const disposables: vscode.Disposable[] = [];

  // qwenCode.showDiff
  disposables.push(
    vscode.commands.registerCommand(
      'qwenCode.showDiff',
      async (args: { path: string; oldText: string; newText: string }) => {
        log(`[Command] showDiff called for: ${args.path}`);
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

          await diffManager.showDiff(absolutePath, args.oldText, args.newText);
        } catch (error) {
          log(`[Command] Error showing diff: ${error}`);
          vscode.window.showErrorMessage(`Failed to show diff: ${error}`);
        }
      },
    ),
  );

  // qwenCode.openChat
  disposables.push(
    vscode.commands.registerCommand('qwenCode.openChat', () => {
      const providers = getWebViewProviders();
      if (providers.length > 0) {
        providers[providers.length - 1].show();
      } else {
        const provider = createWebViewProvider();
        provider.show();
      }
    }),
  );

  // qwenCode.openNewChatTab (not contributed in package.json; used programmatically)
  disposables.push(
    vscode.commands.registerCommand('qwenCode.openNewChatTab', () => {
      const provider = createWebViewProvider();
      provider.show();
    }),
  );

  // qwenCode.clearAuthCache
  disposables.push(
    vscode.commands.registerCommand('qwenCode.clearAuthCache', async () => {
      const providers = getWebViewProviders();
      for (const provider of providers) {
        await provider.clearAuthCache();
      }
      vscode.window.showInformationMessage(
        'Qwen Code authentication cache cleared. You will need to login again on next connection.',
      );
      log('Auth cache cleared by user');
    }),
  );

  // qwenCode.login
  disposables.push(
    vscode.commands.registerCommand('qwenCode.login', async () => {
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

  context.subscriptions.push(...disposables);
}
