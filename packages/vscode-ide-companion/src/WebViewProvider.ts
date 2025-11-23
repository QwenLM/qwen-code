/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import {
  QwenAgentManager,
  type ChatMessage,
} from './agents/QwenAgentManager.js';
import { ConversationStore } from './storage/ConversationStore.js';
import type { AcpPermissionRequest } from './shared/acpTypes.js';

export class WebViewProvider {
  private panel: vscode.WebviewPanel | null = null;
  private agentManager: QwenAgentManager;
  private conversationStore: ConversationStore;
  private currentConversationId: string | null = null;
  private disposables: vscode.Disposable[] = [];
  private agentInitialized = false; // Track if agent has been initialized

  constructor(
    private context: vscode.ExtensionContext,
    private extensionUri: vscode.Uri,
  ) {
    this.agentManager = new QwenAgentManager();
    this.conversationStore = new ConversationStore(context);

    // Setup agent callbacks
    this.agentManager.onStreamChunk((chunk: string) => {
      this.sendMessageToWebView({
        type: 'streamChunk',
        data: { chunk },
      });
    });

    this.agentManager.onPermissionRequest(
      async (request: AcpPermissionRequest) => {
        // Send permission request to WebView
        this.sendMessageToWebView({
          type: 'permissionRequest',
          data: request,
        });

        // Wait for user response
        return new Promise((resolve) => {
          const handler = (message: {
            type: string;
            data: { optionId: string };
          }) => {
            if (message.type === 'permissionResponse') {
              resolve(message.data.optionId);
            }
          };
          // Store handler temporarily (in real implementation, use proper event system)
          (this as { permissionHandler?: typeof handler }).permissionHandler =
            handler;
        });
      },
    );
  }

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'qwenCode.chat',
      'Qwen Code Chat',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
      },
    );

    // Set panel icon to Qwen logo
    this.panel.iconPath = vscode.Uri.joinPath(
      this.extensionUri,
      'assets',
      'icon.png',
    );

    this.panel.webview.html = this.getWebviewContent();

    // Handle messages from WebView
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        await this.handleWebViewMessage(message);
      },
      null,
      this.disposables,
    );

    this.panel.onDidDispose(
      () => {
        this.panel = null;
        // Don't disconnect agent - keep it alive for next time
        this.disposables.forEach((d) => d.dispose());
      },
      null,
      this.disposables,
    );

    // Initialize agent connection only once
    if (!this.agentInitialized) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      console.log(
        '[WebViewProvider] Starting initialization, workingDir:',
        workingDir,
      );

      const config = vscode.workspace.getConfiguration('qwenCode');
      const qwenEnabled = config.get<boolean>('qwen.enabled', true);

      if (qwenEnabled) {
        try {
          console.log('[WebViewProvider] Connecting to agent...');
          await this.agentManager.connect(workingDir);
          console.log('[WebViewProvider] Agent connected successfully');
          this.agentInitialized = true;

          // 显示成功通知
          vscode.window.showInformationMessage(
            '✅ Qwen Code connected successfully!',
          );
        } catch (error) {
          console.error('[WebViewProvider] Agent connection error:', error);
          vscode.window.showWarningMessage(
            `Failed to connect to Qwen CLI: ${error}\nYou can still use the chat UI, but messages won't be sent to AI.`,
          );
        }
      } else {
        console.log('[WebViewProvider] Qwen agent is disabled in settings');
      }
    } else {
      console.log(
        '[WebViewProvider] Agent already initialized, reusing existing connection',
      );
    }

    // Load or create conversation (always do this, even if agent fails)
    try {
      console.log('[WebViewProvider] Loading conversations...');
      const conversations = await this.conversationStore.getAllConversations();
      console.log(
        '[WebViewProvider] Found conversations:',
        conversations.length,
      );

      if (conversations.length > 0) {
        const lastConv = conversations[conversations.length - 1];
        this.currentConversationId = lastConv.id;
        console.log(
          '[WebViewProvider] Loaded existing conversation:',
          this.currentConversationId,
        );
        this.sendMessageToWebView({
          type: 'conversationLoaded',
          data: lastConv,
        });
      } else {
        console.log('[WebViewProvider] Creating new conversation...');
        const newConv = await this.conversationStore.createConversation();
        this.currentConversationId = newConv.id;
        console.log(
          '[WebViewProvider] Created new conversation:',
          this.currentConversationId,
        );
        this.sendMessageToWebView({
          type: 'conversationLoaded',
          data: newConv,
        });
      }
      console.log('[WebViewProvider] Initialization complete');
    } catch (convError) {
      console.error(
        '[WebViewProvider] Failed to create conversation:',
        convError,
      );
      vscode.window.showErrorMessage(
        `Failed to initialize conversation: ${convError}`,
      );
    }
  }

  private async handleWebViewMessage(message: {
    type: string;
    data?: { text?: string; id?: string; sessionId?: string };
  }): Promise<void> {
    console.log('[WebViewProvider] Received message from webview:', message);
    const self = this as {
      permissionHandler?: (msg: {
        type: string;
        data: { optionId: string };
      }) => void;
    };
    switch (message.type) {
      case 'sendMessage':
        await this.handleSendMessage(message.data?.text || '');
        break;

      case 'permissionResponse':
        // Forward to permission handler
        if (self.permissionHandler) {
          self.permissionHandler(
            message as { type: string; data: { optionId: string } },
          );
          delete self.permissionHandler;
        }
        break;

      case 'loadConversation':
        await this.handleLoadConversation(message.data?.id || '');
        break;

      case 'newConversation':
        await this.handleNewConversation();
        break;

      case 'newQwenSession':
        await this.handleNewQwenSession();
        break;

      case 'deleteConversation':
        await this.handleDeleteConversation(message.data?.id || '');
        break;

      case 'getQwenSessions':
        await this.handleGetQwenSessions();
        break;

      case 'switchQwenSession':
        await this.handleSwitchQwenSession(message.data?.sessionId || '');
        break;

      default:
        console.warn('[WebViewProvider] Unknown message type:', message.type);
        break;
    }
  }

  private async handleSendMessage(text: string): Promise<void> {
    console.log('[WebViewProvider] handleSendMessage called with:', text);

    if (!this.currentConversationId) {
      console.error('[WebViewProvider] No current conversation ID');
      return;
    }

    // Save user message
    const userMessage: ChatMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    await this.conversationStore.addMessage(
      this.currentConversationId,
      userMessage,
    );
    console.log('[WebViewProvider] User message saved to store');

    // Send to WebView
    this.sendMessageToWebView({
      type: 'message',
      data: userMessage,
    });
    console.log('[WebViewProvider] User message sent to webview');

    // Check if agent is connected
    if (!this.agentManager.isConnected) {
      console.warn(
        '[WebViewProvider] Agent is not connected, skipping AI response',
      );
      this.sendMessageToWebView({
        type: 'error',
        data: {
          message:
            'Agent is not connected. Enable Qwen in settings or configure API key.',
        },
      });
      return;
    }

    // Send to agent
    try {
      // Create placeholder for assistant message
      this.sendMessageToWebView({
        type: 'streamStart',
        data: { timestamp: Date.now() },
      });
      console.log('[WebViewProvider] Stream start sent');

      console.log('[WebViewProvider] Sending to agent manager...');
      await this.agentManager.sendMessage(text);
      console.log('[WebViewProvider] Agent manager send complete');

      // Stream is complete
      this.sendMessageToWebView({
        type: 'streamEnd',
        data: { timestamp: Date.now() },
      });
      console.log('[WebViewProvider] Stream end sent');
    } catch (error) {
      console.error('[WebViewProvider] Error sending message:', error);
      vscode.window.showErrorMessage(`Error sending message: ${error}`);
      this.sendMessageToWebView({
        type: 'error',
        data: { message: String(error) },
      });
    }
  }

  private async handleLoadConversation(id: string): Promise<void> {
    const conversation = await this.conversationStore.getConversation(id);
    if (conversation) {
      this.currentConversationId = id;
      this.sendMessageToWebView({
        type: 'conversationLoaded',
        data: conversation,
      });
    }
  }

  private async handleNewConversation(): Promise<void> {
    const newConv = await this.conversationStore.createConversation();
    this.currentConversationId = newConv.id;
    this.sendMessageToWebView({
      type: 'conversationLoaded',
      data: newConv,
    });
  }

  private async handleDeleteConversation(id: string): Promise<void> {
    await this.conversationStore.deleteConversation(id);
    this.sendMessageToWebView({
      type: 'conversationDeleted',
      data: { id },
    });
  }

  private async handleGetQwenSessions(): Promise<void> {
    try {
      console.log('[WebViewProvider] Getting Qwen sessions...');
      const sessions = await this.agentManager.getSessionList();
      console.log('[WebViewProvider] Retrieved sessions:', sessions.length);

      this.sendMessageToWebView({
        type: 'qwenSessionList',
        data: { sessions },
      });
    } catch (error) {
      console.error('[WebViewProvider] Failed to get Qwen sessions:', error);
      this.sendMessageToWebView({
        type: 'error',
        data: { message: `Failed to get sessions: ${error}` },
      });
    }
  }

  private async handleNewQwenSession(): Promise<void> {
    try {
      console.log('[WebViewProvider] Creating new Qwen session...');
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      await this.agentManager.createNewSession(workingDir);

      // Clear current conversation UI
      this.sendMessageToWebView({
        type: 'conversationCleared',
        data: {},
      });

      vscode.window.showInformationMessage('✅ New Qwen session created!');
    } catch (error) {
      console.error('[WebViewProvider] Failed to create new session:', error);
      this.sendMessageToWebView({
        type: 'error',
        data: { message: `Failed to create new session: ${error}` },
      });
    }
  }

  private async handleSwitchQwenSession(sessionId: string): Promise<void> {
    try {
      console.log('[WebViewProvider] Switching to Qwen session:', sessionId);

      // Get session messages from local files
      const messages = await this.agentManager.getSessionMessages(sessionId);
      console.log(
        '[WebViewProvider] Loaded messages from session:',
        messages.length,
      );

      // Try to switch session in ACP (may fail if not supported)
      try {
        await this.agentManager.switchToSession(sessionId);
      } catch (_switchError) {
        console.log(
          '[WebViewProvider] session/switch not supported, but loaded messages anyway',
        );
      }

      // Send messages to WebView
      this.sendMessageToWebView({
        type: 'qwenSessionSwitched',
        data: { sessionId, messages },
      });

      vscode.window.showInformationMessage(
        `Loaded Qwen session with ${messages.length} messages`,
      );
    } catch (error) {
      console.error('[WebViewProvider] Failed to switch session:', error);
      this.sendMessageToWebView({
        type: 'error',
        data: { message: `Failed to switch session: ${error}` },
      });
    }
  }

  private sendMessageToWebView(message: unknown): void {
    this.panel?.webview.postMessage(message);
  }

  private getWebviewContent(): string {
    const scriptUri = this.panel!.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${this.panel!.webview.cspSource}; style-src ${this.panel!.webview.cspSource} 'unsafe-inline';">
  <title>Qwen Code Chat</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.agentManager.disconnect();
    this.disposables.forEach((d) => d.dispose());
  }
}
