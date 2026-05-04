/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { QwenAgentManager } from '../../services/qwenAgentManager.js';
import { ConversationStore } from '../../services/conversationStore.js';
import type {
  RequestPermissionRequest,
  AvailableCommand,
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
import { truncatePanelTitle } from '../utils/panelTitleUtils.js';
import { createImagePathResolver } from '../utils/imageHandler.js';
import { type ApprovalModeValue } from '../../types/approvalModeValueTypes.js';
import { isAuthenticationRequiredError } from '../../utils/authErrors.js';
import { getErrorMessage } from '../../utils/errorMessage.js';
import {
  writeCodingPlanConfig,
  writeModelProvidersConfig,
  readQwenSettingsForVSCode,
  clearPersistedAuth,
} from '../../services/settingsWriter.js';
import { parseInsightMessage } from '@qwen-code/qwen-code-core';

/** Threshold (ms) before a completed task triggers a notification. */
const LONG_TASK_THRESHOLD_MS = 20_000;

/** Possible tab-dot colours. */
const DotColor = {
  /** Task completed while tab was not active. */
  Orange: 'orange',
  /** Agent needs user input (permission / question). Higher priority than orange. */
  Blue: 'blue',
} as const;
type DotColor = (typeof DotColor)[keyof typeof DotColor];

/** Asset file names for tab dot icon states. */
const DOT_ICON: Record<DotColor | 'default', string> = {
  orange: 'icon-orange.png',
  blue: 'icon-blue.png',
  default: 'icon.png',
};

const AUTH_RELATED_QWEN_SETTINGS = [
  'qwen-code.provider',
  'qwen-code.apiKey',
  'qwen-code.codingPlanRegion',
] as const;

function isInsightCommand(command: string): boolean {
  const [firstToken = ''] = command.trim().split(/\s+/, 1);
  return firstToken.replace(/^\/+/, '') === 'insight';
}

export class WebViewProvider {
  private panelManager: PanelManager;
  private messageHandler: MessageHandler;
  private agentManager: QwenAgentManager;
  private conversationStore: ConversationStore;
  private disposables: vscode.Disposable[] = [];
  private agentInitialized = false; // Track if agent has been initialized
  private isSyncingToVSCode = false; // Guard to prevent config change loop
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
  /** Global tracker: the provider whose webview most recently received a contextmenu event */
  private static lastContextMenuProvider: WebViewProvider | null = null;
  /** Cached available commands for re-sending on webview ready */
  private cachedAvailableCommands: AvailableCommand[] | null = null;
  /** Cached available skills for re-sending on webview ready */
  private cachedAvailableSkills: string[] | null = null;
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
  /** Timer for the deferred auto-auth launch inside doInitializeAgentConnection */
  private autoAuthTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether an explicit interactive auth flow is currently active */
  private authFlowActive = false;
  /** Timestamp (ms) when the current agent task started (first stream chunk) */
  private agentStartTime: number | null = null;
  /** Current tab-dot state: null = no dot, 'orange' = task done, 'blue' = needs attention */
  private dotState: DotColor | null = null;
  /** Guard: attention notification already sent for the current permission/question request */
  private attentionNotified = false;
  /** Guard: idle notification already sent for the current task (prevents multi-turn duplicates) */
  private idleNotificationSent = false;

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

    // Set auth interactive handler — interactive auth flow (QuickPick → InputBox → write settings → reconnect)
    this.messageHandler.setAuthInteractiveHandler(
      async (provider, region, apiKey, baseUrl, model, modelIds) => {
        await this.handleAuthInteractive(
          provider,
          region,
          apiKey,
          baseUrl,
          model,
          modelIds,
        );
      },
    );

    // Watch for auth-related VSCode settings changes — auto-sync and reconnect.
    // The isSyncingToVSCode guard prevents a loop when we programmatically populate VSCode settings.
    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(
      async (e) => {
        const authSettingsChanged = AUTH_RELATED_QWEN_SETTINGS.some((setting) =>
          e.affectsConfiguration(setting),
        );

        if (authSettingsChanged && !this.isSyncingToVSCode) {
          console.log(
            '[WebViewProvider] Auth-related qwen-code settings changed by user, syncing...',
          );
          const synced = await this.syncVSCodeSettingsToQwenConfig();
          if (synced && this.agentInitialized) {
            // Settings changed and we have an active connection — reconnect
            try {
              this.agentManager.disconnect();
              this.agentInitialized = false;
              await new Promise((resolve) => setTimeout(resolve, 300));
              await this.doInitializeAgentConnection({
                autoAuthenticate: false,
              });
            } catch (e) {
              console.error(
                '[WebViewProvider] Reconnect after settings change failed:',
                e,
              );
            }
          } else if (
            !synced &&
            this.agentInitialized &&
            e.affectsConfiguration('qwen-code.apiKey')
          ) {
            // Only de-auth when qwen-code.apiKey itself was cleared.
            // Other auth-related settings (provider, codingPlanRegion) returning
            // synced=false is normal for api-key providers — those are managed by
            // the interactive auth flow, not VS Code Settings sync.
            const apiKey = vscode.workspace
              .getConfiguration('qwen-code')
              .get<string>('apiKey', '');
            if (!apiKey) {
              console.log(
                '[WebViewProvider] apiKey cleared — de-authenticating and clearing persisted credentials',
              );
              clearPersistedAuth();
              this.agentManager.disconnect();
              this.agentInitialized = false;
              this.authState = false;
              this.sendMessageToWebView({
                type: 'authState',
                data: { authenticated: false },
              });
            }
          }
        }
      },
    );
    this.disposables.push(configChangeDisposable);

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
      if (this.agentStartTime === null) {
        this.agentStartTime = Date.now();
      }
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

    this.agentManager.onSlashCommandNotification((event) => {
      if (isInsightCommand(event.command) && event.messageType === 'error') {
        this.sendMessageToWebView({
          type: 'insightProgressCleared',
          data: {},
        });
      }

      // Try to parse as structured insight message
      if (isInsightCommand(event.command) && event.messageType === 'info') {
        const parsed = parseInsightMessage(event.message);
        if (parsed?.type === 'insight_progress') {
          this.sendMessageToWebView({
            type: 'insightProgress',
            data: {
              stage: parsed.stage,
              progress: parsed.progress,
              detail: parsed.detail,
            },
          });
          return;
        }

        if (parsed?.type === 'insight_ready') {
          this.sendMessageToWebView({
            type: 'insightReportReady',
            data: {
              path: parsed.path,
            },
          });
          return;
        }
      }

      const chunk = event.message.endsWith('\n')
        ? event.message
        : `${event.message}\n`;
      this.messageHandler.appendStreamContent(chunk);
      this.sendMessageToWebView({
        type: 'streamChunk',
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
      this.cachedAvailableCommands = commands;
      this.sendMessageToWebView({
        type: 'availableCommands',
        data: { commands },
      });
    });

    // Surface available skills for the /skills secondary picker
    this.agentManager.onAvailableSkills((skills) => {
      this.cachedAvailableSkills = skills;
      this.sendMessageToWebView({
        type: 'availableSkills',
        data: { skills },
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
      // Fire the idle notification from here (authoritative "task done" event) rather
      // than relying on the webview's isStreaming transition, which fires on every
      // intermediate streamEnd in multi-tool-call sequences and on cancellation.
      this.handleAgentIdle();
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
        // Notify the user immediately (dot + optional system notification)
        const toolTitle = (request.toolCall as { title?: string } | undefined)
          ?.title;
        this.handleAgentNeedsAttention(toolTitle);

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

            // For switch_mode (exit_plan_mode), cancel means "reject
            // the plan and stay in plan mode" — the agent keeps running.
            const isSwitchMode =
              (request.toolCall as { kind?: string } | undefined)?.kind ===
              'switch_mode';

            // Always close open qwen-diff editors after any permission decision
            void vscode.commands.executeCommand('qwen.diff.closeAll');

            if (isCancel) {
              // Fire and forget — for normal tool calls, cancel generation and
              // end the stream; for switch_mode, keep the session alive but
              // still mark the permission tool call as failed in the UI.
              void (async () => {
                if (!isSwitchMode) {
                  try {
                    await this.agentManager.cancelCurrentPrompt();
                  } catch (err) {
                    console.warn(
                      '[WebViewProvider] cancelCurrentPrompt error:',
                      err,
                    );
                  }

                  this.agentStartTime = null;
                  this.idleNotificationSent = false;
                  this.sendMessageToWebView({
                    type: 'streamEnd',
                    data: { timestamp: Date.now(), reason: 'user_cancelled' },
                  });
                }

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
        // Notify the user immediately (dot + optional system notification)
        this.handleAgentNeedsAttention();

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
      // Reset task timing to prevent phantom notifications after reconnect.
      this.agentStartTime = null;
      this.idleNotificationSent = false;
      // Only auto-reconnect for unexpected disconnects
      if (this.agentInitialized && !this.isReconnecting) {
        this.attemptAutoReconnect();
      }
    });
  }

  private async openInsightReport(path: string): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.file(path));
  }

  private async handleOpenInsightReportMessage(message: {
    type: string;
    data?: unknown;
  }): Promise<boolean> {
    if (message.type !== 'openInsightReport') {
      return false;
    }

    const path = (message.data as { path?: unknown } | undefined)?.path;
    if (typeof path === 'string' && path.length > 0) {
      await this.openInsightReport(path);
    }
    return true;
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
        if (await this.handleCommonWebviewMessage(message, webview)) {
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
    // Also reset dotState so it doesn't leak into a future editor-tab panel.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.dotState = null;
      }
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

    // Create new panel — reset stale dot state from a previous sidebar interaction.
    this.dotState = null;

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
    newPanel.onDidChangeViewState(
      () => {
        console.log(
          '[WebViewProvider] Panel view state changed, triggering serialization check',
        );
      },
      null,
      this.disposables,
    );

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
        if (await this.handleCommonWebviewMessage(message, newPanel.webview)) {
          return;
        }
        // Allow webview to request updating the VS Code tab title
        if (message.type === 'updatePanelTitle') {
          const title = String(
            (message.data as { title?: unknown } | undefined)?.title ?? '',
          ).trim();
          const panelRef = this.panelManager.getPanel();
          if (panelRef) {
            panelRef.title = title ? truncatePanelTitle(title) : 'Qwen Code';
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

    // Clear the tab dot when the user switches to this panel.
    newPanel.onDidChangeViewState(
      () => {
        if (newPanel.visible) {
          this.clearTabDot();
        }
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
   * Launch the interactive auth flow (QuickPick → InputBox → write settings → reconnect).
   * Guards against concurrent launches: if auto-auth was scheduled by
   * doInitializeAgentConnection's deferred timeout, it is cancelled first.
   */
  async startInteractiveAuth(): Promise<void> {
    // Cancel any pending auto-auth from doInitializeAgentConnection so we
    // don't end up with two overlapping auth flows.
    if (this.autoAuthTimer) {
      clearTimeout(this.autoAuthTimer);
      this.autoAuthTimer = null;
    }
    if (this.authFlowActive) {
      return;
    }
    this.authFlowActive = true;
    try {
      await this.messageHandler.route({ type: 'auth' });
    } finally {
      this.authFlowActive = false;
    }
  }

  setInitialModelId(modelId: string | null | undefined): void {
    this.initialModelId =
      typeof modelId === 'string' && modelId.trim().length > 0
        ? modelId.trim()
        : null;
  }

  /**
   * Sync VSCode extension settings (qwen-code.*) to ~/.qwen/settings.json
   * if an API key is configured. This enables auto-connect on startup
   * without requiring the user to click "Connect" each time.
   *
   * @returns true if settings were synced (apiKey is configured), false otherwise
   */
  private async syncVSCodeSettingsToQwenConfig(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('qwen-code');
    const apiKey = config.get<string>('apiKey', '');

    if (!apiKey) {
      return false;
    }

    try {
      const provider = config.get<string>('provider', 'coding-plan');

      if (provider !== 'coding-plan') {
        console.log(
          '[WebViewProvider] Skipping VSCode settings sync for api-key provider; interactive auth owns provider details',
        );
        return false;
      }

      const region = config.get<'china' | 'global'>(
        'codingPlanRegion',
        'china',
      );
      writeCodingPlanConfig(region, apiKey);

      console.log(
        `[WebViewProvider] Synced VSCode settings → ~/.qwen/settings.json (provider=${provider})`,
      );
      return true;
    } catch (error) {
      console.error('[WebViewProvider] Failed to sync VSCode settings:', error);
      return false;
    }
  }

  /**
   * Sync ~/.qwen/settings.json values back to VSCode Settings UI.
   * This makes existing CLI-configured non-secret metadata visible in the
   * VSCode Settings page without mirroring credentials into settings.json.
   */
  private async syncQwenConfigToVSCodeSettings(): Promise<void> {
    try {
      const qwenSettings = readQwenSettingsForVSCode();
      if (!qwenSettings) {
        return;
      }

      console.log(
        '[WebViewProvider] Syncing ~/.qwen/settings.json → VSCode settings',
      );

      // Set guard to prevent onDidChangeConfiguration from triggering a write-back
      const config = vscode.workspace.getConfiguration('qwen-code');
      const target = vscode.ConfigurationTarget.Global;
      const updates: Array<Thenable<void>> = [];

      if (
        config.get<string>('provider', 'coding-plan') !== qwenSettings.provider
      ) {
        updates.push(config.update('provider', qwenSettings.provider, target));
      }
      if (
        config.get<'china' | 'global'>('codingPlanRegion', 'china') !==
        qwenSettings.codingPlanRegion
      ) {
        updates.push(
          config.update(
            'codingPlanRegion',
            qwenSettings.codingPlanRegion,
            target,
          ),
        );
      }

      if (updates.length === 0) {
        console.log(
          '[WebViewProvider] VSCode settings already match ~/.qwen/settings.json',
        );
        return;
      }

      this.isSyncingToVSCode = true;

      try {
        await Promise.all(updates);
      } finally {
        this.isSyncingToVSCode = false;
      }
    } catch (error) {
      console.error(
        '[WebViewProvider] Failed to sync qwen config to VSCode settings:',
        error,
      );
    }
  }

  /**
   * Attempt to restore authentication state and initialize connection.
   * On startup, sync ~/.qwen/settings.json → VSCode settings so the Settings UI
   * reflects existing non-secret CLI config, then attempt a connection.
   * Writing back to ~/.qwen/settings.json happens through the auth flow and
   * auth-related VSCode setting changes.
   */
  private async attemptAuthStateRestoration(): Promise<void> {
    // Prevent concurrent initialization attempts (e.g. visibility toggle + webviewReady race)
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      try {
        await this.syncQwenConfigToVSCodeSettings();

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
   * Can be called from show() or via /auth command
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
            '[WebViewProvider] Authentication required, launching auth flow...',
          );
          this.sendMessageToWebView({
            type: 'authState',
            data: { authenticated: false },
          });
          // Initialize empty conversation to allow browsing history
          await this.initializeEmptyConversation();

          // Auto-launch the interactive auth flow (QuickPick → InputBox)
          // so the user is immediately guided to configure their provider,
          // mirroring CLI's behavior of showing AuthDialog on first run.
          // Deferred to avoid conflicting with the current connection init.
          // The timer is stored so startInteractiveAuth() can cancel it
          // to prevent two overlapping auth flows.
          this.autoAuthTimer = setTimeout(() => {
            this.autoAuthTimer = null;
            if (!this.authFlowActive) {
              this.authFlowActive = true;
              void this.messageHandler.route({ type: 'auth' }).finally(() => {
                this.authFlowActive = false;
              });
            }
          }, 100);
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
   * Handle auth interactive — interactive auth flow result.
   * Writes provider config to ~/.qwen/settings.json and reconnects.
   * Mirrors the CLI's `qwen auth coding-plan` / `qwen auth` flow.
   */
  private async handleAuthInteractive(
    provider: string,
    region?: string,
    apiKey?: string,
    baseUrl?: string,
    model?: string,
    modelIds?: string,
  ): Promise<void> {
    if (!apiKey) {
      this.sendMessageToWebView({
        type: 'authError',
        data: { message: 'API key is required.' },
      });
      return;
    }

    console.log(
      `[WebViewProvider] authInteractive: provider=${provider}, region=${region}, model=${model}`,
    );

    try {
      if (provider === 'coding-plan') {
        writeCodingPlanConfig(region === 'global' ? 'global' : 'china', apiKey);
      } else if (provider === 'alibaba-standard') {
        // Alibaba Standard — multiple models sharing the same base URL
        const modelBaseUrl =
          baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
        const ids = (modelIds || model || 'qwen3.5-plus')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const providers: Record<string, string> = {};
        for (const id of ids) {
          providers[id] = modelBaseUrl;
        }
        writeModelProvidersConfig({
          apiKey,
          modelProviders: providers,
          activeModel: ids[0] || 'qwen3.5-plus',
        });
      } else {
        // Custom API Key — single model entry
        const modelId = model || 'default';
        const modelBaseUrl = baseUrl || 'https://api.openai.com/v1';
        writeModelProvidersConfig({
          apiKey,
          modelProviders: { [modelId]: modelBaseUrl },
          activeModel: modelId,
        });
      }

      // Disconnect + reconnect
      if (this.agentInitialized) {
        try {
          this.agentManager.disconnect();
        } catch (e) {
          console.log('[WebViewProvider] Error disconnecting:', e);
        }
        this.agentInitialized = false;
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
      await this.doInitializeAgentConnection({ autoAuthenticate: false });

      // Only emit authSuccess when the reconnection actually authenticated.
      // doInitializeAgentConnection updates this.authState via sendMessageToWebView;
      // if credentials were rejected, authState will be false and we should not
      // claim success (which would briefly show a success toast then re-open auth).
      if (this.authState === true) {
        this.sendMessageToWebView({
          type: 'authSuccess',
          data: { message: 'Provider configured successfully!' },
        });
      } else {
        this.sendMessageToWebView({
          type: 'authError',
          data: {
            message:
              'Connection established but authentication failed. Please check your credentials.',
          },
        });
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error('[WebViewProvider] authInteractive failed:', error);
      this.sendMessageToWebView({
        type: 'authError',
        data: { message: `Configuration failed: ${errorMsg}` },
      });
    }
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
      case 'authSuccess':
        this.authState = true;
        break;
      case 'agentConnectionError':
      case 'authError':
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

    if (this.cachedAvailableCommands) {
      this.sendMessageToWebView({
        type: 'availableCommands',
        data: { commands: this.cachedAvailableCommands },
      });
    }

    if (this.cachedAvailableSkills !== null) {
      this.sendMessageToWebView({
        type: 'availableSkills',
        data: { skills: this.cachedAvailableSkills },
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
   * Send a copy command to the webview (triggered by native context menu).
   * The webview resolves the content and posts back a 'copyToClipboard' message.
   */
  sendCopyCommand(action: string): boolean {
    if (WebViewProvider.lastContextMenuProvider !== this) {
      return false;
    }
    const webview = this.getActiveWebview();
    if (!webview) {
      return false;
    }
    webview.postMessage({ type: 'copyCommand', data: { action } });
    return true;
  }

  /**
   * Handle common webview message types shared across all host contexts
   * (sidebar, new panel, restored panel). Returns true if the message was
   * fully handled and the caller should skip further processing.
   *
   * Note: the `sendMessage` branch resets notification timers as a
   * side effect but returns false so the message is still routed to
   * handlers. This avoids duplicating the reset across 3 call sites.
   */
  private async handleCommonWebviewMessage(
    message: { type: string; data?: unknown },
    webview: vscode.Webview,
  ): Promise<boolean> {
    if (message.type === 'openDiff' && this.isAutoMode()) {
      return true;
    }
    if (message.type === 'webviewReady') {
      this.handleWebviewReady();
      return true;
    }
    if (message.type === 'contextMenuTriggered') {
      WebViewProvider.lastContextMenuProvider = this;
      return true;
    }
    if (message.type === 'copyToClipboard') {
      const { text } = message.data as { text: string };
      await vscode.env.clipboard.writeText(text);
      return true;
    }
    if (message.type === 'resolveImagePaths') {
      this.handleResolveImagePaths(message.data, webview);
      return true;
    }
    if (await this.handleOpenInsightReportMessage(message)) {
      return true;
    }
    // Reset task timer and notification guard when user sends a new message.
    // Falls through (returns false) so the message is still routed to handlers.
    if (message.type === 'sendMessage') {
      this.agentStartTime = null;
      this.idleNotificationSent = false;
    }
    return false;
  }

  /** Update the tab-dot icon. Blue takes priority over orange. */
  private setTabDot(color: DotColor): void {
    const config = vscode.workspace.getConfiguration('qwen-code');
    if (!config.get<boolean>('dotIndicator', true)) {
      return;
    }
    // Blue takes priority; never downgrade from blue to orange.
    if (this.dotState === DotColor.Blue && color === DotColor.Orange) {
      return;
    }
    this.dotState = color;
    const panel = this.panelManager.getPanel();
    if (!panel) {
      // No-op in sidebar mode: WebviewView has no iconPath property.
      return;
    }
    panel.iconPath = vscode.Uri.joinPath(
      this.extensionUri,
      'assets',
      DOT_ICON[color],
    );
  }

  /** Clear the tab-dot icon, restoring the default icon. */
  private clearTabDot(): void {
    if (this.dotState === null) {
      return;
    }
    this.dotState = null;
    const panel = this.panelManager.getPanel();
    if (!panel) {
      return;
    }
    panel.iconPath = vscode.Uri.joinPath(
      this.extensionUri,
      'assets',
      DOT_ICON.default,
    );
  }

  /**
   * Play the user's system alert / notification sound.
   *
   * SECURITY: all arguments to execFile are hardcoded string literals.
   * Never interpolate user-supplied data into these arguments — execFile
   * bypasses the shell but PowerShell still interprets its -c argument.
   */
  private playNotificationSound(): void {
    const onError = (err: Error | null) => {
      if (err) {
        console.warn(
          '[WebViewProvider] Notification sound failed:',
          err.message,
        );
      }
    };
    if (process.platform === 'darwin') {
      execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], onError);
    } else if (process.platform === 'win32') {
      execFile(
        'powershell',
        ['-c', '[System.Media.SystemSounds]::Asterisk.Play()'],
        onError,
      );
    } else {
      // canberra-gtk-play is the most "native" option; fall back to paplay.
      execFile('canberra-gtk-play', ['--id=bell'], (err) => {
        if (err) {
          execFile(
            'paplay',
            ['/usr/share/sounds/freedesktop/stereo/complete.oga'],
            (paErr) => {
              if (paErr) {
                console.warn(
                  '[WebViewProvider] paplay fallback failed:',
                  paErr.message,
                );
              }
            },
          );
        }
      });
    }
  }

  /**
   * Show a VS Code notification with sound and a "Show" button that focuses
   * the Qwen Code panel (or sidebar view) when clicked.
   */
  private notifyUser(message: string): void {
    void vscode.window
      .showInformationMessage(`Qwen Code: ${message}`, 'Show')
      .then((action) => {
        if (action === 'Show') {
          const panel = this.panelManager.getPanel();
          if (panel) {
            panel.reveal();
          } else if (this.isViewHost) {
            // Sidebar / secondary bar — focus the view via its command.
            void vscode.commands.executeCommand('qwen-code.focusChat');
          }
        }
      });
    this.playNotificationSound();
  }

  /**
   * Whether the user can currently see the Qwen Code panel.
   * Only true when VS Code is the foreground app AND the panel tab is visible.
   * If either condition is false the user needs a notification.
   */
  private isUserWatchingPanel(): boolean {
    const panel = this.panelManager.getPanel();
    const panelVisible = panel?.visible ?? false;
    const windowFocused = vscode.window.state.focused;
    return windowFocused && panelVisible;
  }

  /** Whether the qwen-code.notifications setting is enabled. */
  private isNotificationsEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('qwen-code')
      .get<boolean>('notifications', true);
  }

  /** Called when the agent finishes a turn (authoritative end-of-task event). */
  private handleAgentIdle(): void {
    // Read agentStartTime but do NOT reset it here — multi-turn tasks fire
    // onEndTurn multiple times and resetting would lose the true start time.
    // It is reset when the user sends the next message (see onDidReceiveMessage).
    const startTime = this.agentStartTime;
    this.attentionNotified = false; // reset for next permission/question cycle

    const panel = this.panelManager.getPanel();
    const panelActive = panel?.active ?? false;

    // Show orange dot when the tab is not the active/focused editor.
    if (!panelActive) {
      this.setTabDot(DotColor.Orange);
    }

    // System notification.
    if (!this.isNotificationsEnabled()) {
      return;
    }

    const userWatching = this.isUserWatchingPanel();
    const taskDurationMs = startTime !== null ? Date.now() - startTime : 0;

    if (
      !userWatching &&
      taskDurationMs >= LONG_TASK_THRESHOLD_MS &&
      !this.idleNotificationSent
    ) {
      this.idleNotificationSent = true;
      this.notifyUser('Waiting for your input.');
    }
  }

  /**
   * Called when the agent needs user attention (permission request or ask-question).
   * @param detail - optional context, e.g. the tool name that needs approval.
   */
  private handleAgentNeedsAttention(detail?: string): void {
    const panel = this.panelManager.getPanel();
    const panelActive = panel?.active ?? false;

    if (!panelActive) {
      this.setTabDot(DotColor.Blue);
    }

    const userWatching = this.isUserWatchingPanel();

    // Notify once per request regardless of task duration.
    if (!userWatching && !this.attentionNotified) {
      this.attentionNotified = true;
      if (this.isNotificationsEnabled()) {
        const message = detail
          ? `Needs your permission to use ${detail}.`
          : 'Waiting for your input.';
        this.notifyUser(message);
      }
    }
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

    // Ensure restored tab starts from default label and icon
    this.dotState = null;
    try {
      panel.title = 'Qwen Code';
      panel.iconPath = vscode.Uri.joinPath(
        this.extensionUri,
        'assets',
        DOT_ICON.default,
      );
    } catch (e) {
      console.warn(
        '[WebViewProvider] Failed to reset restored panel title/icon:',
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
        if (await this.handleCommonWebviewMessage(message, panel.webview)) {
          return;
        }
        if (message.type === 'updatePanelTitle') {
          const title = String(
            (message.data as { title?: unknown } | undefined)?.title ?? '',
          ).trim();
          const panelRef = this.panelManager.getPanel();
          if (panelRef) {
            panelRef.title = title ? truncatePanelTitle(title) : 'Qwen Code';
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

    // Clear the tab dot when the user switches to this restored panel.
    panel.onDidChangeViewState(
      () => {
        if (panel.visible) {
          this.clearTabDot();
        }
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
    if (WebViewProvider.lastContextMenuProvider === this) {
      WebViewProvider.lastContextMenuProvider = null;
    }
    this.panelManager.dispose();
    this.agentManager.disconnect();
    this.disposables.forEach((d) => d.dispose());
  }
}
