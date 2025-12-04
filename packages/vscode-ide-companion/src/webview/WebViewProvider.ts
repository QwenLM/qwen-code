/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { QwenAgentManager } from '../agents/qwenAgentManager.js';
import { ConversationStore } from '../storage/conversationStore.js';
import type { AcpPermissionRequest } from '../constants/acpTypes.js';
import { CliDetector } from '../cli/cliDetector.js';
import { AuthStateManager } from '../auth/authStateManager.js';
import { PanelManager } from '../webview/PanelManager.js';
import { MessageHandler } from '../webview/MessageHandler.js';
import { WebViewContent } from '../webview/WebViewContent.js';
import { CliInstaller } from '../cli/cliInstaller.js';
import { getFileName } from './utils/webviewUtils.js';

export class WebViewProvider {
  private panelManager: PanelManager;
  private messageHandler: MessageHandler;
  private agentManager: QwenAgentManager;
  private conversationStore: ConversationStore;
  private authStateManager: AuthStateManager;
  private disposables: vscode.Disposable[] = [];
  private agentInitialized = false; // Track if agent has been initialized

  constructor(
    context: vscode.ExtensionContext,
    private extensionUri: vscode.Uri,
  ) {
    this.agentManager = new QwenAgentManager();
    this.conversationStore = new ConversationStore(context);
    this.authStateManager = new AuthStateManager(context);
    this.panelManager = new PanelManager(extensionUri, () => {
      // Panel dispose callback
      this.disposables.forEach((d) => d.dispose());
    });
    this.messageHandler = new MessageHandler(
      this.agentManager,
      this.conversationStore,
      null,
      (message) => this.sendMessageToWebView(message),
    );

    // Set login handler for /login command - direct force re-login
    this.messageHandler.setLoginHandler(async () => {
      await this.forceReLogin();
    });

    // Setup agent callbacks
    this.agentManager.onStreamChunk((chunk: string) => {
      // Ignore stream chunks from background /chat save commands
      if (this.messageHandler.getIsSavingCheckpoint()) {
        console.log(
          '[WebViewProvider] Ignoring stream chunk from /chat save command',
        );
        return;
      }

      this.messageHandler.appendStreamContent(chunk);
      this.sendMessageToWebView({
        type: 'streamChunk',
        data: { chunk },
      });
    });

    // Setup thought chunk handler
    this.agentManager.onThoughtChunk((chunk: string) => {
      // Ignore thought chunks from background /chat save commands
      if (this.messageHandler.getIsSavingCheckpoint()) {
        console.log(
          '[WebViewProvider] Ignoring thought chunk from /chat save command',
        );
        return;
      }

      this.messageHandler.appendStreamContent(chunk);
      this.sendMessageToWebView({
        type: 'thoughtChunk',
        data: { chunk },
      });
    });

    // Setup end-turn handler from ACP stopReason=end_turn
    this.agentManager.onEndTurn(() => {
      // Ensure WebView exits streaming state even if no explicit streamEnd was emitted elsewhere
      this.sendMessageToWebView({
        type: 'streamEnd',
        data: { timestamp: Date.now(), reason: 'end_turn' },
      });
    });

    // Note: Tool call updates are handled in handleSessionUpdate within QwenAgentManager
    // and sent via onStreamChunk callback
    this.agentManager.onToolCall((update) => {
      // Ignore tool calls from background /chat save commands
      if (this.messageHandler.getIsSavingCheckpoint()) {
        console.log(
          '[WebViewProvider] Ignoring tool call from /chat save command',
        );
        return;
      }

      // Cast update to access sessionUpdate property
      const updateData = update as unknown as Record<string, unknown>;

      // Determine message type from sessionUpdate field
      // If sessionUpdate is missing, infer from content:
      // - If has kind/title/rawInput, it's likely initial tool_call
      // - If only has status/content updates, it's tool_call_update
      let messageType = updateData.sessionUpdate as string | undefined;
      if (!messageType) {
        // Infer type: if has kind or title, assume initial call; otherwise update
        if (updateData.kind || updateData.title || updateData.rawInput) {
          messageType = 'tool_call';
        } else {
          messageType = 'tool_call_update';
        }
      }

      this.sendMessageToWebView({
        type: 'toolCall',
        data: {
          type: messageType,
          ...updateData,
        },
      });
    });

    // Setup plan handler
    this.agentManager.onPlan((entries) => {
      this.sendMessageToWebView({
        type: 'plan',
        data: { entries },
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
          // Store handler in message handler
          this.messageHandler.setPermissionHandler(handler);
        });
      },
    );
  }

