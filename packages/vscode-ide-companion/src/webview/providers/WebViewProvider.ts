/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { QwenAgentManager } from '../../services/qwenAgentManager.js';
import { ConversationStore } from '../../services/conversationStore.js';
import type {
  RequestPermissionRequest,
  ModelInfo,
} from '@agentclientprotocol/sdk';
import type { AskUserQuestionRequest } from '../../types/acpTypes.js';
import type {
  PermissionResponseMessage,
  AskUserQuestionResponseMessage,
} from '../../types/webviewMessageTypes.js';
import { PanelManager, getLocalResourceRoots } from './PanelManager.js';
import { MessageHandler } from './MessageHandler.js';
import { WebViewContent } from './WebViewContent.js';
import { getFileName } from '../utils/webviewUtils.js';
import { createImagePathResolver } from '../utils/imageHandler.js';
import { type ApprovalModeValue } from '../../types/approvalModeValueTypes.js';
import { isAuthenticationRequiredError } from '../../utils/authErrors.js';
import { getErrorMessage } from '../../utils/errorMessage.js';

export class WebViewProvider {
  private panelManager: PanelManager;
  private messageHandler: MessageHandler;
  private agentManager: QwenAgentManager;
  private conversationStore: ConversationStore;
  private disposables: vscode.Disposable[] = [];
  private agentInitialized = false; // Track if agent has been initialized
  // Track a pending permission request and its resolver so extension commands
  // can "simulate" user choice from the command palette (e.g. after accepting
  // a diff, auto-allow read/execute, or auto-reject on cancel).
  private pendingPermissionRequest: RequestPermissionRequest | null = null;
  private pendingPermissionResolve: ((optionId: string) => void) | null = null;
  // Track a pending ask user question request and its resolver
  private pendingAskUserQuestionRequest: AskUserQuestionRequest | null = null;
  private pendingAskUserQuestionResolve:
    | ((result: { optionId: string; answers?: Record<string, string> }) => void)
    | null = null;
  // Track current ACP mode id to influence permission/diff behavior
  private currentModeId: ApprovalModeValue | null = null;
  private authState: boolean | null = null;
  /** Cached available models for re-sending on webview ready */
  private cachedAvailableModels: ModelInfo[] | null = null;
  /** Model to apply once a new editor-tab session is initialized */
  private initialModelId: string | null = null;
  /** Reference to a WebviewView webview (sidebar/panel/secondary) when attached via attachToView */
  private attachedWebview: vscode.Webview | null = null;
  /**
   * Whether this provider is hosted inside a WebviewView (sidebar / secondary bar).
   * When true, "New Session" resets the conversation in-place instead of opening
   * a new editor tab.
   */
  private isViewHost = false;
  /** Guards against concurrent auth-restore / connection init */
  private initializationPromise: Promise<void> | null = null;
  private isReconnecting = false;

