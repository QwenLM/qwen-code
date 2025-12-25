/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { IDEServer } from './ide-server.js';
import semver from 'semver';
import { DiffContentProvider, DiffManager } from './diff-manager.js';
import { createLogger } from './utils/logger.js';
import {
  detectIdeFromEnv,
  IDE_DEFINITIONS,
  type IdeInfo,
} from '@qwen-code/qwen-code-core/src/ide/detect-ide.js';
import { WebViewProvider } from './webview/WebViewProvider.js';
import { registerNewCommands } from './commands/index.js';

const CLI_IDE_COMPANION_IDENTIFIER = 'qwenlm.qwen-code-vscode-ide-companion';
const INFO_MESSAGE_SHOWN_KEY = 'qwenCodeInfoMessageShown';
export const DIFF_SCHEME = 'qwen-diff';

/**
 * IDE environments where the installation greeting is hidden.  In these
 * environments we either are pre-installed and the installation message is
 * confusing or we just want to be quiet.
 */
const HIDE_INSTALLATION_GREETING_IDES: ReadonlySet<IdeInfo['name']> = new Set([
  IDE_DEFINITIONS.firebasestudio.name,
  IDE_DEFINITIONS.cloudshell.name,
]);

let ideServer: IDEServer;
let logger: vscode.OutputChannel;
let webViewProviders: WebViewProvider[] = []; // Track multiple chat tabs

let log: (message: string) => void = () => {};