  async show(): Promise<void> {
    const panel = this.panelManager.getPanel();

    if (panel) {
      // Reveal the existing panel
      this.panelManager.revealPanel(true);
      this.panelManager.captureTab();
      return;
    }

    // Create new panel
    const isNewPanel = await this.panelManager.createPanel();

    if (!isNewPanel) {
      return; // Failed to create panel
    }

    const newPanel = this.panelManager.getPanel();
    if (!newPanel) {
      return;
    }

    // Set up state serialization
    newPanel.onDidChangeViewState(() => {
      console.log(
        '[WebViewProvider] Panel view state changed, triggering serialization check',
      );
    });

    // Capture the Tab that corresponds to our WebviewPanel
    this.panelManager.captureTab();

    // Auto-lock editor group when opened in new column
    await this.panelManager.autoLockEditorGroup();

    newPanel.webview.html = WebViewContent.generate(
      newPanel,
      this.extensionUri,
    );

    // Handle messages from WebView
    newPanel.webview.onDidReceiveMessage(
      async (message: { type: string; data?: unknown }) => {
        // Allow webview to request updating the VS Code tab title
        if (message.type === 'updatePanelTitle') {
          const title = String(
            (message.data as { title?: unknown } | undefined)?.title ?? '',
          ).trim();
          const panelRef = this.panelManager.getPanel();
          if (panelRef) {
            panelRef.title = title || 'Qwen Code';
          }
          return;
        }
        await this.messageHandler.route(message);
      },
      null,
      this.disposables,
    );

    // Listen for view state changes (no pin/lock; just keep tab reference fresh)
    this.panelManager.registerViewStateChangeHandler(this.disposables);

    // Register panel dispose handler
    this.panelManager.registerDisposeHandler(this.disposables);

    // Track last known editor state (to preserve when switching to webview)
    let _lastEditorState: {
      fileName: string | null;
      filePath: string | null;
      selection: {
        startLine: number;
        endLine: number;
      } | null;
    } | null = null;

    // Listen for active editor changes and notify WebView
    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        // If switching to a non-text editor (like webview), keep the last state
        if (!editor) {
          // Don't update - keep previous state
          return;
        }

        const filePath = editor.document.uri.fsPath || null;
        const fileName = filePath ? getFileName(filePath) : null;

        // Get selection info if there is any selected text
        let selectionInfo = null;
        if (editor && !editor.selection.isEmpty) {
          const selection = editor.selection;
          selectionInfo = {
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
          };
        }

        // Update last known state
        _lastEditorState = { fileName, filePath, selection: selectionInfo };

        this.sendMessageToWebView({
          type: 'activeEditorChanged',
          data: { fileName, filePath, selection: selectionInfo },
        });
      },
    );
    this.disposables.push(editorChangeDisposable);

    // Listen for text selection changes
    const selectionChangeDisposable =
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const editor = event.textEditor;
        if (editor === vscode.window.activeTextEditor) {
          const filePath = editor.document.uri.fsPath || null;
          const fileName = filePath ? getFileName(filePath) : null;

          // Get selection info if there is any selected text
          let selectionInfo = null;
          if (!event.selections[0].isEmpty) {
            const selection = event.selections[0];
            selectionInfo = {
              startLine: selection.start.line + 1,
              endLine: selection.end.line + 1,
            };
          }

          // Update last known state
          _lastEditorState = { fileName, filePath, selection: selectionInfo };

          this.sendMessageToWebView({
            type: 'activeEditorChanged',
            data: { fileName, filePath, selection: selectionInfo },
          });
        }
      });
    this.disposables.push(selectionChangeDisposable);

    // Send initial active editor state to WebView
    const initialEditor = vscode.window.activeTextEditor;
    if (initialEditor) {
      const filePath = initialEditor.document.uri.fsPath || null;
      const fileName = filePath ? getFileName(filePath) : null;

      let selectionInfo = null;
      if (!initialEditor.selection.isEmpty) {
        const selection = initialEditor.selection;
        selectionInfo = {
          startLine: selection.start.line + 1,
          endLine: selection.end.line + 1,
        };
      }

      this.sendMessageToWebView({
        type: 'activeEditorChanged',
        data: { fileName, filePath, selection: selectionInfo },
      });
    }

    // Attempt to restore authentication state and initialize connection
    console.log(
      '[WebViewProvider] Attempting to restore auth state and connection...',
    );
    await this.attemptAuthStateRestoration();
  }

  /**
   * Attempt to restore authentication state and initialize connection
   * This is called when the webview is first shown
   */
  private async attemptAuthStateRestoration(): Promise<void> {
    try {
      if (this.authStateManager) {
        // Debug current auth state
        await this.authStateManager.debugAuthState();

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
        const config = vscode.workspace.getConfiguration('qwenCode');
        const openaiApiKey = config.get<string>('qwen.openaiApiKey', '');
        const authMethod = openaiApiKey ? 'openai' : 'qwen-oauth';

        const hasValidAuth = await this.authStateManager.hasValidAuth(
          workingDir,
          authMethod,
        );
        console.log('[WebViewProvider] Has valid cached auth:', hasValidAuth);

        if (hasValidAuth) {
          console.log(
            '[WebViewProvider] Valid auth found, attempting connection...',
          );
          // Try to connect with cached auth
          await this.initializeAgentConnection();
        } else {
          console.log(
            '[WebViewProvider] No valid auth found, rendering empty conversation',
          );
          // Render the chat UI immediately without connecting
          await this.initializeEmptyConversation();
        }
      } else {
        console.log(
          '[WebViewProvider] No auth state manager, rendering empty conversation',
        );
        await this.initializeEmptyConversation();
      }
    } catch (error) {
      console.error('[WebViewProvider] Auth state restoration failed:', error);
      // Fallback to rendering empty conversation
      await this.initializeEmptyConversation();
    }
  }

  /**
   * Initialize agent connection and session
   * Can be called from show() or via /login command
   */
  async initializeAgentConnection(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

    console.log(
      '[WebViewProvider] Starting initialization, workingDir:',
      workingDir,
    );
    console.log(
      '[WebViewProvider] AuthStateManager available:',
      !!this.authStateManager,
    );

    const config = vscode.workspace.getConfiguration('qwenCode');
    const qwenEnabled = config.get<boolean>('qwen.enabled', true);

    if (qwenEnabled) {
      // Check if CLI is installed before attempting to connect
      const cliDetection = await CliDetector.detectQwenCli();

      if (!cliDetection.isInstalled) {
        console.log(
          '[WebViewProvider] Qwen CLI not detected, skipping agent connection',
        );
        console.log(
          '[WebViewProvider] CLI detection error:',
          cliDetection.error,
        );

        // Show VSCode notification with installation option
        await CliInstaller.promptInstallation();

        // Initialize empty conversation (can still browse history)
        await this.initializeEmptyConversation();
      } else {
        console.log(
          '[WebViewProvider] Qwen CLI detected, attempting connection...',
        );
        console.log('[WebViewProvider] CLI path:', cliDetection.cliPath);
        console.log('[WebViewProvider] CLI version:', cliDetection.version);

        try {
          console.log('[WebViewProvider] Connecting to agent...');
          console.log(
            '[WebViewProvider] Using authStateManager:',
            !!this.authStateManager,
          );
          const authInfo = await this.authStateManager.getAuthInfo();
          console.log('[WebViewProvider] Auth cache status:', authInfo);

          // Pass the detected CLI path to ensure we use the correct installation
          await this.agentManager.connect(
            workingDir,
            this.authStateManager,
            cliDetection.cliPath,
          );
          console.log('[WebViewProvider] Agent connected successfully');
          this.agentInitialized = true;

          // Load messages from the current Qwen session
          await this.loadCurrentSessionMessages();

          // Notify webview that agent is connected
          this.sendMessageToWebView({
            type: 'agentConnected',
            data: {},
          });
        } catch (error) {
          console.error('[WebViewProvider] Agent connection error:', error);
          // Clear auth cache on error (might be auth issue)
          await this.authStateManager.clearAuthState();
          vscode.window.showWarningMessage(
            `Failed to connect to Qwen CLI: ${error}\nYou can still use the chat UI, but messages won't be sent to AI.`,
          );
          // Fallback to empty conversation
          await this.initializeEmptyConversation();

          // Notify webview that agent connection failed
          this.sendMessageToWebView({
            type: 'agentConnectionError',
            data: {
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    } else {
      console.log('[WebViewProvider] Qwen agent is disabled in settings');
      // Fallback to ConversationStore
      await this.initializeEmptyConversation();
    }
  }

  /**
   * Force re-login by clearing auth cache and reconnecting
   * Called when user explicitly uses /login command
   */
  async forceReLogin(): Promise<void> {
    console.log('[WebViewProvider] Force re-login requested');
    console.log(
      '[WebViewProvider] Current authStateManager:',
      !!this.authStateManager,
    );

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Logging in to Qwen Code... ',
        cancellable: false,
      },
      async (progress) => {
        try {
          progress.report({ message: 'Preparing sign-in...' });

          // Clear existing auth cache
          if (this.authStateManager) {
            await this.authStateManager.clearAuthState();
            console.log('[WebViewProvider] Auth cache cleared');
          } else {
            console.log('[WebViewProvider] No authStateManager to clear');
          }

          // Disconnect existing connection if any
          if (this.agentInitialized) {
            try {
              this.agentManager.disconnect();
              console.log('[WebViewProvider] Existing connection disconnected');
            } catch (error) {
              console.log('[WebViewProvider] Error disconnecting:', error);
            }
            this.agentInitialized = false;
          }

          // Wait a moment for cleanup to complete
          await new Promise((resolve) => setTimeout(resolve, 300));

          progress.report({
            message: 'Connecting to CLI and starting sign-in...',
          });

          // Reinitialize connection (will trigger fresh authentication)
          await this.initializeAgentConnection();
          console.log(
            '[WebViewProvider] Force re-login completed successfully',
          );

          // Send success notification to WebView
          this.sendMessageToWebView({
            type: 'loginSuccess',
            data: { message: 'Successfully logged in!' },
          });
        } catch (error) {
          console.error('[WebViewProvider] Force re-login failed:', error);
          console.error(
            '[WebViewProvider] Error stack:',
            error instanceof Error ? error.stack : 'N/A',
          );

          // Send error notification to WebView
          this.sendMessageToWebView({
            type: 'loginError',
            data: {
              message: `Login failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          });

          throw error;
        }
      },
    );
  }

  /**
   * Refresh connection without clearing auth cache
   * Called when restoring WebView after VSCode restart
   */
  async refreshConnection(): Promise<void> {
    console.log('[WebViewProvider] Refresh connection requested');

    // Disconnect existing connection if any
    if (this.agentInitialized) {
      try {
        this.agentManager.disconnect();
        console.log('[WebViewProvider] Existing connection disconnected');
      } catch (error) {
        console.log('[WebViewProvider] Error disconnecting:', error);
      }
      this.agentInitialized = false;
    }

    // Wait a moment for cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Reinitialize connection (will use cached auth if available)
    try {
      await this.initializeAgentConnection();
      console.log(
        '[WebViewProvider] Connection refresh completed successfully',
      );

      // Notify webview that agent is connected after refresh
      this.sendMessageToWebView({
        type: 'agentConnected',
        data: {},
      });
    } catch (error) {
      console.error('[WebViewProvider] Connection refresh failed:', error);

      // Notify webview that agent connection failed after refresh
      this.sendMessageToWebView({
        type: 'agentConnectionError',
        data: {
          message: error instanceof Error ? error.message : String(error),
        },
      });

      throw error;
    }
  }

  /**
   * Load messages from current Qwen session
   * Attempts to restore an existing session before creating a new one
   */
  private async loadCurrentSessionMessages(): Promise<void> {
    try {
      console.log(
        '[WebViewProvider] Initializing with session restoration attempt',
      );

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      // First, try to restore an existing session if we have cached auth
      if (this.authStateManager) {
        const config = vscode.workspace.getConfiguration('qwenCode');
        const openaiApiKey = config.get<string>('qwen.openaiApiKey', '');
        const authMethod = openaiApiKey ? 'openai' : 'qwen-oauth';

        const hasValidAuth = await this.authStateManager.hasValidAuth(
          workingDir,
          authMethod,
        );
        if (hasValidAuth) {
          console.log(
            '[WebViewProvider] Found valid cached auth, attempting session restoration',
          );

          try {
            // Try to create a session (this will use cached auth)
            const sessionId = await this.agentManager.createNewSession(
              workingDir,
              this.authStateManager,
            );

            if (sessionId) {
              console.log(
                '[WebViewProvider] ACP session restored successfully with ID:',
                sessionId,
              );
            } else {
              console.log(
                '[WebViewProvider] ACP session restoration returned no session ID',
              );
            }
          } catch (restoreError) {
            console.warn(
              '[WebViewProvider] Failed to restore ACP session:',
              restoreError,
            );
            // Clear invalid auth cache
            await this.authStateManager.clearAuthState();

            // Fall back to creating a new session
            try {
              await this.agentManager.createNewSession(
                workingDir,
                this.authStateManager,
              );
              console.log(
                '[WebViewProvider] ACP session created successfully after restore failure',
              );
            } catch (sessionError) {
              console.error(
                '[WebViewProvider] Failed to create ACP session:',
                sessionError,
              );
              vscode.window.showWarningMessage(
                `Failed to create ACP session: ${sessionError}. You may need to authenticate first.`,
              );
            }
          }
        } else {
          console.log(
            '[WebViewProvider] No valid cached auth found, creating new session',
          );
          // No valid auth, create a new session (will trigger auth if needed)
          try {
            await this.agentManager.createNewSession(
              workingDir,
              this.authStateManager,
            );
            console.log('[WebViewProvider] ACP session created successfully');
          } catch (sessionError) {
            console.error(
              '[WebViewProvider] Failed to create ACP session:',
              sessionError,
            );
            vscode.window.showWarningMessage(
              `Failed to create ACP session: ${sessionError}. You may need to authenticate first.`,
            );
          }
        }
      } else {
        // No auth state manager, create a new session
        console.log(
          '[WebViewProvider] No auth state manager, creating new session',
        );
        try {
          await this.agentManager.createNewSession(
            workingDir,
            this.authStateManager,
          );
          console.log('[WebViewProvider] ACP session created successfully');
        } catch (sessionError) {
          console.error(
            '[WebViewProvider] Failed to create ACP session:',
            sessionError,
          );
          vscode.window.showWarningMessage(
            `Failed to create ACP session: ${sessionError}. You may need to authenticate first.`,
          );
        }
      }

      await this.initializeEmptyConversation();
    } catch (error) {
      console.error(
        '[WebViewProvider] Failed to load session messages:',
        error,
      );
      vscode.window.showErrorMessage(
        `Failed to load session messages: ${error}`,
      );
      await this.initializeEmptyConversation();
    }
  }

  /**
   * Initialize an empty conversation
   * Creates a new conversation and notifies WebView
   */
  private async initializeEmptyConversation(): Promise<void> {
    try {
      console.log('[WebViewProvider] Initializing empty conversation');
      const newConv = await this.conversationStore.createConversation();
      this.messageHandler.setCurrentConversationId(newConv.id);
      this.sendMessageToWebView({
        type: 'conversationLoaded',
        data: newConv,
      });
      console.log(
        '[WebViewProvider] Empty conversation initialized:',
        this.messageHandler.getCurrentConversationId(),
      );
    } catch (error) {
      console.error(
        '[WebViewProvider] Failed to initialize conversation:',
        error,
      );
      // Send empty state to WebView as fallback
      this.sendMessageToWebView({
        type: 'conversationLoaded',
        data: { id: 'temp', messages: [] },
      });
    }
  }

  /**
   * Send message to WebView
   */
  private sendMessageToWebView(message: unknown): void {
    const panel = this.panelManager.getPanel();
    panel?.webview.postMessage(message);
  }

  /**
   * Reset agent initialization state
   * Call this when auth cache is cleared to force re-authentication
   */
  resetAgentState(): void {
    console.log('[WebViewProvider] Resetting agent state');
    this.agentInitialized = false;
    // Disconnect existing connection
    this.agentManager.disconnect();
  }

  /**
   * Clear authentication cache for this WebViewProvider instance
   */
  async clearAuthCache(): Promise<void> {
    console.log('[WebViewProvider] Clearing auth cache for this instance');
    if (this.authStateManager) {
      await this.authStateManager.clearAuthState();
      this.resetAgentState();
    }
  }

  /**
   * Restore an existing WebView panel (called during VSCode restart)
   * This sets up the panel with all event listeners
   */
  async restorePanel(panel: vscode.WebviewPanel): Promise<void> {
    console.log('[WebViewProvider] Restoring WebView panel');
    console.log(
      '[WebViewProvider] Current authStateManager in restore:',
      !!this.authStateManager,
    );
    this.panelManager.setPanel(panel);

    // Ensure restored tab title starts from default label
    try {
      panel.title = 'Qwen Code';
    } catch (e) {
      console.warn(
        '[WebViewProvider] Failed to reset restored panel title:',
        e,
      );
    }

    panel.webview.html = WebViewContent.generate(panel, this.extensionUri);

    // Handle messages from WebView (restored panel)
    panel.webview.onDidReceiveMessage(
      async (message: { type: string; data?: unknown }) => {
        if (message.type === 'updatePanelTitle') {
          const title = String(
            (message.data as { title?: unknown } | undefined)?.title ?? '',
          ).trim();
          const panelRef = this.panelManager.getPanel();
          if (panelRef) {
            panelRef.title = title || 'Qwen Code';
          }
          return;
        }
        await this.messageHandler.route(message);
      },
      null,
      this.disposables,
    );

    // Register view state change handler
    this.panelManager.registerViewStateChangeHandler(this.disposables);

    // Register dispose handler
    this.panelManager.registerDisposeHandler(this.disposables);

    // Track last known editor state (to preserve when switching to webview)
    let _lastEditorState: {
      fileName: string | null;
      filePath: string | null;
      selection: {
        startLine: number;
        endLine: number;
      } | null;
    } | null = null;

    // Listen for active editor changes and notify WebView
    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        // If switching to a non-text editor (like webview), keep the last state
        if (!editor) {
          // Don't update - keep previous state
          return;
        }

        const filePath = editor.document.uri.fsPath || null;
        const fileName = filePath ? getFileName(filePath) : null;

        // Get selection info if there is any selected text
        let selectionInfo = null;
        if (editor && !editor.selection.isEmpty) {
          const selection = editor.selection;
          selectionInfo = {
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
          };
        }

        // Update last known state
        _lastEditorState = { fileName, filePath, selection: selectionInfo };

        this.sendMessageToWebView({
          type: 'activeEditorChanged',
          data: { fileName, filePath, selection: selectionInfo },
        });
      },
    );
    this.disposables.push(editorChangeDisposable);

    // Send initial active editor state to WebView
    const initialEditor = vscode.window.activeTextEditor;
    if (initialEditor) {
      const filePath = initialEditor.document.uri.fsPath || null;
      const fileName = filePath ? getFileName(filePath) : null;

      let selectionInfo = null;
      if (!initialEditor.selection.isEmpty) {
        const selection = initialEditor.selection;
        selectionInfo = {
          startLine: selection.start.line + 1,
          endLine: selection.end.line + 1,
        };
      }

      this.sendMessageToWebView({
        type: 'activeEditorChanged',
        data: { fileName, filePath, selection: selectionInfo },
      });
    }

    // Capture the tab reference on restore
    this.panelManager.captureTab();

    console.log('[WebViewProvider] Panel restored successfully');

    // Attempt to restore authentication state and initialize connection
    console.log(
      '[WebViewProvider] Attempting to restore auth state and connection after restore...',
    );
    await this.attemptAuthStateRestoration();
  }

  /**
   * Get the current state for serialization
   * This is used when VSCode restarts to restore the WebView
   */
  getState(): {
    conversationId: string | null;
    agentInitialized: boolean;
  } {
    console.log('[WebViewProvider] Getting state for serialization');
    console.log(
      '[WebViewProvider] Current conversationId:',
      this.messageHandler.getCurrentConversationId(),
    );
    console.log(
      '[WebViewProvider] Current agentInitialized:',
      this.agentInitialized,
    );
    const state = {
      conversationId: this.messageHandler.getCurrentConversationId(),
      agentInitialized: this.agentInitialized,
    };
    console.log('[WebViewProvider] Returning state:', state);
    return state;
  }

  /**
   * Get the current panel
   */
  getPanel(): vscode.WebviewPanel | null {
    return this.panelManager.getPanel();
  }

  /**
   * Restore state after VSCode restart
   */
  restoreState(state: {
    conversationId: string | null;
    agentInitialized: boolean;
  }): void {
    console.log('[WebViewProvider] Restoring state:', state);
    this.messageHandler.setCurrentConversationId(state.conversationId);
    this.agentInitialized = state.agentInitialized;
    console.log(
      '[WebViewProvider] State restored. agentInitialized:',
      this.agentInitialized,
    );

    // Reload content after restore
    const panel = this.panelManager.getPanel();
    if (panel) {
      panel.webview.html = WebViewContent.generate(panel, this.extensionUri);
    }
  }

  /**
   * Create a new session in the current panel
   * This is called when the user clicks the "New Session" button
   */
  async createNewSession(): Promise<void> {
    console.log('[WebViewProvider] Creating new session in current panel');
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      // Create new Qwen session via agent manager
      await this.agentManager.createNewSession(
        workingDir,
        this.authStateManager,
      );

      // Clear current conversation UI
      this.sendMessageToWebView({
        type: 'conversationCleared',
        data: {},
      });

      console.log('[WebViewProvider] New session created successfully');
    } catch (error) {
      console.error('[WebViewProvider] Failed to create new session:', error);
      vscode.window.showErrorMessage(`Failed to create new session: ${error}`);
    }
  }

  /**
   * Dispose the WebView provider and clean up resources
   */
  dispose(): void {
    this.panelManager.dispose();
    this.agentManager.disconnect();
    this.disposables.forEach((d) => d.dispose());
  }
}