  constructor(
    private context: vscode.ExtensionContext,
    private extensionUri: vscode.Uri,
  ) {
    this.agentManager = new QwenAgentManager();
    this.conversationStore = new ConversationStore(context);
    this.panelManager = new PanelManager(extensionUri, () => {
      // Panel dispose callback — unblock any pending ACP Promises
      if (this.pendingPermissionResolve) {
        this.pendingPermissionResolve('cancel');
        this.pendingPermissionResolve = null;
        this.pendingPermissionRequest = null;
      }
      if (this.pendingAskUserQuestionResolve) {
        this.pendingAskUserQuestionResolve({ optionId: 'cancel' });
        this.pendingAskUserQuestionResolve = null;
        this.pendingAskUserQuestionRequest = null;
      }
      // Disconnect the ACP agent process to prevent orphan processes
      this.agentManager.disconnect();
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

    // Setup file watchers for cache invalidation
    const fileWatcherDisposable = this.messageHandler.setupFileWatchers();
    this.disposables.push(fileWatcherDisposable);

    // Setup agent callbacks
    this.agentManager.onMessage((message) => {
      // Do not suppress messages during checkpoint saves.
      // Checkpoint persistence now writes directly to disk and should not
      // generate ACP session/update traffic. Suppressing here could drop
      // legitimate history replay messages (e.g., session/load) or
      // assistant replies when a new prompt starts while an async save is
      // still finishing.
      this.sendMessageToWebView({
        type: 'message',
        data: message,
      });
    });

    this.agentManager.onStreamChunk((chunk: string) => {
      // Always forward stream chunks; do not gate on checkpoint saves.
      // See note in onMessage() above.
      this.messageHandler.appendStreamContent(chunk);
      this.sendMessageToWebView({
        type: 'streamChunk',
        data: { chunk },
      });
    });

    // Setup thought chunk handler
    this.agentManager.onThoughtChunk((chunk: string) => {
      // Always forward thought chunks; do not gate on checkpoint saves.
      this.messageHandler.appendStreamContent(chunk);
      this.sendMessageToWebView({
        type: 'thoughtChunk',
        data: { chunk },
      });
    });

    // Surface available modes and current mode (from ACP initialize)
    this.agentManager.onModeInfo((info) => {
      try {
        const current = (info?.currentModeId || null) as
          | 'plan'
          | 'default'
          | 'auto-edit'
          | 'yolo'
          | null;
        this.currentModeId = current;
      } catch (_error) {
        // Ignore error when parsing mode info
      }
      this.sendMessageToWebView({
        type: 'modeInfo',
        data: info || {},
      });
    });

    // Surface mode changes (from ACP or immediate set_mode response)
    this.agentManager.onModeChanged((modeId) => {
      try {
        this.currentModeId = modeId;
      } catch (_error) {
        // Ignore error when setting mode id
      }
      this.sendMessageToWebView({
        type: 'modeChanged',
        data: { modeId },
      });
    });

    this.agentManager.onUsageUpdate((stats) => {
      this.sendMessageToWebView({
        type: 'usageStats',
        data: stats,
      });
    });

    this.agentManager.onModelInfo((info) => {
      this.sendMessageToWebView({
        type: 'modelInfo',
        data: info,
      });
    });

    // Surface model changes (primarily from set_model response path)
    this.agentManager.onModelChanged((model) => {
      this.sendMessageToWebView({
        type: 'modelChanged',
        data: { model },
      });
    });

    // Surface available commands (from ACP available_commands_update)
    this.agentManager.onAvailableCommands((commands) => {
      this.sendMessageToWebView({
        type: 'availableCommands',
        data: { commands },
      });
    });

    // Surface available models (from session/new response)
    this.agentManager.onAvailableModels((models) => {
      console.log(
        '[WebViewProvider] onAvailableModels received, sending to webview:',
        models,
      );
      // Cache models for re-sending when webview becomes ready
      this.cachedAvailableModels = models;
      this.sendMessageToWebView({
        type: 'availableModels',
        data: { models },
      });
    });

    // Setup end-turn handler from ACP stopReason notifications
    this.agentManager.onEndTurn((reason) => {
      // Ensure WebView exits streaming state even if no explicit streamEnd was emitted elsewhere
      this.sendMessageToWebView({
        type: 'streamEnd',
        data: {
          timestamp: Date.now(),
          reason: reason || 'end_turn',
        },
      });
    });

    // Note: Tool call updates are handled in handleSessionUpdate within QwenAgentManager
    // and sent via onStreamChunk callback
    this.agentManager.onToolCall((update) => {
      // Always surface tool calls; they are part of the live assistant flow.
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
      async (request: RequestPermissionRequest) => {
        // Send permission request to WebView
        this.sendMessageToWebView({
          type: 'permissionRequest',
          data: request,
        });

        // If a previous permission request is still pending, cancel it so its
        // promise settles instead of leaking (issue: handler overwrite leak).
        if (this.pendingPermissionResolve) {
          this.pendingPermissionResolve('cancel');
        }

        // Wait for user response
        return new Promise((resolve) => {
          // Cache the pending request and its resolver so extension commands
          // (e.g. diff accept/cancel) can resolve it externally.
          this.pendingPermissionRequest = request;
          this.pendingPermissionResolve = (optionId: string) => {
            // Clear pending state BEFORE resolving to prevent re-entrant calls
            this.pendingPermissionRequest = null;
            this.pendingPermissionResolve = null;
            // Resolve the ACP promise
            resolve(optionId);
            // Instruct the webview UI to close its drawer
            this.sendMessageToWebView({
              type: 'permissionResolved',
              data: { optionId },
            });
            // NOTE: Diff management (closeAll, suppressBriefly) is handled
            // exclusively in the message handler below to avoid double execution.
          };

          const handler = (message: PermissionResponseMessage) => {
            if (message.type !== 'permissionResponse') {
              return;
            }

            const optionId = message.data.optionId || '';

            // Resolve the optionId back to ACP so the agent isn't blocked
            this.pendingPermissionResolve?.(optionId);

            const isCancel =
              optionId === 'cancel' ||
              optionId.toLowerCase().includes('reject');

            // Always close open qwen-diff editors after any permission decision
            void vscode.commands.executeCommand('qwen.diff.closeAll');

            if (isCancel) {
              // Fire and forget — cancel generation and update UI
              void (async () => {
                try {
                  await this.agentManager.cancelCurrentPrompt();
                } catch (err) {
                  console.warn(
                    '[WebViewProvider] cancelCurrentPrompt error:',
                    err,
                  );
                }

                this.sendMessageToWebView({
                  type: 'streamEnd',
                  data: { timestamp: Date.now(), reason: 'user_cancelled' },
                });

                // Synthesize a failed tool_call_update to match CLI UX
                try {
                  const toolCallId =
                    (request.toolCall as { toolCallId?: string } | undefined)
                      ?.toolCallId || '';
                  const title =
                    (request.toolCall as { title?: string } | undefined)
                      ?.title || '';
                  let kind = ((
                    request.toolCall as { kind?: string } | undefined
                  )?.kind || 'execute') as string;
                  if (!kind && title) {
                    const t = title.toLowerCase();
                    if (t.includes('read') || t.includes('cat')) {
                      kind = 'read';
                    } else if (t.includes('write') || t.includes('edit')) {
                      kind = 'edit';
                    } else {
                      kind = 'execute';
                    }
                  }

                  this.sendMessageToWebView({
                    type: 'toolCall',
                    data: {
                      type: 'tool_call_update',
                      toolCallId,
                      title,
                      kind,
                      status: 'failed',
                      rawInput: (request.toolCall as { rawInput?: unknown })
                        ?.rawInput,
                      locations: (
                        request.toolCall as {
                          locations?: Array<{
                            path: string;
                            line?: number | null;
                          }>;
                        }
                      )?.locations,
                    },
                  });
                } catch (err) {
                  console.warn(
                    '[WebViewProvider] failed to synthesize failed tool_call_update:',
                    err,
                  );
                }
              })();
            } else {
              // Allowed/proceeded — suppress diff re-open briefly
              void vscode.commands.executeCommand('qwen.diff.suppressBriefly');
            }
          };
          // Store handler in message handler
          this.messageHandler.setPermissionHandler(handler);
        });
      },
    );

    this.agentManager.onAskUserQuestion(
      async (request: AskUserQuestionRequest) => {
        // Send ask user question request to WebView
        this.sendMessageToWebView({
          type: 'askUserQuestion',
          data: request,
        });

        // Wait for user response
        return new Promise<{
          optionId: string;
          answers?: Record<string, string>;
        }>((resolve) => {
          // Cache the pending request and its resolver
          this.pendingAskUserQuestionRequest = request;
          this.pendingAskUserQuestionResolve = (result) => {
            try {
              resolve(result);
            } finally {
              // Always clear pending state
              this.pendingAskUserQuestionRequest = null;
              this.pendingAskUserQuestionResolve = null;
              // Instruct the webview UI to close the dialog
              this.sendMessageToWebView({
                type: 'askUserQuestionResolved',
                data: { optionId: result.optionId },
              });
            }
          };
          const handler = (message: AskUserQuestionResponseMessage) => {
            if (message.type !== 'askUserQuestionResponse') {
              return;
            }

            const { optionId, answers, cancelled } = message.data;

            // Resolve with the result
            if (cancelled) {
              this.pendingAskUserQuestionResolve?.({
                optionId: 'cancel',
              });
            } else {
              this.pendingAskUserQuestionResolve?.({
                optionId: optionId || 'proceed_once',
                answers,
              });
            }
          };
          // Store handler in message handler
          this.messageHandler.setAskUserQuestionHandler(handler);
        });
      },
    );

    this.agentManager.onDisconnected((code, signal) => {
      console.log(
        `[WebViewProvider] Agent disconnected (code: ${code}, signal: ${signal})`,
      );
      // Only auto-reconnect for unexpected disconnects
      if (this.agentInitialized && !this.isReconnecting) {
        this.attemptAutoReconnect();
      }
    });
  }

  /**
   * Attach the provider to a WebviewView (sidebar / panel / secondary sidebar).
   * Called from ChatWebviewViewProvider.resolveWebviewView when VS Code opens
   * the view for the first time.
   *
   * @param webviewView - The WebviewView provided by VS Code
   * @param viewType - The view identifier (e.g. sidebar, panel, secondary)
   */
  async attachToView(
    webviewView: vscode.WebviewView,
    viewType: string,
  ): Promise<void> {
    console.log(
      `[WebViewProvider] Attaching to WebviewView (viewType=${viewType})`,
    );

    const webview = webviewView.webview;

    // Configure webview options
    webview.options = {
      enableScripts: true,
      localResourceRoots: getLocalResourceRoots(
        this.extensionUri,
        vscode.workspace.workspaceFolders,
      ),
    };

    // Store reference so sendMessageToWebView can reach it
    this.attachedWebview = webview;
    // Mark this provider as a view host (sidebar / secondary bar)
    this.isViewHost = true;

    // Generate HTML content
    webview.html = WebViewContent.generate(webview, this.extensionUri);

    // Handle messages from WebView
    webview.onDidReceiveMessage(
      async (message: { type: string; data?: unknown }) => {
        if (message.type === 'openDiff' && this.isAutoMode()) {
          return;
        }
        if (message.type === 'webviewReady') {
          this.handleWebviewReady();
          return;
        }
        if (message.type === 'resolveImagePaths') {
          this.handleResolveImagePaths(message.data, webview);
          return;
        }
        if (this.handleNewChatByContext(message)) {
          return;
        }
        await this.messageHandler.route(message);
      },
      null,
      this.disposables,
    );

    // Listen for active editor changes and notify WebView
    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (!editor) {
          return;
        }
        const filePath = editor.document.uri.fsPath || null;
        const fileName = filePath ? getFileName(filePath) : null;

        let selectionInfo = null;
        if (editor && !editor.selection.isEmpty) {
          const selection = editor.selection;
          selectionInfo = {
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
          };
        }

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

          let selectionInfo = null;
          if (!event.selections[0].isEmpty) {
            const selection = event.selections[0];
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
      });
    this.disposables.push(selectionChangeDisposable);

    // Send initial active editor state
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

    // Re-initialize when the view becomes visible after being hidden,
    // in case the agent was never connected (e.g. sidebar opened but collapsed).
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && !this.agentInitialized) {
        void this.attemptAuthStateRestoration();
      }
    });