async function checkForUpdates(
  context: vscode.ExtensionContext,
  log: (message: string) => void,
) {
  try {
    const currentVersion = context.extension.packageJSON.version;

    // Fetch extension details from the VSCode Marketplace.
    const response = await fetch(
      'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json;api-version=7.1-preview.1',
        },
        body: JSON.stringify({
          filters: [
            {
              criteria: [
                {
                  filterType: 7, // Corresponds to ExtensionName
                  value: CLI_IDE_COMPANION_IDENTIFIER,
                },
              ],
            },
          ],
          // See: https://learn.microsoft.com/en-us/azure/devops/extend/gallery/apis/hyper-linking?view=azure-devops
          // 946 = IncludeVersions | IncludeFiles | IncludeCategoryAndTags |
          //       IncludeShortDescription | IncludePublisher | IncludeStatistics
          flags: 946,
        }),
      },
    );

    if (!response.ok) {
      log(
        `Failed to fetch latest version info from marketplace: ${response.statusText}`,
      );
      return;
    }

    const data = await response.json();
    const extension = data?.results?.[0]?.extensions?.[0];
    // The versions are sorted by date, so the first one is the latest.
    const latestVersion = extension?.versions?.[0]?.version;

    if (latestVersion && semver.gt(latestVersion, currentVersion)) {
      const selection = await vscode.window.showInformationMessage(
        `A new version (${latestVersion}) of the Qwen Code Companion extension is available.`,
        'Update to latest version',
      );
      if (selection === 'Update to latest version') {
        // The install command will update the extension if a newer version is found.
        await vscode.commands.executeCommand(
          'workbench.extensions.installExtension',
          CLI_IDE_COMPANION_IDENTIFIER,
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Error checking for extension updates: ${message}`);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  logger = vscode.window.createOutputChannel('Qwen Code Companion');
  log = createLogger(context, logger);
  log('Extension activated');

  checkForUpdates(context, log);

  const diffContentProvider = new DiffContentProvider();
  const diffManager = new DiffManager(
    log,
    diffContentProvider,
    // Delay when any chat tab has a pending permission drawer
    () => webViewProviders.some((p) => p.hasPendingPermission()),
    // Suppress diffs when active mode is auto or yolo in any chat tab
    () => {
      const providers = webViewProviders.filter(
        (p) => typeof p.shouldSuppressDiff === 'function',
      );
      if (providers.length === 0) {
        return false;
      }
      return providers.every((p) => p.shouldSuppressDiff());
    },
  );

  // Helper function to create a new WebView provider instance
  const createWebViewProvider = (): WebViewProvider => {
    const provider = new WebViewProvider(context, context.extensionUri);
    webViewProviders.push(provider);
    return provider;
  };

  // Register WebView panel serializer for persistence across reloads
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('qwenCode.chat', {
      async deserializeWebviewPanel(
        webviewPanel: vscode.WebviewPanel,
        state: unknown,
      ) {
        console.log(
          '[Extension] Deserializing WebView panel with state:',
          state,
        );

        // Create a new provider for the restored panel
        const provider = createWebViewProvider();
        console.log('[Extension] Provider created for deserialization');

        // Restore state if available BEFORE restoring the panel
        if (state && typeof state === 'object') {
          console.log('[Extension] Restoring state:', state);
          provider.restoreState(
            state as {
              conversationId: string | null;
              agentInitialized: boolean;
            },
          );
        } else {
          console.log('[Extension] No state to restore or invalid state');
        }

        await provider.restorePanel(webviewPanel);
        console.log('[Extension] Panel restore completed');

        log('WebView panel restored from serialization');
      },
    }),
  );

  // Register newly added commands via commands module
  registerNewCommands(
    context,
    log,
    diffManager,
    () => webViewProviders,
    createWebViewProvider,
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === DIFF_SCHEME) {
        diffManager.cancelDiff(doc.uri);
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      diffContentProvider,
    ),
    (vscode.commands.registerCommand('qwen.diff.accept', (uri?: vscode.Uri) => {
      const docUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (docUri && docUri.scheme === DIFF_SCHEME) {
        diffManager.acceptDiff(docUri);
      }
      // If WebView is requesting permission, actively select an allow option (prefer once)
      try {
        for (const provider of webViewProviders) {
          if (provider?.hasPendingPermission()) {
            provider.respondToPendingPermission('allow');
          }
        }
      } catch (err) {
        console.warn('[Extension] Auto-allow on diff.accept failed:', err);
      }
      console.log('[Extension] Diff accepted');
    }),
    vscode.commands.registerCommand('qwen.diff.cancel', (uri?: vscode.Uri) => {
      const docUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (docUri && docUri.scheme === DIFF_SCHEME) {
        diffManager.cancelDiff(docUri);
      }
      // If WebView is requesting permission, actively select reject/cancel
      try {
        for (const provider of webViewProviders) {
          if (provider?.hasPendingPermission()) {
            provider.respondToPendingPermission('cancel');
          }
        }
      } catch (err) {
        console.warn('[Extension] Auto-reject on diff.cancel failed:', err);
      }
      console.log('[Extension] Diff cancelled');
    })),
    vscode.commands.registerCommand('qwen.diff.closeAll', async () => {
      try {
        await diffManager.closeAll();
      } catch (err) {
        console.warn('[Extension] qwen.diff.closeAll failed:', err);
      }
    }),
    vscode.commands.registerCommand('qwen.diff.suppressBriefly', async () => {
      try {
        diffManager.suppressFor(1200);
      } catch (err) {
        console.warn('[Extension] qwen.diff.suppressBriefly failed:', err);
      }
    }),
  );

  ideServer = new IDEServer(log, diffManager);
  try {
    await ideServer.start(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Failed to start IDE server: ${message}`);
  }

  const infoMessageEnabled = !HIDE_INSTALLATION_GREETING_IDES.has(
    detectIdeFromEnv().name,
  );

  if (!context.globalState.get(INFO_MESSAGE_SHOWN_KEY) && infoMessageEnabled) {
    void vscode.window.showInformationMessage(
      'Qwen Code Companion extension successfully installed.',
    );
    context.globalState.update(INFO_MESSAGE_SHOWN_KEY, true);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      ideServer.syncEnvVars();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      ideServer.syncEnvVars();
    }),
    vscode.commands.registerCommand(
      'qwen-code.runQwenCode',
      async (
        location?:
          | vscode.TerminalLocation
          | vscode.TerminalEditorLocationOptions,
      ) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
          vscode.window.showInformationMessage(
            'No folder open. Please open a folder to run Qwen Code.',
          );
          return;
        }

        let selectedFolder: vscode.WorkspaceFolder | undefined;
        if (workspaceFolders.length === 1) {
          selectedFolder = workspaceFolders[0];
        } else {
          selectedFolder = await vscode.window.showWorkspaceFolderPick({
            placeHolder: 'Select a folder to run Qwen Code in',
          });
        }

        if (selectedFolder) {
          const cliEntry = vscode.Uri.joinPath(
            context.extensionUri,
            'dist',
            'qwen-cli',
            'cli.js',
          ).fsPath;
          const quote = (s: string) => `"${s.replaceAll('"', '\\"')}"`;
          const qwenCmd = `${quote(process.execPath)} ${quote(cliEntry)}`;
          const terminal = vscode.window.createTerminal({
            name: `Qwen Code (${selectedFolder.name})`,
            cwd: selectedFolder.uri.fsPath,
            location,
          });
          terminal.show();
          terminal.sendText(qwenCmd);
        }
      },
    ),
    vscode.commands.registerCommand('qwen-code.showNotices', async () => {
      const noticePath = vscode.Uri.joinPath(
        context.extensionUri,
        'NOTICES.txt',
      );
      await vscode.window.showTextDocument(noticePath);
    }),
  );
}

export async function deactivate(): Promise<void> {
  log('Extension deactivated');
  try {
    if (ideServer) {
      await ideServer.stop();
    }
    // Dispose all WebView providers
    webViewProviders.forEach((provider) => {
      provider.dispose();
    });
    webViewProviders = [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Failed to stop IDE server during deactivation: ${message}`);
  } finally {
    if (logger) {
      logger.dispose();
    }
  }
}
