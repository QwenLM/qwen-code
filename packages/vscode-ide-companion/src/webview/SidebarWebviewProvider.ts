/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { QwenAgentManager } from '../services/qwenAgentManager.js';
import { ConversationStore } from '../services/conversationStore.js';
import { MessageHandler } from './MessageHandler.js';
import type { AcpPermissionRequest } from '../types/acpTypes.js';
import type { AvailableCommand } from '../types/acpTypes.js';
import type { ModelInfo } from '../types/acpTypes.js';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';
import { isAuthenticationRequiredError } from '../utils/authErrors.js';

/**
 * WebviewView provider for displaying Qwen Code chat in the sidebar
 */
export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private agentManager: QwenAgentManager;
  private conversationStore: ConversationStore;
  private messageHandler: MessageHandler;
  private disposables: vscode.Disposable[] = [];
  private agentInitialized = false;
  private pendingPermissionRequest: AcpPermissionRequest | null = null;
  private pendingPermissionResolve: ((optionId: string) => void) | null = null;
  private currentModeId: ApprovalModeValue | null = null;
  private authState: boolean | null = null;
  private cachedAvailableModels: ModelInfo[] | null = null;
  private cachedAvailableCommands: AvailableCommand[] | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.agentManager = new QwenAgentManager();
    this.conversationStore = new ConversationStore(context);
    this.messageHandler = new MessageHandler(
      this.agentManager,
      this.conversationStore,
      null,
      (message) => this.sendMessageToWebView(message),
    );

    // Set login handler
    this.messageHandler.setLoginHandler(async () => {
      await this.forceReLogin();
    });

    // Setup agent callbacks
    this.setupAgentCallbacks();
  }

  private setupAgentCallbacks(): void {
    this.agentManager.onMessage((message) => {
      this.sendMessageToWebView({
        type: 'message',
        data: message,
      });
    });

    this.agentManager.onStreamChunk((chunk: string) => {
      this.messageHandler.appendStreamContent(chunk);
      this.sendMessageToWebView({
        type: 'streamChunk',
        data: { chunk },
      });
    });

    this.agentManager.onThoughtChunk((chunk: string) => {
      this.messageHandler.appendStreamContent(chunk);
      this.sendMessageToWebView({
        type: 'thoughtChunk',
        data: { chunk },
      });
    });

    this.agentManager.onModeInfo((info) => {
      try {
        const current = (info?.currentModeId ||
          null) as ApprovalModeValue | null;
        this.currentModeId = current;
        this.sendMessageToWebView({
          type: 'modeInfo',
          data: info,
        });
      } catch (error) {
        console.error(
          '[SidebarWebviewProvider] Error handling mode info:',
          error,
        );
      }
    });

    this.agentManager.onAvailableModels((models: ModelInfo[]) => {
      this.cachedAvailableModels = models;
      this.sendMessageToWebView({
        type: 'availableModels',
        data: { models },
      });
    });

    this.agentManager.onAvailableCommands((commands: AvailableCommand[]) => {
      this.cachedAvailableCommands = commands;
      this.sendMessageToWebView({
        type: 'availableCommands',
        data: { commands },
      });
    });

    this.agentManager.onPermissionRequest(
      async (request: AcpPermissionRequest) =>
        new Promise<string>((resolve) => {
          this.pendingPermissionRequest = request;
          this.pendingPermissionResolve = resolve;
          this.sendMessageToWebView({
            type: 'permissionRequest',
            data: request,
          });
        }),
    );
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    console.log('[SidebarWebviewProvider] resolveWebviewView called');
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    // Generate HTML for webview view (similar to panel but for view)
    const scriptUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );
    const extensionUriForWebview = webviewView.webview.asWebviewUri(
      this.extensionUri,
    );

    console.log('[SidebarWebviewProvider] Setting webview HTML');
    webviewView.webview.html = `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webviewView.webview.cspSource}; script-src ${webviewView.webview.cspSource}; style-src ${webviewView.webview.cspSource} 'unsafe-inline';">
    <title>Qwen Code</title>
  </head>
  <body data-extension-uri="${extensionUriForWebview.toString()}">
    <div id="root"></div>
    <script src="${scriptUri.toString()}"></script>
  </body>
  </html>`;

    console.log('[SidebarWebviewProvider] Setting up message handlers');
    // Handle messages from webview
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage(async (message) => {
        console.log('[SidebarWebviewProvider] Received message:', message);
        await this.handleWebviewMessage(message);
      }),
    );

    // Handle webview visibility changes
    this.disposables.push(
      webviewView.onDidChangeVisibility(() => {
        console.log(
          '[SidebarWebviewProvider] Visibility changed:',
          webviewView.visible,
        );
        if (webviewView.visible && !this.agentInitialized) {
          this.initializeAgentConnection();
        }
      }),
    );

    console.log(
      '[SidebarWebviewProvider] Webview setup complete, visible:',
      webviewView.visible,
    );
    // Don't initialize here - wait for webviewReady message
  }

  private async handleWebviewMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }

    const msg = message as { type: string; [key: string]: unknown };

    switch (msg.type) {
      case 'webviewReady':
        this.handleWebviewReady();
        break;
      case 'permissionResponse':
        this.handlePermissionResponse(msg);
        break;
      case 'newQwenSession':
        await this.handleNewSession();
        break;
      case 'openNewChatTab':
        // In sidebar, create new session instead of opening new tab
        await this.handleNewSession();
        break;
      default:
        // Use route method instead of handleMessage
        await this.messageHandler.route(
          msg as { type: string; data?: unknown },
        );
        break;
    }
  }

  private handleWebviewReady(): void {
    console.log('[SidebarWebviewProvider] Webview ready event received');
    console.log('[SidebarWebviewProvider] Auth state:', this.authState);
    console.log(
      '[SidebarWebviewProvider] Agent initialized:',
      this.agentInitialized,
    );

    if (this.authState !== null) {
      console.log('[SidebarWebviewProvider] Sending auth state to webview');
      this.sendMessageToWebView({
        type: 'authState',
        data: { authenticated: this.authState },
      });
    }

    if (this.cachedAvailableModels) {
      console.log(
        '[SidebarWebviewProvider] Sending available models to webview',
      );
      this.sendMessageToWebView({
        type: 'availableModels',
        data: { models: this.cachedAvailableModels },
      });
    }

    if (this.cachedAvailableCommands) {
      console.log(
        '[SidebarWebviewProvider] Sending available commands to webview',
      );
      this.sendMessageToWebView({
        type: 'availableCommands',
        data: { commands: this.cachedAvailableCommands },
      });
    }

    if (!this.agentInitialized) {
      console.log('[SidebarWebviewProvider] Initializing agent connection');
      this.initializeAgentConnection();
    } else {
      console.log('[SidebarWebviewProvider] Agent already initialized');
    }
  }

  private handlePermissionResponse(msg: {
    type: string;
    [key: string]: unknown;
  }): void {
    const optionId = msg.optionId as string | undefined;
    if (this.pendingPermissionResolve && optionId) {
      this.pendingPermissionResolve(optionId);
      this.pendingPermissionRequest = null;
      this.pendingPermissionResolve = null;
    }
  }

  private async initializeAgentConnection(): Promise<void> {
    if (this.agentInitialized) {
      return;
    }

    await this.doInitializeAgentConnection({ autoAuthenticate: false });
  }

  private async doInitializeAgentConnection(options?: {
    autoAuthenticate?: boolean;
  }): Promise<boolean> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      const bundledCliEntry = vscode.Uri.joinPath(
        this.extensionUri,
        'dist',
        'qwen-cli',
        'cli.js',
      ).fsPath;

      console.log('[SidebarWebviewProvider] Connecting to agent...');
      const connectResult = await this.agentManager.connect(
        workingDir,
        bundledCliEntry,
        { autoAuthenticate: options?.autoAuthenticate ?? false },
      );

      this.agentInitialized = true;

      if (connectResult.requiresAuth) {
        console.log('[SidebarWebviewProvider] Authentication required');
        this.authState = false;
        this.sendMessageToWebView({
          type: 'authState',
          data: { authenticated: false },
        });
        return false;
      }

      this.authState = true;
      this.sendMessageToWebView({
        type: 'authState',
        data: { authenticated: true },
      });

      await this.loadCurrentSessionMessages();
      return true;
    } catch (error) {
      console.error(
        '[SidebarWebviewProvider] Failed to initialize agent:',
        error,
      );
      if (isAuthenticationRequiredError(error)) {
        this.authState = false;
        this.sendMessageToWebView({
          type: 'authState',
          data: { authenticated: false },
        });
        return false;
      } else {
        // Initialize empty conversation on other errors
        await this.initializeEmptyConversation();
        return false;
      }
    }
  }

  private async initializeEmptyConversation(): Promise<void> {
    try {
      console.log('[SidebarWebviewProvider] Initializing empty conversation');
      this.sendMessageToWebView({
        type: 'loadMessages',
        data: { messages: [], conversationId: null },
      });
    } catch (error) {
      console.error(
        '[SidebarWebviewProvider] Failed to initialize empty conversation:',
        error,
      );
    }
  }

  private async forceReLogin(): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Preparing sign-in...' });

        if (this.agentInitialized) {
          try {
            this.agentManager.disconnect();
          } catch (error) {
            console.warn(
              '[SidebarWebviewProvider] Failed to disconnect before re-login:',
              error,
            );
          }
          this.agentInitialized = false;
        }

        this.authState = null;
        this.sendMessageToWebView({
          type: 'authState',
          data: { authenticated: null },
        });

        await new Promise((resolve) => setTimeout(resolve, 300));

        progress.report({
          message: 'Connecting to CLI and starting sign-in...',
        });

        const authenticated = await this.doInitializeAgentConnection({
          autoAuthenticate: true,
        });

        if (!authenticated) {
          throw new Error('Authentication was not completed.');
        }

        this.sendMessageToWebView({
          type: 'loginSuccess',
          data: { message: 'Successfully logged in!' },
        });
      },
    );
  }

  private async loadCurrentSessionMessages(): Promise<void> {
    try {
      const conversationId = this.conversationStore.getCurrentConversationId();
      if (conversationId) {
        // ConversationStore doesn't have getMessages, load differently
        this.sendMessageToWebView({
          type: 'loadMessages',
          data: { messages: [], conversationId },
        });
      }
    } catch (error) {
      console.error('[SidebarWebviewProvider] Failed to load messages:', error);
    }
  }

  private async handleNewSession(): Promise<void> {
    try {
      console.log('[SidebarWebviewProvider] Creating new session');
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      // Clear the current conversation ID first
      this.messageHandler.setCurrentConversationId(null);

      // Clear the current session in the agent manager to force creation of a new one
      this.agentManager.clearCurrentSession();

      // Create new session via agent manager
      // Now it will create a fresh session instead of reusing the existing one
      const newSessionId = await this.agentManager.createNewSession(workingDir);

      // Update message handler with new session ID
      this.messageHandler.setCurrentConversationId(newSessionId);

      // Clear current conversation UI (same as WebViewProvider)
      this.sendMessageToWebView({
        type: 'conversationCleared',
        data: {},
      });

      console.log(
        '[SidebarWebviewProvider] New session created:',
        newSessionId,
      );
    } catch (error) {
      console.error(
        '[SidebarWebviewProvider] Failed to create new session:',
        error,
      );
      // Show error to user
      this.sendMessageToWebView({
        type: 'error',
        data: { message: 'Failed to create new session' },
      });
    }
  }

  private sendMessageToWebView(message: unknown): void {
    if (this.view?.webview) {
      this.view.webview.postMessage(message);
    }
  }

  hasPendingPermission(): boolean {
    return this.pendingPermissionRequest !== null;
  }

  getCurrentModeId(): ApprovalModeValue | null {
    return this.currentModeId;
  }

  shouldSuppressDiff(): boolean {
    const mode = this.currentModeId;
    return mode === 'auto-edit' || mode === 'plan';
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    // QwenAgentManager doesn't have dispose method
  }
}