    // Clean up when the view is disposed
    webviewView.onDidDispose(() => {
      this.attachedWebview = null;
      // Disconnect the ACP agent process to prevent orphan processes
      this.agentManager.disconnect();
      this.disposables.forEach((d) => d.dispose());
    });

    // Attempt to restore auth state and initialize connection
    console.log(
      '[WebViewProvider] Attempting to restore auth state and connection for view...',
    );
    await this.attemptAuthStateRestoration();
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
      newPanel.webview,
      this.extensionUri,
    );

    // Handle messages from WebView
    newPanel.webview.onDidReceiveMessage(
      async (message: { type: string; data?: unknown }) => {
        // Suppress UI-originated diff opens in auto/yolo mode
        if (message.type === 'openDiff' && this.isAutoMode()) {
          return;
        }
        if (message.type === 'webviewReady') {
          this.handleWebviewReady();
          return;
        }
        if (message.type === 'resolveImagePaths') {
          this.handleResolveImagePaths(message.data, newPanel.webview);
          return;
        }
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
        if (this.handleNewChatByContext(message)) {
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

          this.sendMessageToWebView({
            type: 'activeEditorChanged',
            data: { fileName, filePath, selection: selectionInfo },
          });

          // Mode callbacks are registered in constructor; no-op here
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

  setInitialModelId(modelId: string | null | undefined): void {
    this.initialModelId =
      typeof modelId === 'string' && modelId.trim().length > 0
        ? modelId.trim()
        : null;
  }

  /**
   * Attempt to restore authentication state and initialize connection
   * This is called when the webview is first shown
   */
  private async attemptAuthStateRestoration(): Promise<void> {
    // Prevent concurrent initialization attempts (e.g. visibility toggle + webviewReady race)
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      try {
        console.log('[WebViewProvider] Attempting connection...');
        // Attempt a connection to detect prior auth without forcing login
        await this.initializeAgentConnection({ autoAuthenticate: false });
      } catch (error) {
        console.error(
          '[WebViewProvider] Error in attemptAuthStateRestoration:',
          error,
        );
        await this.initializeEmptyConversation();
      } finally {
        this.initializationPromise = null;
      }
    })();

    return this.initializationPromise;
  }

  /**
   * Initialize agent connection and session
   * Can be called from show() or via /login command
   */
  async initializeAgentConnection(options?: {
    autoAuthenticate?: boolean;
  }): Promise<void> {
    return this.doInitializeAgentConnection(options);
  }

  /**
   * Internal: perform actual connection/initialization (no auth locking).
   */
  private async doInitializeAgentConnection(options?: {
    autoAuthenticate?: boolean;
  }): Promise<void> {
    const autoAuthenticate = options?.autoAuthenticate ?? true;
    const run = async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      console.log(
        '[WebViewProvider] Starting initialization, workingDir:',
        workingDir,
      );
      console.log(
        `[WebViewProvider] Using CLI-managed authentication (autoAuth=${autoAuthenticate})`,
      );

      const bundledCliEntry = vscode.Uri.joinPath(
        this.extensionUri,
        'dist',
        'qwen-cli',
        'cli.js',
      ).fsPath;

      try {
        console.log('[WebViewProvider] Connecting to agent...');

        // Pass the detected CLI path to ensure we use the correct installation
        const connectResult = await this.agentManager.connect(
          workingDir,
          bundledCliEntry,
          options,
        );
        console.log('[WebViewProvider] Agent connected successfully');
        this.agentInitialized = true;

        // If authentication is required and autoAuthenticate is false,
        // send authState message and return without creating session
        if (connectResult.requiresAuth && !autoAuthenticate) {
          console.log(
            '[WebViewProvider] Authentication required but auto-auth disabled, sending authState and returning',
          );
          this.sendMessageToWebView({
            type: 'authState',
            data: { authenticated: false },
          });
          // Initialize empty conversation to allow browsing history
          await this.initializeEmptyConversation();
          return;
        }

        if (connectResult.requiresAuth) {
          this.sendMessageToWebView({
            type: 'authState',
            data: { authenticated: false },
          });
        }

        // Load messages from the current Qwen session
        const sessionReady = await this.loadCurrentSessionMessages(options);

        if (sessionReady) {
          // Notify webview that agent is connected
          this.sendMessageToWebView({
            type: 'agentConnected',
            data: {},
          });
        } else {
          console.log(
            '[WebViewProvider] Session creation deferred until user logs in.',
          );
        }
      } catch (_error) {
        const errorMsg = getErrorMessage(_error);
        console.error('[WebViewProvider] Agent connection error:', _error);
        vscode.window.showWarningMessage(
          `Failed to connect to Qwen CLI: ${errorMsg}\nYou can still use the chat UI, but messages won't be sent to AI.`,
        );
        // Fallback to empty conversation
        await this.initializeEmptyConversation();

        // Notify webview that agent connection failed
        this.sendMessageToWebView({
          type: 'agentConnectionError',
          data: {
            message: errorMsg,
          },
        });
      }
    };

    return run();
  }

  /**
   * Force re-login by clearing auth cache and reconnecting
   * Called when user explicitly uses /login command
   */
  async forceReLogin(): Promise<void> {
    console.log('[WebViewProvider] Force re-login requested');

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
      },
      async (progress) => {
        try {
          progress.report({ message: 'Preparing sign-in...' });

          // Disconnect existing connection if any
          if (this.agentInitialized) {
            try {
              this.agentManager.disconnect();
              console.log('[WebViewProvider] Existing connection disconnected');
            } catch (_error) {
              console.log('[WebViewProvider] Error disconnecting:', _error);
            }
            this.agentInitialized = false;
          }

          // Wait a moment for cleanup to complete
          await new Promise((resolve) => setTimeout(resolve, 300));

          progress.report({
            message: 'Connecting to CLI and starting sign-in...',
          });

          // Reinitialize connection (will trigger fresh authentication)
          await this.doInitializeAgentConnection({ autoAuthenticate: true });
          console.log(
            '[WebViewProvider] Force re-login completed successfully',
          );

          // Send success notification to WebView
          this.sendMessageToWebView({
            type: 'loginSuccess',
            data: { message: 'Successfully logged in!' },
          });
        } catch (_error) {
          const errorMsg = getErrorMessage(_error);
          console.error('[WebViewProvider] Force re-login failed:', _error);
          console.error(
            '[WebViewProvider] Error stack:',
            _error instanceof Error ? _error.stack : 'N/A',
          );

          // Send error notification to WebView
          this.sendMessageToWebView({
            type: 'loginError',
            data: {
              message: `Login failed: ${errorMsg}`,
            },
          });

          throw _error;
        }
      },
    );
  }

  /**
   * Attempt to automatically reconnect after unexpected ACP process death.
   * Uses exponential backoff with a maximum number of attempts.
   */
  private async attemptAutoReconnect(): Promise<void> {
    if (this.isReconnecting) {
      return;
    }
    this.isReconnecting = true;
    this.agentInitialized = false;

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(
        `[WebViewProvider] Auto-reconnect attempt ${attempt}/${maxAttempts}`,
      );

      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        await this.doInitializeAgentConnection();
        console.log('[WebViewProvider] Auto-reconnect succeeded');
        this.isReconnecting = false;
        return;
      } catch (error) {
        console.error(
          `[WebViewProvider] Auto-reconnect attempt ${attempt} failed:`,
          error,
        );
      }
    }

    // All attempts exhausted
    this.isReconnecting = false;
    console.error('[WebViewProvider] Auto-reconnect failed after all attempts');

    this.sendMessageToWebView({
      type: 'agentConnectionError',
      data: {
        message:
          'Lost connection to Qwen agent and auto-reconnect failed. Please use the refresh button to try again.',
      },
    });
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
      } catch (_error) {
        console.log('[WebViewProvider] Error disconnecting:', _error);
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
    } catch (_error) {
      const errorMsg = getErrorMessage(_error);
      console.error('[WebViewProvider] Connection refresh failed:', _error);

      // Notify webview that agent connection failed after refresh
      this.sendMessageToWebView({
        type: 'agentConnectionError',
        data: {
          message: errorMsg,
        },
      });

      throw _error;
    }
  }

  /**
   * Load messages from current Qwen session
   * Skips session restoration and creates a new session directly
   */
  private async loadCurrentSessionMessages(options?: {
    autoAuthenticate?: boolean;
  }): Promise<boolean> {
    const autoAuthenticate = options?.autoAuthenticate ?? true;
    let sessionReady = false;
    try {
      console.log(
        '[WebViewProvider] Initializing with new session (skipping restoration)',
      );

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      // avoid creating another session if connect() already created one.
      if (!this.agentManager.currentSessionId) {
        if (!autoAuthenticate) {
          console.log(
            '[WebViewProvider] Skipping ACP session creation until user logs in.',
          );
          this.sendMessageToWebView({
            type: 'authState',
            data: { authenticated: false },
          });
        } else {
          try {
            await this.agentManager.createNewSession(workingDir, {
              autoAuthenticate,
            });
            console.log('[WebViewProvider] ACP session created successfully');
            sessionReady = true;
          } catch (sessionError) {
            const requiresAuth = isAuthenticationRequiredError(sessionError);
            if (requiresAuth && !autoAuthenticate) {
              console.log(
                '[WebViewProvider] ACP session requires authentication; waiting for explicit login.',
              );
              this.sendMessageToWebView({
                type: 'authState',
                data: { authenticated: false },
              });
            } else {
              const errorMsg = getErrorMessage(sessionError);
              console.error(
                '[WebViewProvider] Failed to create ACP session:',
                sessionError,
              );
              vscode.window.showWarningMessage(
                `Failed to create ACP session: ${errorMsg}. You may need to authenticate first.`,
              );
            }
          }
        }
      } else {
        console.log(
          '[WebViewProvider] Existing ACP session detected, skipping new session creation',
        );
        sessionReady = true;
      }

      if (sessionReady) {
        await this.applyInitialModelSelection();
      }

      await this.initializeEmptyConversation();
    } catch (_error) {
      const errorMsg = getErrorMessage(_error);
      console.error(
        '[WebViewProvider] Failed to load session messages:',
        _error,
      );
      vscode.window.showErrorMessage(
        `Failed to load session messages: ${errorMsg}`,
      );
      await this.initializeEmptyConversation();
      return false;
    }

    return sessionReady;
  }

  private async applyInitialModelSelection(): Promise<void> {
    if (!this.initialModelId) {
      return;
    }

    const modelId = this.initialModelId;
    this.initialModelId = null;

    try {
      await this.agentManager.setModelFromUi(modelId);
    } catch (error) {
      console.warn(
        '[WebViewProvider] Failed to apply initial model selection:',
        error,
      );
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
    } catch (_error) {
      console.error(
        '[WebViewProvider] Failed to initialize conversation:',
        _error,
      );
      // Send empty state to WebView as fallback
      this.sendMessageToWebView({
        type: 'conversationLoaded',
        data: { id: 'temp', messages: [] },
      });
    }
  }

  /**
   * Track authentication state based on outbound messages to the webview.
   */
  private updateAuthStateFromMessage(message: unknown): void {
    if (!message || typeof message !== 'object') {
      return;
    }
    const msg = message as {
      type?: string;
      data?: { authenticated?: boolean | null };
    };

    switch (msg.type) {
      case 'authState':
        if (typeof msg.data?.authenticated === 'boolean') {
          this.authState = msg.data.authenticated;
        } else {
          this.authState = null;
        }
        break;
      case 'agentConnected':
      case 'loginSuccess':
        this.authState = true;
        break;
      case 'agentConnectionError':
      case 'loginError':
        this.authState = false;
        break;
      default:
        break;
    }
  }

  /**
   * Sync important initialization state when the webview signals readiness.
   */
  private handleWebviewReady(): void {
    if (this.currentModeId) {
      this.sendMessageToWebView({
        type: 'modeChanged',
        data: { modeId: this.currentModeId },
      });
    }

    // Send cached available models to webview
    if (this.cachedAvailableModels && this.cachedAvailableModels.length > 0) {
      console.log(
        '[WebViewProvider] Sending cached availableModels on webviewReady:',
        this.cachedAvailableModels.map((m) => m.modelId),
      );
      this.sendMessageToWebView({
        type: 'availableModels',
        data: { models: this.cachedAvailableModels },
      });
    }

    if (typeof this.authState === 'boolean') {
      this.sendMessageToWebView({
        type: 'authState',
        data: { authenticated: this.authState },
      });
      return;
    }

    if (this.agentInitialized) {
      const authenticated = Boolean(this.agentManager.currentSessionId);
      this.sendMessageToWebView({
        type: 'authState',
        data: { authenticated },
      });
    }
  }

  /**
   * Context-aware handler for the "New Chat" action (openNewChatTab message).
   *
   * - View host (sidebar / secondary bar): resets the conversation in-place by
   *   routing to the newQwenSession handler (includes auth checks and UI clearing).
   * - Editor tab: returns false so the message falls through to
   *   SessionMessageHandler which opens a brand-new editor tab.
   *
   * @returns true if the message was handled, false otherwise.
   */
  private handleNewChatByContext(message: {
    type: string;
    data?: unknown;
  }): boolean {
    if (message.type !== 'openNewChatTab' || !this.isViewHost) {
      return false;
    }
    void this.messageHandler.route({ type: 'newQwenSession', data: {} });
    return true;
  }

  /**
   * Send message to WebView
   */
  private sendMessageToWebView(message: unknown): void {
    this.updateAuthStateFromMessage(message);
    this.getActiveWebview()?.postMessage(message);
  }

  private handleResolveImagePaths(
    data: unknown,
    targetWebview?: vscode.Webview,
  ): void {
    const webview = targetWebview ?? this.getActiveWebview();
    if (!webview) {
      return;
    }

    const payload = data as
      | { paths?: string[]; requestId?: number }
      | undefined;
    const paths = Array.isArray(payload?.paths) ? (payload?.paths ?? []) : [];

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const workspaceRoots = workspaceFolders.map((folder) => folder.uri.fsPath);

    const resolveImagePaths = createImagePathResolver({
      workspaceRoots,
      toWebviewUri: (filePath: string) =>
        webview.asWebviewUri(vscode.Uri.file(filePath)).toString(),
    });

    const resolved = resolveImagePaths(paths);

    webview.postMessage({
      type: 'imagePathsResolved',
      data: { resolved, requestId: payload?.requestId },
    });
  }

  private getActiveWebview(): vscode.Webview | null {
    return this.panelManager.getPanel()?.webview ?? this.attachedWebview;
  }

  /**
   * Whether there is a pending permission decision awaiting an option.
   */
  hasPendingPermission(): boolean {
    return !!this.pendingPermissionResolve;
  }

  /** Get current ACP mode id (if known). */
  getCurrentModeId(): ApprovalModeValue | null {
    return this.currentModeId;
  }

  /** True if diffs/permissions should be auto-handled without prompting. */
  isAutoMode(): boolean {
    return this.currentModeId === 'auto-edit' || this.currentModeId === 'yolo';
  }

  /** Used by extension to decide if diffs should be suppressed. */
  shouldSuppressDiff(): boolean {
    return this.isAutoMode();
  }

  /**
   * Simulate selecting a permission option while a request drawer is open.
   * The choice can be a concrete optionId or a shorthand intent.
   */
  respondToPendingPermission(
    choice: { optionId: string } | 'accept' | 'allow' | 'reject' | 'cancel',
  ): void {
    if (!this.pendingPermissionResolve || !this.pendingPermissionRequest) {
      return; // nothing to do
    }

    const options = this.pendingPermissionRequest.options || [];

    const pickByKind = (substr: string, preferOnce = false) => {
      const lc = substr.toLowerCase();
      const filtered = options.filter((o) =>
        (o.kind || '').toLowerCase().includes(lc),
      );
      if (preferOnce) {
        const once = filtered.find((o) =>
          (o.optionId || '').toLowerCase().includes('once'),
        );
        if (once) {
          return once.optionId;
        }
      }
      return filtered[0]?.optionId;
    };

    const pickByOptionId = (substr: string) =>
      options.find((o) => (o.optionId || '').toLowerCase().includes(substr))
        ?.optionId;

    let optionId: string | undefined;

    if (typeof choice === 'object') {
      optionId = choice.optionId;
    } else {
      const c = choice.toLowerCase();
      if (c === 'accept' || c === 'allow') {
        // Prefer an allow_once/proceed_once style option, then any allow/proceed
        optionId =
          pickByKind('allow', true) ||
          pickByOptionId('proceed_once') ||
          pickByKind('allow') ||
          pickByOptionId('proceed') ||
          options[0]?.optionId; // last resort: first option
      } else if (c === 'cancel' || c === 'reject') {
        // Prefer explicit cancel, then a reject option
        optionId =
          options.find((o) => o.optionId === 'cancel')?.optionId ||
          pickByKind('reject') ||
          pickByOptionId('cancel') ||
          pickByOptionId('reject') ||
          'cancel';
      }
    }

    if (!optionId) {
      return;
    }

    try {
      this.pendingPermissionResolve(optionId);
    } catch (_error) {
      console.warn(
        '[WebViewProvider] respondToPendingPermission failed:',
        _error,
      );
    }
  }

  /**
   * Reset agent initialization state
   * Call this when auth cache is cleared to force re-authentication
   */
  resetAgentState(): void {
    console.log('[WebViewProvider] Resetting agent state');
    this.agentInitialized = false;
    this.authState = null;
    // Disconnect existing connection
    this.agentManager.disconnect();
  }

  /**
   * Restore an existing WebView panel (called during VSCode restart)
   * This sets up the panel with all event listeners
   */
  async restorePanel(panel: vscode.WebviewPanel): Promise<void> {
    console.log('[WebViewProvider] Restoring WebView panel');
    console.log(
      '[WebViewProvider] Using CLI-managed authentication in restore',
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

    panel.webview.html = WebViewContent.generate(
      panel.webview,
      this.extensionUri,
    );

    // Handle messages from WebView (restored panel)
    panel.webview.onDidReceiveMessage(
      async (message: { type: string; data?: unknown }) => {
        // Suppress UI-originated diff opens in auto/yolo mode
        if (message.type === 'openDiff' && this.isAutoMode()) {
          return;
        }
        if (message.type === 'webviewReady') {
          this.handleWebviewReady();
          return;
        }
        if (message.type === 'resolveImagePaths') {
          this.handleResolveImagePaths(message.data, panel.webview);
          return;
        }
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
        // Handle ask user question response
        if (message.type === 'askUserQuestionResponse') {
          const askUserQuestionMsg = message as AskUserQuestionResponseMessage;
          const answers = askUserQuestionMsg.data.answers || {};
          const cancelled = askUserQuestionMsg.data.cancelled || false;

          // Resolve the pending ask user question promise
          if (cancelled) {
            this.pendingAskUserQuestionResolve?.({
              optionId: 'cancel',
            });
          } else {
            this.pendingAskUserQuestionResolve?.({
              optionId: 'proceed_once',
              answers,
            });
          }
          return;
        }
        if (this.handleNewChatByContext(message)) {
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

    // Listen for text selection changes (restore path)
    const selectionChangeDisposableRestore =
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

          this.sendMessageToWebView({
            type: 'activeEditorChanged',
            data: { fileName, filePath, selection: selectionInfo },
          });
        }
      });
    this.disposables.push(selectionChangeDisposableRestore);

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
    this.authState = null;
    console.log(
      '[WebViewProvider] State restored. agentInitialized:',
      this.agentInitialized,
    );

    // Reload content after restore
    const panel = this.panelManager.getPanel();
    if (panel) {
      panel.webview.html = WebViewContent.generate(
        panel.webview,
        this.extensionUri,
      );
    }
  }

  /**
   * Create a new session in the current panel
   * This is called when the user clicks the "New Session" button
   */
  async createNewSession(): Promise<void> {
    // WebView mode - create new session via agent manager
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      // Create new Qwen session via agent manager
      await this.agentManager.createNewSession(workingDir, { forceNew: true });
      this.messageHandler.setCurrentConversationId(null);

      // Clear current conversation UI
      this.sendMessageToWebView({
        type: 'conversationCleared',
        data: {},
      });
    } catch (_error) {
      console.error('[WebViewProvider] Failed to create new session:', _error);
      vscode.window.showErrorMessage(
        `Failed to create new session: ${getErrorMessage(_error)}`,
      );
    }
  }

  /**
   * Dispose the WebView provider and clean up resources
   */
  dispose(): void {
    // Unblock any pending ACP Promises before tearing down
    if (this.pendingPermissionResolve) {
      this.pendingPermissionResolve('cancel');
      this.pendingPermissionResolve = null;
      this.pendingPermissionRequest = null;
    }
    if (this.pendingAskUserQuestionResolve) {
      this.pendingAskUserQuestionResolve({ optionId: 'cancel' });
      this.pendingAskUserQuestionResolve = null;
      this.pendingAskUserQuestionRequest = null;
    }
    this.panelManager.dispose();
    this.agentManager.disconnect();
    this.disposables.forEach((d) => d.dispose());
  }
}
