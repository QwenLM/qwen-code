/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type {
  AvailableCommand,
  ModelInfo,
  RequestPermissionRequest,
} from '@agentclientprotocol/sdk';
import { QwenAgentManager } from '../services/qwenAgentManager.js';
import { ConversationStore } from '../services/conversationStore.js';
import type { PermissionResponseMessage } from '../types/webviewMessageTypes.js';
import { MessageHandler } from './MessageHandler.js';
import { WebViewContent } from './WebViewContent.js';
import { getFileName } from './utils/webviewUtils.js';
import { type ApprovalModeValue } from '../types/approvalModeValueTypes.js';
import { isAuthenticationRequiredError } from '../utils/authErrors.js';

export class SidebarWebviewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | null = null;
  private messageHandler: MessageHandler;
  private agentManager: QwenAgentManager;
  private conversationStore: ConversationStore;
  private disposables: vscode.Disposable[] = [];
  private agentInitialized = false;
  private pendingPermissionRequest: RequestPermissionRequest | null = null;
  private pendingPermissionResolve: ((optionId: string) => void) | null = null;
  private currentModeId: ApprovalModeValue | null = null;
  private authState: boolean | null = null;
  private cachedAvailableModels: ModelInfo[] | null = null;
  private cachedAvailableCommands: AvailableCommand[] | null = null;
  private initializationPromise: Promise<void> | null = null;

  constructor(
    context: vscode.ExtensionContext,
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

    this.messageHandler.setLoginHandler(async () => {
      await this.forceReLogin();
    });

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
        this.currentModeId = (info?.currentModeId ||
          null) as ApprovalModeValue | null;
      } catch (_error) {
        // Ignore invalid mode payloads.
      }
      this.sendMessageToWebView({
        type: 'modeInfo',
        data: info || {},
      });
    });

    this.agentManager.onModeChanged((modeId) => {
      try {
        this.currentModeId = modeId;
      } catch (_error) {
        // Ignore invalid mode payloads.
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

    this.agentManager.onModelChanged((model) => {
      this.sendMessageToWebView({
        type: 'modelChanged',
        data: { model },
      });
    });

    this.agentManager.onAvailableCommands((commands) => {
      this.cachedAvailableCommands = commands;
      this.sendMessageToWebView({
        type: 'availableCommands',
        data: { commands },
      });
    });

    this.agentManager.onAvailableModels((models) => {
      this.cachedAvailableModels = models;
      this.sendMessageToWebView({
        type: 'availableModels',
        data: { models },
      });
    });

    this.agentManager.onEndTurn((reason) => {
      this.sendMessageToWebView({
        type: 'streamEnd',
        data: {
          timestamp: Date.now(),
          reason: reason || 'end_turn',
        },
      });
    });

    this.agentManager.onToolCall((update) => {
      const updateData = update as unknown as Record<string, unknown>;
      let messageType = updateData.sessionUpdate as string | undefined;
      if (!messageType) {
        messageType =
          updateData.kind || updateData.title || updateData.rawInput
            ? 'tool_call'
            : 'tool_call_update';
      }

      this.sendMessageToWebView({
        type: 'toolCall',
        data: {
          type: messageType,
          ...updateData,
        },
      });
    });

    this.agentManager.onPlan((entries) => {
      this.sendMessageToWebView({
        type: 'plan',
        data: { entries },
      });
    });

    this.agentManager.onPermissionRequest(
      async (request: RequestPermissionRequest) => {
        if (this.isAutoMode()) {
          const options = request.options || [];
          const pick = (substr: string) =>
            options.find((o) =>
              (o.optionId || '').toLowerCase().includes(substr),
            )?.optionId;
          const pickByKind = (kind: string) =>
            options.find((o) => (o.kind || '').toLowerCase().includes(kind))
              ?.optionId;
          return (
            pick('allow_once') ||
            pickByKind('allow') ||
            pick('proceed') ||
            options[0]?.optionId ||
            'allow_once'
          );
        }

        this.sendMessageToWebView({
          type: 'permissionRequest',
          data: request,
        });

        return new Promise((resolve) => {
          this.pendingPermissionRequest = request;
          this.pendingPermissionResolve = (optionId: string) => {
            try {
              resolve(optionId);
            } finally {
              this.pendingPermissionRequest = null;
              this.pendingPermissionResolve = null;
              this.sendMessageToWebView({
                type: 'permissionResolved',
                data: { optionId },
              });
              const isCancel =
                optionId === 'cancel' ||
                optionId.toLowerCase().includes('reject');
              if (!isCancel) {
                void vscode.commands.executeCommand('qwen.diff.closeAll');
                void vscode.commands.executeCommand(
                  'qwen.diff.suppressBriefly',
                );
              }
            }
          };

          const handler = (message: PermissionResponseMessage) => {
            if (message.type !== 'permissionResponse') {
              return;
            }

            const optionId = message.data.optionId || '';
            this.pendingPermissionResolve?.(optionId);

            const isCancel =
              optionId === 'cancel' ||
              optionId.toLowerCase().includes('reject');
            if (!isCancel) {
              void vscode.commands.executeCommand('qwen.diff.closeAll');
              void vscode.commands.executeCommand('qwen.diff.suppressBriefly');
              return;
            }

            void vscode.commands.executeCommand('qwen.diff.closeAll');
            void (async () => {
              try {
                await this.agentManager.cancelCurrentPrompt();
              } catch (_error) {
                // Ignore cancellation races.
              }

              this.sendMessageToWebView({
                type: 'streamEnd',
                data: { timestamp: Date.now(), reason: 'user_cancelled' },
              });

              try {
                const toolCallId =
                  (request.toolCall as { toolCallId?: string } | undefined)
                    ?.toolCallId || '';
                const title =
                  (request.toolCall as { title?: string } | undefined)?.title ||
                  '';
                let kind = ((request.toolCall as { kind?: string } | undefined)
                  ?.kind || 'execute') as string;
                if (!kind && title) {
                  const normalizedTitle = title.toLowerCase();
                  if (
                    normalizedTitle.includes('read') ||
                    normalizedTitle.includes('cat')
                  ) {
                    kind = 'read';
                  } else if (
                    normalizedTitle.includes('write') ||
                    normalizedTitle.includes('edit')
                  ) {
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
              } catch (_error) {
                // Ignore best-effort UI updates.
              }
            })();
          };

          this.messageHandler.setPermissionHandler(handler);
        });
      },
    );
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.disposeViewListeners();
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = WebViewContent.generate(
      webviewView,
      this.extensionUri,
    );

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage(
        async (message: { type: string; data?: unknown }) => {
          if (message.type === 'openDiff' && this.isAutoMode()) {
            return;
          }
          if (message.type === 'webviewReady') {
            this.handleWebviewReady();
            if (!this.agentInitialized) {
              await this.attemptAuthStateRestoration();
            }
            return;
          }
          if (message.type === 'updatePanelTitle') {
            return;
          }
          if (message.type === 'openNewChatTab') {
            await this.messageHandler.route({
              type: 'newQwenSession',
              data: message.data,
            });
            return;
          }

          await this.messageHandler.route(message);
        },
      ),
    );

    this.disposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible && !this.agentInitialized) {
          void this.attemptAuthStateRestoration();
        }
      }),
    );

    this.registerActiveEditorListeners();

    if (webviewView.visible) {
      await this.attemptAuthStateRestoration();
    }
  }

  async forceReLogin(): Promise<void> {
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
          } catch (_error) {
            // Ignore disconnect failures during re-auth.
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

        await this.doInitializeAgentConnection({ autoAuthenticate: true });
        this.sendMessageToWebView({
          type: 'loginSuccess',
          data: { message: 'Successfully logged in!' },
        });
      },
    );
  }

  hasPendingPermission(): boolean {
    return !!this.pendingPermissionResolve;
  }

  shouldSuppressDiff(): boolean {
    return this.isAutoMode();
  }

  respondToPendingPermission(
    choice: { optionId: string } | 'accept' | 'allow' | 'reject' | 'cancel',
  ): void {
    if (!this.pendingPermissionResolve || !this.pendingPermissionRequest) {
      return;
    }

    const options = this.pendingPermissionRequest.options || [];
    const pickByKind = (substr: string, preferOnce = false) => {
      const filtered = options.filter((o) =>
        (o.kind || '').toLowerCase().includes(substr.toLowerCase()),
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
    } else if (choice === 'accept' || choice === 'allow') {
      optionId =
        pickByKind('allow', true) ||
        pickByOptionId('proceed_once') ||
        pickByKind('allow') ||
        pickByOptionId('proceed') ||
        options[0]?.optionId;
    } else {
      optionId =
        options.find((o) => o.optionId === 'cancel')?.optionId ||
        pickByKind('reject') ||
        pickByOptionId('cancel') ||
        pickByOptionId('reject') ||
        'cancel';
    }

    if (optionId) {
      this.pendingPermissionResolve(optionId);
    }
  }

  dispose(): void {
    this.disposeViewListeners();
    this.view = null;
    this.agentManager.disconnect();
  }

  private disposeViewListeners(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.disposables = [];
  }

  private registerActiveEditorListeners(): void {
    const sendActiveEditorState = (
      editor: vscode.TextEditor | undefined,
      selection?: vscode.Selection,
    ) => {
      if (!editor) {
        return;
      }

      const filePath = editor.document.uri.fsPath || null;
      const fileName = filePath ? getFileName(filePath) : null;
      const activeSelection = selection ?? editor.selection;
      const selectionInfo = activeSelection.isEmpty
        ? null
        : {
            startLine: activeSelection.start.line + 1,
            endLine: activeSelection.end.line + 1,
          };

      this.sendMessageToWebView({
        type: 'activeEditorChanged',
        data: { fileName, filePath, selection: selectionInfo },
      });
    };

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        sendActiveEditorState(editor);
      }),
    );

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          sendActiveEditorState(event.textEditor, event.selections[0]);
        }
      }),
    );

    sendActiveEditorState(vscode.window.activeTextEditor);
  }

  private async attemptAuthStateRestoration(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      try {
        await this.initializeAgentConnection({ autoAuthenticate: false });
      } catch (_error) {
        await this.initializeEmptyConversation();
      } finally {
        this.initializationPromise = null;
      }
    })();

    return this.initializationPromise;
  }

  private async initializeAgentConnection(options?: {
    autoAuthenticate?: boolean;
  }): Promise<void> {
    await this.doInitializeAgentConnection(options);
  }

  private async doInitializeAgentConnection(options?: {
    autoAuthenticate?: boolean;
  }): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
    const bundledCliEntry = vscode.Uri.joinPath(
      this.extensionUri,
      'dist',
      'qwen-cli',
      'cli.js',
    ).fsPath;

    try {
      const connectResult = await this.agentManager.connect(
        workingDir,
        bundledCliEntry,
        options,
      );
      this.agentInitialized = true;

      if (connectResult.requiresAuth && !options?.autoAuthenticate) {
        this.sendMessageToWebView({
          type: 'authState',
          data: { authenticated: false },
        });
        await this.initializeEmptyConversation();
        return;
      }

      if (connectResult.requiresAuth) {
        this.sendMessageToWebView({
          type: 'authState',
          data: { authenticated: false },
        });
      }

      const sessionReady = await this.loadCurrentSessionMessages(options);
      if (sessionReady) {
        this.sendMessageToWebView({
          type: 'agentConnected',
          data: {},
        });
      }
    } catch (error) {
      const requiresAuth = isAuthenticationRequiredError(error);
      if (requiresAuth) {
        this.sendMessageToWebView({
          type: 'authState',
          data: { authenticated: false },
        });
        await this.initializeEmptyConversation();
        return;
      }

      vscode.window.showWarningMessage(
        `Failed to connect to Qwen CLI: ${error}\nYou can still use the chat UI, but messages won't be sent to AI.`,
      );
      await this.initializeEmptyConversation();
      this.sendMessageToWebView({
        type: 'agentConnectionError',
        data: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async loadCurrentSessionMessages(options?: {
    autoAuthenticate?: boolean;
  }): Promise<boolean> {
    const autoAuthenticate = options?.autoAuthenticate ?? true;
    let sessionReady = false;

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      if (!this.agentManager.currentSessionId) {
        if (!autoAuthenticate) {
          this.sendMessageToWebView({
            type: 'authState',
            data: { authenticated: false },
          });
        } else {
          try {
            await this.agentManager.createNewSession(workingDir, {
              autoAuthenticate,
            });
            sessionReady = true;
          } catch (sessionError) {
            if (
              isAuthenticationRequiredError(sessionError) &&
              !autoAuthenticate
            ) {
              this.sendMessageToWebView({
                type: 'authState',
                data: { authenticated: false },
              });
            } else {
              vscode.window.showWarningMessage(
                `Failed to create ACP session: ${sessionError}. You may need to authenticate first.`,
              );
            }
          }
        }
      } else {
        sessionReady = true;
      }

      await this.initializeEmptyConversation();
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to load session messages: ${error}`,
      );
      await this.initializeEmptyConversation();
      return false;
    }

    return sessionReady;
  }

  private async initializeEmptyConversation(): Promise<void> {
    try {
      const newConversation = await this.conversationStore.createConversation();
      this.messageHandler.setCurrentConversationId(newConversation.id);
      this.sendMessageToWebView({
        type: 'conversationLoaded',
        data: newConversation,
      });
    } catch (_error) {
      this.sendMessageToWebView({
        type: 'conversationLoaded',
        data: { id: 'temp', messages: [] },
      });
    }
  }

  private handleWebviewReady(): void {
    if (this.currentModeId) {
      this.sendMessageToWebView({
        type: 'modeChanged',
        data: { modeId: this.currentModeId },
      });
    }

    if (this.cachedAvailableModels && this.cachedAvailableModels.length > 0) {
      this.sendMessageToWebView({
        type: 'availableModels',
        data: { models: this.cachedAvailableModels },
      });
    }

    if (
      this.cachedAvailableCommands &&
      this.cachedAvailableCommands.length > 0
    ) {
      this.sendMessageToWebView({
        type: 'availableCommands',
        data: { commands: this.cachedAvailableCommands },
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
      this.sendMessageToWebView({
        type: 'authState',
        data: { authenticated: Boolean(this.agentManager.currentSessionId) },
      });
    }
  }

  private updateAuthStateFromMessage(message: unknown): void {
    if (!message || typeof message !== 'object') {
      return;
    }

    const typedMessage = message as {
      type?: string;
      data?: { authenticated?: boolean | null };
    };

    switch (typedMessage.type) {
      case 'authState':
        if (typeof typedMessage.data?.authenticated === 'boolean') {
          this.authState = typedMessage.data.authenticated;
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

  private isAutoMode(): boolean {
    return this.currentModeId === 'auto-edit' || this.currentModeId === 'yolo';
  }

  private sendMessageToWebView(message: unknown): void {
    this.updateAuthStateFromMessage(message);
    void this.view?.webview.postMessage(message);
  }
}
