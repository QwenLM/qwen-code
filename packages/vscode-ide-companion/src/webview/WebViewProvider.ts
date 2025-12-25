/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { QwenAgentManager } from '../services/qwenAgentManager.js';
import { ConversationStore } from '../services/conversationStore.js';
import type { AcpPermissionRequest } from '../types/acpTypes.js';
import { PanelManager } from '../webview/PanelManager.js';
import { MessageHandler } from '../webview/MessageHandler.js';
import { WebViewContent } from '../webview/WebViewContent.js';
import { getFileName } from './utils/webviewUtils.js';
import { type ApprovalModeValue } from '../types/approvalModeValueTypes.js';
import { isAuthenticationRequiredError } from '../utils/authErrors.js';

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
  private pendingPermissionRequest: AcpPermissionRequest | null = null;
  private pendingPermissionResolve: ((optionId: string) => void) | null = null;
  // Track current ACP mode id to influence permission/diff behavior
  private currentModeId: ApprovalModeValue | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    private extensionUri: vscode.Uri,
  ) {
    this.agentManager = new QwenAgentManager();
    this.conversationStore = new ConversationStore(context);
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
      async (request: AcpPermissionRequest) => {
        // Auto-approve in auto/yolo mode (no UI, no diff)
        if (this.isAutoMode()) {
          const options = request.options || [];
          const pick = (substr: string) =>
            options.find((o) =>
              (o.optionId || '').toLowerCase().includes(substr),
            )?.optionId;
          const pickByKind = (k: string) =>
            options.find((o) => (o.kind || '').toLowerCase().includes(k))
              ?.optionId;
          const optionId =
            pick('allow_once') ||
            pickByKind('allow') ||
            pick('proceed') ||
            options[0]?.optionId ||
            'allow_once';
          return optionId;
        }

        // Send permission request to WebView
        this.sendMessageToWebView({
          type: 'permissionRequest',
          data: request,
        });

        // Wait for user response
        return new Promise((resolve) => {
          // cache the pending request and its resolver so commands can resolve it
          this.pendingPermissionRequest = request;
          this.pendingPermissionResolve = (optionId: string) => {
            try {
              resolve(optionId);
            } finally {
              // Always clear pending state
              this.pendingPermissionRequest = null;
              this.pendingPermissionResolve = null;
              // Also instruct the webview UI to close its drawer if it is open
              this.sendMessageToWebView({
                type: 'permissionResolved',
                data: { optionId },
              });
              // If allowed/proceeded, close any open qwen-diff editors and suppress re-open briefly
              const isCancel =
                optionId === 'cancel' ||
                optionId.toLowerCase().includes('reject');
              if (!isCancel) {
                try {
                  void vscode.commands.executeCommand('qwen.diff.closeAll');
                } catch (err) {
                  console.warn(
                    '[WebViewProvider] Failed to close diffs after allow (resolver):',
                    err,
                  );
                }
                try {
                  void vscode.commands.executeCommand(
                    'qwen.diff.suppressBriefly',
                  );
                } catch (err) {
                  console.warn(
                    '[WebViewProvider] Failed to suppress diffs briefly:',
                    err,
                  );
                }
              }
            }
          };
          const handler = (message: {
            type: string;
            data: { optionId: string };
          }) => {
            if (message.type !== 'permissionResponse') {
              return;
            }

            const optionId = message.data.optionId || '';

            // 1) First resolve the optionId back to ACP so the agent isn't blocked
            this.pendingPermissionResolve?.(optionId);

            // 2) If user cancelled/rejected, proactively stop current generation
            const isCancel =
              optionId === 'cancel' ||
              optionId.toLowerCase().includes('reject');

            if (isCancel) {
              // Fire and forget – do not block the ACP resolve
              (async () => {
                try {
                  // Stop server-side generation
                  await this.agentManager.cancelCurrentPrompt();
                } catch (err) {
                  console.warn(
                    '[WebViewProvider] cancelCurrentPrompt error:',
                    err,
                  );
                }

                // Ensure the webview exits streaming state immediately
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
                  // Normalize kind for UI – fall back to 'execute'
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
                      // Best-effort pass-through (used by UI hints)
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
            }
            // If user allowed/proceeded, proactively close any open qwen-diff editors and suppress re-open briefly
            else {
              try {
                void vscode.commands.executeCommand('qwen.diff.closeAll');
              } catch (err) {
                console.warn(
                  '[WebViewProvider] Failed to close diffs after allow:',
                  err,
                );
              }
              try {
                void vscode.commands.executeCommand(
                  'qwen.diff.suppressBriefly',
                );
              } catch (err) {
                console.warn(
                  '[WebViewProvider] Failed to suppress diffs briefly:',
                  err,
                );
              }
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
        // Suppress UI-originated diff opens in auto/yolo mode
        if (message.type === 'openDiff' && this.isAutoMode()) {
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

  /**
   * Attempt to restore authentication state and initialize connection
   * This is called when the webview is first shown
   */
  private async attemptAuthStateRestoration(): Promise<void> {
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
    }
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
        console.error('[WebViewProvider] Agent connection error:', _error);
        vscode.window.showWarningMessage(
          `Failed to connect to Qwen CLI: ${_error}\nYou can still use the chat UI, but messages won't be sent to AI.`,
        );
        // Fallback to empty conversation
        await this.initializeEmptyConversation();

        // Notify webview that agent connection failed
        this.sendMessageToWebView({
          type: 'agentConnectionError',
          data: {
            message: _error instanceof Error ? _error.message : String(_error),
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
          console.error('[WebViewProvider] Force re-login failed:', _error);
          console.error(
            '[WebViewProvider] Error stack:',
            _error instanceof Error ? _error.stack : 'N/A',
          );

          // Send error notification to WebView
          this.sendMessageToWebView({
            type: 'loginError',
            data: {
              message: `Login failed: ${_error instanceof Error ? _error.message : String(_error)}`,
            },
          });

          throw _error;
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
      console.error('[WebViewProvider] Connection refresh failed:', _error);

      // Notify webview that agent connection failed after refresh
      this.sendMessageToWebView({
        type: 'agentConnectionError',
        data: {
          message: _error instanceof Error ? _error.message : String(_error),
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
              console.error(
                '[WebViewProvider] Failed to create ACP session:',
                sessionError,
              );
              vscode.window.showWarningMessage(
                `Failed to create ACP session: ${sessionError}. You may need to authenticate first.`,
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

      await this.initializeEmptyConversation();
    } catch (_error) {
      console.error(
        '[WebViewProvider] Failed to load session messages:',
        _error,
      );
      vscode.window.showErrorMessage(
        `Failed to load session messages: ${_error}`,
      );
      await this.initializeEmptyConversation();
      return false;
    }

    return sessionReady;
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
   * Send message to WebView
   */
  private sendMessageToWebView(message: unknown): void {
    const panel = this.panelManager.getPanel();
    panel?.webview.postMessage(message);
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

    panel.webview.html = WebViewContent.generate(panel, this.extensionUri);

    // Handle messages from WebView (restored panel)
    panel.webview.onDidReceiveMessage(
      async (message: { type: string; data?: unknown }) => {
        // Suppress UI-originated diff opens in auto/yolo mode
        if (message.type === 'openDiff' && this.isAutoMode()) {
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
    // WebView mode - create new session via agent manager
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      // Create new Qwen session via agent manager
      await this.agentManager.createNewSession(workingDir);

      // Clear current conversation UI
      this.sendMessageToWebView({
        type: 'conversationCleared',
        data: {},
      });
    } catch (_error) {
      console.error('[WebViewProvider] Failed to create new session:', _error);
      vscode.window.showErrorMessage(`Failed to create new session: ${_error}`);
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
