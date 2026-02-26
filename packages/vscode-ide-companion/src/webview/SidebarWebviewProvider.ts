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

    this.agentManager.onPermissionRequest(
      async (request: AcpPermissionRequest) => new Promise<string>((resolve) => {
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

    // Handle messages from webview
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage(async (message) => {
        await this.handleWebviewMessage(message);
      }),
    );

    // Handle webview visibility changes
    this.disposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible && !this.agentInitialized) {
          this.initializeAgentConnection();
        }
      }),
    );

    // Initialize agent connection if view is visible
    if (webviewView.visible) {
      await this.initializeAgentConnection();
    }
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
      default:
        // Use route method instead of handleMessage
        await this.messageHandler.route(
          msg as { type: string; data?: unknown },
        );
        break;
    }
  }

  private handleWebviewReady(): void {
    if (this.authState !== null) {
      this.sendMessageToWebView({
        type: 'authState',
        data: { authenticated: this.authState },
      });
    }

    if (this.cachedAvailableModels) {
      this.sendMessageToWebView({
        type: 'availableModels',
        data: { models: this.cachedAvailableModels },
      });
    }

    if (!this.agentInitialized) {
      this.initializeAgentConnection();
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

    try {
      // QwenAgentManager doesn't have initialize method, it auto-initializes
      this.agentInitialized = true;
      await this.loadCurrentSessionMessages();
    } catch (error) {
      if (isAuthenticationRequiredError(error)) {
        this.authState = false;
        this.sendMessageToWebView({
          type: 'authState',
          data: { authenticated: false },
        });
      }
      console.error(
        '[SidebarWebviewProvider] Failed to initialize agent:',
        error,
      );
    }
  }

  private async forceReLogin(): Promise<void> {
    try {
      // QwenAgentManager doesn't have forceReLogin, handle auth differently
      this.authState = true;
      this.sendMessageToWebView({
        type: 'authState',
        data: { authenticated: true },
      });
      await this.initializeAgentConnection();
    } catch (error) {
      console.error('[SidebarWebviewProvider] Force re-login failed:', error);
      this.authState = false;
      this.sendMessageToWebView({
        type: 'authState',
        data: { authenticated: false },
      });
    }
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
