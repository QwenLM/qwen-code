/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { BaseMessageHandler } from './BaseMessageHandler.js';
import type { ChatMessage } from '../../services/qwenAgentManager.js';
import type { Conversation } from '../../services/conversationStore.js';
import type { ImageAttachment } from '../../utils/imageSupport.js';
import type { ApprovalModeValue } from '../../types/approvalModeValueTypes.js';
import {
  processImageAttachments,
  buildPromptBlocks,
} from '../utils/imageHandler.js';
import { isAuthenticationRequiredError } from '../../utils/authErrors.js';
import { getErrorMessage } from '../../utils/errorMessage.js';
import { stripZeroWidthSpaces } from '@qwen-code/webui';
import {
  exportSessionToFile,
  parseExportSlashCommand,
  type SessionExportFormat,
} from '../../services/sessionExportService.js';
import {
  DISCONTINUED_MESSAGES,
  isDiscontinuedModel,
} from '../utils/discontinuedModel.js';

function formatExportSuccessMessage(
  formatLabel: string,
  filename: string,
  filePath: string,
): string {
  const markdownLinkPath = vscode.Uri.file(filePath).toString();
  return `Session exported to ${formatLabel}: [${filename}](${markdownLinkPath})`;
}

/**
 * Session message handler
 * Handles all session-related messages
 */
export class SessionMessageHandler extends BaseMessageHandler {
  private currentStreamContent = '';
  private authHandler: (() => Promise<void>) | null = null;
  private isTitleSet = false; // Flag to track if title has been set

  canHandle(messageType: string): boolean {
    return [
      'sendMessage',
      'editMessage',
      'newQwenSession',
      'switchQwenSession',
      'getQwenSessions',
      'resumeSession',
      'deleteQwenSession',
      'renameQwenSession',
      'cancelStreaming',
      // UI action: open a new chat tab (new WebviewPanel)
      'openNewChatTab',
      // Settings-related messages
      'setApprovalMode',
      'setModel',
    ].includes(messageType);
  }

  /**
   * Set auth handler
   */
  setAuthHandler(handler: () => Promise<void>): void {
    this.authHandler = handler;
  }

  async handle(message: { type: string; data?: unknown }): Promise<void> {
    const data = message.data as Record<string, unknown> | undefined;

    switch (message.type) {
      case 'sendMessage':
        await this.handleSendMessage(
          (data?.text as string) || '',
          data?.context as
            | Array<{
                type: string;
                name: string;
                value: string;
                startLine?: number;
                endLine?: number;
              }>
            | undefined,
          data?.fileContext as
            | {
                fileName: string;
                filePath: string;
                startLine?: number;
                endLine?: number;
              }
            | undefined,
          data?.attachments as ImageAttachment[] | undefined,
        );
        break;

      case 'editMessage':
        await this.handleSendMessage(
          (data?.text as string) || '',
          data?.context as
            | Array<{
                type: string;
                name: string;
                value: string;
                startLine?: number;
                endLine?: number;
              }>
            | undefined,
          data?.fileContext as
            | {
                fileName: string;
                filePath: string;
                startLine?: number;
                endLine?: number;
              }
            | undefined,
          data?.attachments as ImageAttachment[] | undefined,
          typeof data?.targetTurnIndex === 'number'
            ? data.targetTurnIndex
            : undefined,
        );
        break;

      case 'newQwenSession':
        await this.handleNewQwenSession();
        break;

      case 'switchQwenSession':
        await this.handleSwitchQwenSession((data?.sessionId as string) || '');
        break;

      case 'getQwenSessions':
        await this.handleGetQwenSessions(
          (data?.cursor as number | undefined) ?? undefined,
          (data?.size as number | undefined) ?? undefined,
        );
        break;

      case 'resumeSession':
        await this.handleResumeSession((data?.sessionId as string) || '');
        break;

      case 'deleteQwenSession':
        await this.handleDeleteQwenSession((data?.sessionId as string) || '');
        break;

      case 'renameQwenSession':
        await this.handleRenameQwenSession(
          (data?.sessionId as string) || '',
          (data?.title as string) || '',
        );
        break;

      case 'openNewChatTab':
        // Open a brand new chat tab (WebviewPanel) via the extension command
        // This does not alter the current conversation in this tab; the new tab
        // will initialize its own state and (optionally) create a new session.
        try {
          const modelId =
            typeof data?.modelId === 'string' && data.modelId.trim().length > 0
              ? data.modelId.trim()
              : undefined;
          await vscode.commands.executeCommand('qwenCode.openNewChatTab', {
            initialModelId: modelId,
          });
        } catch (error) {
          console.error(
            '[SessionMessageHandler] Failed to open new chat tab:',
            error,
          );
          const errorMsg = this.getErrorMessage(error);
          this.sendToWebView({
            type: 'error',
            data: { message: `Failed to open new chat tab: ${errorMsg}` },
          });
        }
        break;

      case 'cancelStreaming':
        // Handle cancel streaming request from webview
        await this.handleCancelStreaming();
        break;

      case 'setApprovalMode':
        await this.handleSetApprovalMode(
          message.data as {
            modeId?: ApprovalModeValue;
          },
        );
        break;

      case 'setModel':
        await this.handleSetModel(
          message.data as {
            modelId?: string;
          },
        );
        break;

      default:
        console.warn(
          '[SessionMessageHandler] Unknown message type:',
          message.type,
        );
        break;
    }
  }

  /**
   * Get current stream content
   */
  getCurrentStreamContent(): string {
    return this.currentStreamContent;
  }

  /**
   * Append stream content
   */
  appendStreamContent(chunk: string): void {
    this.currentStreamContent += chunk;
  }

  /**
   * Reset stream content
   */
  resetStreamContent(): void {
    this.currentStreamContent = '';
  }

  private async captureConversationSnapshot(
    conversationId: string | null,
  ): Promise<Conversation | null> {
    if (!conversationId) {
      return null;
    }

    const conversation =
      await this.conversationStore.getConversation(conversationId);
    if (conversation) {
      return {
        ...conversation,
        messages: conversation.messages.map((message) => ({ ...message })),
      };
    }

    const getSessionMessages = (
      this.agentManager as {
        getSessionMessages?: (sessionId: string) => Promise<ChatMessage[]>;
      }
    ).getSessionMessages;
    if (!getSessionMessages) {
      return null;
    }

    const messages = await getSessionMessages.call(
      this.agentManager,
      conversationId,
    );
    if (messages.length === 0) {
      return null;
    }

    const timestamps = messages.map((message) => message.timestamp);
    const recoveredConversation: Conversation = {
      id: conversationId,
      title: messages.find((message) => message.role === 'user')?.content ?? '',
      messages: messages.map((message) => ({ ...message })),
      createdAt: Math.min(...timestamps),
      updatedAt: Math.max(...timestamps),
    };
    await this.conversationStore.upsertConversation(recoveredConversation);

    return recoveredConversation;
  }

  private async restoreConversationSnapshot(
    snapshot: Conversation | null,
  ): Promise<void> {
    if (!snapshot) {
      return;
    }

    const restored = await this.conversationStore.replaceMessages(
      snapshot.id,
      snapshot.messages,
    );
    if (!restored) {
      console.warn(
        '[SessionMessageHandler] Failed to restore conversation snapshot; conversation not found:',
        snapshot.id,
      );
    }
    this.updateCurrentConversationId(snapshot.id);
    this.sendToWebView({
      type: 'conversationLoaded',
      data: snapshot,
    });
  }

  /**
   * Monotonically increasing request counter used to tag streamStart/streamEnd
   * so the WebView can detect and discard stale events from previous requests.
   */
  private requestCounter = 0;
  private currentRequestId: string | null = null;
  private streamEndSent = false;

  /**
   * Notify the webview that streaming has finished.
   * Includes the `requestId` so the webview can ignore stale events.
   * Guarded by `streamEndSent` to prevent duplicate streamEnd for the
   * same request (e.g. cancel handler + error handler both sending one).
   *
   * @param reason  Optional reason string (e.g. 'user_cancelled').
   * @param forRequestId  When provided, the call is scoped to a specific
   *   request invocation.  If a newer request has since overwritten
   *   `this.currentRequestId`, the call is silently dropped — this
   *   prevents a stale `handleSendMessage` invocation (resumed after
   *   cancellation) from emitting a streamEnd tagged as the newer request.
   */
  private sendStreamEnd(reason?: string, forRequestId?: string): void {
    if (this.streamEndSent) {
      return;
    }
    // If the caller captured a request ID, only proceed when it still
    // matches the active request.  A mismatch means a newer request has
    // taken over the shared state; emitting now would incorrectly tag
    // the event with the newer request's ID.
    if (forRequestId && this.currentRequestId !== forRequestId) {
      return;
    }
    this.streamEndSent = true;

    const data: { timestamp: number; reason?: string; requestId?: string } = {
      timestamp: Date.now(),
    };

    if (reason) {
      data.reason = reason;
    }
    if (this.currentRequestId) {
      data.requestId = this.currentRequestId;
    }

    this.sendToWebView({
      type: 'streamEnd',
      data,
    });
  }

  /**
   * Prompt user to authenticate and invoke the registered auth handler/command.
   * Returns true if authentication was initiated.
   */
  private async promptAuth(message: string): Promise<boolean> {
    const result = await vscode.window.showWarningMessage(message, 'Configure');
    if (result === 'Configure') {
      if (this.authHandler) {
        await this.authHandler();
      } else {
        await vscode.commands.executeCommand('qwen-code.auth');
      }
      return true;
    }
    return false;
  }

  /**
   * Prompt user to authenticate or view offline. Returns 'auth', 'offline', or 'dismiss'.
   * When configure is chosen, it triggers the auth handler/command.
   */
  private async promptAuthOrOffline(
    message: string,
  ): Promise<'auth' | 'offline' | 'dismiss'> {
    const selection = await vscode.window.showWarningMessage(
      message,
      'Configure',
      'View Offline',
    );

    if (selection === 'Configure') {
      if (this.authHandler) {
        await this.authHandler();
      } else {
        await vscode.commands.executeCommand('qwen-code.auth');
      }
      return 'auth';
    }
    if (selection === 'View Offline') {
      return 'offline';
    }
    return 'dismiss';
  }

  private getErrorMessage(error: unknown): string {
    return getErrorMessage(error);
  }

  private shouldPromptAuth(error: unknown): boolean {
    return isAuthenticationRequiredError(error);
  }

  private async resolveSessionWorkingDir(sessionId: string): Promise<string> {
    try {
      const sessions = await this.agentManager.getSessionList();
      const match = sessions.find(
        (session) =>
          session.sessionId === sessionId || session.id === sessionId,
      );
      if (typeof match?.cwd === 'string' && match.cwd.length > 0) {
        return match.cwd;
      }
    } catch (error) {
      console.warn(
        '[SessionMessageHandler] Failed to resolve export session cwd:',
        error,
      );
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder?.uri.fsPath || process.cwd();
  }

  private async handleExportCommand(
    format: SessionExportFormat,
  ): Promise<void> {
    // Prefer the active ACP session id. The local conversation id may still be
    // a webview-only `conv_*` placeholder after starting a fresh session.
    const sessionId =
      this.agentManager.currentSessionId ?? this.currentConversationId;
    if (!sessionId) {
      const errorMsg = 'No active session found to export.';
      this.sendToWebView({
        type: 'error',
        data: { message: errorMsg },
      });
      return;
    }

    try {
      const cwd = await this.resolveSessionWorkingDir(sessionId);
      const result = await exportSessionToFile({ sessionId, cwd, format });
      if (!result) {
        // User cancelled the save dialog
        return;
      }
      const formatLabel = format.toUpperCase();
      this.sendToWebView({
        type: 'message',
        data: {
          role: 'assistant',
          content: formatExportSuccessMessage(
            formatLabel,
            result.filename,
            result.uri.fsPath,
          ),
          timestamp: Date.now(),
        },
      });
    } catch (error) {
      const errorMsg = this.getErrorMessage(error);
      console.error('[SessionMessageHandler] Failed to export session:', error);
      this.sendToWebView({
        type: 'error',
        data: { message: `Failed to export session: ${errorMsg}` },
      });
    }
  }

  /**
   * Handle send message request
   */
  private async handleSendMessage(
    text: string,
    context?: Array<{
      type: string;
      name: string;
      value: string;
      startLine?: number;
      endLine?: number;
    }>,
    fileContext?: {
      fileName: string;
      filePath: string;
      startLine?: number;
      endLine?: number;
    },
    attachments?: ImageAttachment[],
    editTargetTurnIndex?: number,
  ): Promise<void> {
    console.log('[SessionMessageHandler] handleSendMessage called with:', text);
    // Guard: do not process empty or whitespace-only messages.
    // This prevents ghost user-message bubbles when slash-command completions
    // or model-selector interactions clear the input but still trigger a submit.
    const trimmedText = stripZeroWidthSpaces(text).trim();
    const hasAttachments = (attachments?.length ?? 0) > 0;
    if (!trimmedText && !hasAttachments) {
      console.warn('[SessionMessageHandler] Ignoring empty message');
      return;
    }

    try {
      const exportFormat = parseExportSlashCommand(trimmedText);
      if (exportFormat) {
        await this.handleExportCommand(exportFormat);
        return;
      }
    } catch (error) {
      const errorMsg = this.getErrorMessage(error);
      this.sendToWebView({
        type: 'error',
        data: { message: errorMsg },
      });
      return;
    }

    let displayText = trimmedText ? text : '';
    let promptText = text;
    if (context && context.length > 0) {
      const contextParts = context
        .map((ctx) => {
          if (ctx.startLine && ctx.endLine) {
            return `${ctx.value}#${ctx.startLine}${ctx.startLine !== ctx.endLine ? `-${ctx.endLine}` : ''}`;
          }
          return ctx.value;
        })
        .join('\n');

      promptText = `${contextParts}\n\n${text}`;
    }

    const {
      formattedText,
      displayText: updatedDisplayText,
      savedImageCount,
      promptImages,
    } = await processImageAttachments(promptText, attachments);
    promptText = formattedText;
    displayText = updatedDisplayText;

    if (hasAttachments && !trimmedText && savedImageCount === 0) {
      const errorMsg =
        'Failed to attach the pasted image. Nothing was sent. Please paste the image again.';
      console.warn('[SessionMessageHandler]', errorMsg);
      vscode.window.showErrorMessage(errorMsg);
      this.sendToWebView({
        type: 'error',
        data: { message: errorMsg },
      });
      return;
    }

    // Ensure we have an active conversation
    if (!this.currentConversationId) {
      console.log(
        '[SessionMessageHandler] No active conversation, creating one...',
      );
      try {
        const newConv = await this.conversationStore.createConversation();
        this.updateCurrentConversationId(newConv.id);
        this.sendToWebView({
          type: 'conversationLoaded',
          data: newConv,
        });
      } catch (error) {
        const errorMsg = `Failed to create conversation: ${this.getErrorMessage(error)}`;
        console.error('[SessionMessageHandler]', errorMsg);
        vscode.window.showErrorMessage(errorMsg);
        this.sendToWebView({
          type: 'error',
          data: { message: errorMsg },
        });
        return;
      }
    }

    if (!this.currentConversationId) {
      const errorMsg =
        'Failed to create conversation. Please restart the extension.';
      console.error('[SessionMessageHandler]', errorMsg);
      vscode.window.showErrorMessage(errorMsg);
      this.sendToWebView({
        type: 'error',
        data: { message: errorMsg },
      });
      return;
    }

    let editRestoreSnapshot: Conversation | null = null;
    let editStoreMutationApplied = false;
    let editAcpMutationApplied = false;
    let editAcpHistorySnapshot: unknown[] | null = null;

    if (editTargetTurnIndex !== undefined) {
      if (!Number.isInteger(editTargetTurnIndex) || editTargetTurnIndex < 0) {
        const errorMsg = 'Invalid message edit target.';
        console.error('[SessionMessageHandler]', errorMsg, editTargetTurnIndex);
        this.sendToWebView({
          type: 'error',
          data: { message: errorMsg },
        });
        return;
      }

      if (!this.agentManager.isConnected) {
        await this.promptAuth(
          'You need to configure your provider to use Qwen Code.',
        );
        return;
      }

      if (!this.agentManager.currentSessionId) {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
          await this.agentManager.createNewSession(workingDir);
        } catch (createErr) {
          console.error(
            '[SessionMessageHandler] Failed to create session before editing message:',
            createErr,
          );
          const errorMsg = this.getErrorMessage(createErr);
          if (this.shouldPromptAuth(createErr)) {
            await this.promptAuth(
              'Your session has expired or is invalid. Please configure your provider to continue using Qwen Code.',
            );
            return;
          }
          vscode.window.showErrorMessage(
            `Failed to create session: ${errorMsg}`,
          );
          return;
        }
      }

      try {
        editRestoreSnapshot = await this.captureConversationSnapshot(
          this.currentConversationId,
        );
      } catch (error) {
        console.error(
          '[SessionMessageHandler] Failed to capture edit restore snapshot:',
          error,
        );
        const errorMsg = this.getErrorMessage(error);
        vscode.window.showErrorMessage(`Failed to edit message: ${errorMsg}`);
        this.sendToWebView({
          type: 'error',
          data: { message: errorMsg },
        });
        return;
      }

      if (!editRestoreSnapshot) {
        console.warn(
          '[SessionMessageHandler] Local conversation snapshot missing before edit; continuing with ACP rewind only.',
        );
      }

      try {
        if (editRestoreSnapshot) {
          const truncated = await this.conversationStore.truncateFromUserTurn(
            this.currentConversationId,
            editTargetTurnIndex,
          );
          if (!truncated) {
            throw new Error('Conversation not found for edit target.');
          }
          editStoreMutationApplied = true;
        }

        const rewindResult =
          await this.agentManager.rewindSession(editTargetTurnIndex);
        editAcpHistorySnapshot = rewindResult?.historyBeforeRewind ?? null;
        editAcpMutationApplied = true;

        this.sendToWebView({
          type: 'conversationRewound',
          data: { targetTurnIndex: editTargetTurnIndex },
        });
      } catch (error) {
        if (editAcpMutationApplied && editAcpHistorySnapshot) {
          try {
            await this.agentManager.restoreSessionHistory(
              editAcpHistorySnapshot,
            );
          } catch (restoreError) {
            console.warn(
              '[SessionMessageHandler] Failed to restore ACP history after rewind failure:',
              restoreError,
            );
          }
        }
        if (editStoreMutationApplied) {
          await this.restoreConversationSnapshot(editRestoreSnapshot);
        }
        const errorMsg = this.getErrorMessage(error);
        console.error(
          '[SessionMessageHandler] Failed to rewind session:',
          error,
        );
        vscode.window.showErrorMessage(`Failed to edit message: ${errorMsg}`);
        this.sendToWebView({
          type: 'error',
          data: { message: errorMsg },
        });
        return;
      }
    }

    // Check if this is the first message
    let isFirstMessage = false;
    if (editTargetTurnIndex !== undefined) {
      isFirstMessage = editTargetTurnIndex === 0;
    } else {
      try {
        const conversation = await this.conversationStore.getConversation(
          this.currentConversationId,
        );
        isFirstMessage = !conversation || conversation.messages.length === 0;
      } catch (error) {
        console.error(
          '[SessionMessageHandler] Failed to check conversation:',
          error,
        );
      }
    }

    // Generate title for first message, but only if it hasn't been set yet
    if (isFirstMessage && !this.isTitleSet) {
      this.sendToWebView({
        type: 'sessionTitleUpdated',
        data: {
          sessionId: this.currentConversationId,
          title: displayText,
        },
      });
      this.isTitleSet = true; // Mark title as set
    }

    // Save user message
    const userMessage: ChatMessage = {
      role: 'user',
      content: displayText,
      timestamp: Date.now(),
    };

    try {
      await this.conversationStore.addMessage(
        this.currentConversationId,
        userMessage,
      );
    } catch (error) {
      console.error(
        '[SessionMessageHandler] Failed to save user message:',
        error,
      );

      if (editAcpMutationApplied && editAcpHistorySnapshot) {
        try {
          await this.agentManager.restoreSessionHistory(editAcpHistorySnapshot);
        } catch (restoreError) {
          console.warn(
            '[SessionMessageHandler] Failed to restore ACP history after user message save failure:',
            restoreError,
          );
        }
      }

      if (editStoreMutationApplied) {
        await this.restoreConversationSnapshot(editRestoreSnapshot);
      }

      const errorMsg = this.getErrorMessage(error);
      vscode.window.showErrorMessage(`Failed to edit message: ${errorMsg}`);
      this.sendToWebView({
        type: 'error',
        data: { message: errorMsg },
      });
      return;
    }

    this.sendToWebView({
      type: 'message',
      data: { ...userMessage, fileContext },
    });

    // Check if agent is connected
    if (!this.agentManager.isConnected) {
      console.warn('[SessionMessageHandler] Agent not connected');

      // Show non-modal notification with Configure button
      await this.promptAuth(
        'You need to configure your provider to use Qwen Code.',
      );
      return;
    }

    // Ensure an ACP session exists before sending prompt
    if (!this.agentManager.currentSessionId) {
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
        await this.agentManager.createNewSession(workingDir);
      } catch (createErr) {
        console.error(
          '[SessionMessageHandler] Failed to create session before sending message:',
          createErr,
        );
        const errorMsg = this.getErrorMessage(createErr);
        if (this.shouldPromptAuth(createErr)) {
          await this.promptAuth(
            'Your session has expired or is invalid. Please configure your provider to continue using Qwen Code.',
          );
          return;
        }
        vscode.window.showErrorMessage(`Failed to create session: ${errorMsg}`);
        return;
      }
    }

    // Send to agent
    //
    // Generate a unique requestId so the webview can correlate
    // streamStart/streamEnd and discard stale events.
    this.requestCounter += 1;
    this.currentRequestId = `req-${this.requestCounter}-${Date.now()}`;
    this.streamEndSent = false;

    // Capture locally so that if a newer handleSendMessage() overwrites
    // the shared fields while we are awaiting, our sendStreamEnd calls
    // will detect the mismatch and silently no-op instead of emitting
    // a streamEnd tagged with the newer request's ID.
    const myRequestId = this.currentRequestId;

    try {
      this.resetStreamContent();

      this.sendToWebView({
        type: 'streamStart',
        data: {
          timestamp: Date.now(),
          requestId: myRequestId,
        },
      });

      await this.agentManager.sendMessage(
        buildPromptBlocks(promptText, promptImages),
      );

      // Save assistant message
      if (this.currentStreamContent && this.currentConversationId) {
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: this.currentStreamContent,
          timestamp: Date.now(),
        };
        await this.conversationStore.addMessage(
          this.currentConversationId,
          assistantMessage,
        );
      }

      this.sendStreamEnd(undefined, myRequestId);

      // After first message, sync ACP session ID to webview for session list highlighting
      const acpSessionId = this.agentManager.currentSessionId;
      if (acpSessionId && acpSessionId !== this.currentConversationId) {
        const previousConversationId = this.currentConversationId;
        if (previousConversationId) {
          const renamed = await this.conversationStore.renameConversationId(
            previousConversationId,
            acpSessionId,
          );
          if (!renamed) {
            console.warn(
              '[SessionMessageHandler] Failed to align conversation store with ACP session id:',
              previousConversationId,
              acpSessionId,
            );
            return;
          }
        }
        this.updateCurrentConversationId(acpSessionId);
        this.sendToWebView({
          type: 'sessionTitleUpdated',
          data: {
            sessionId: acpSessionId,
            title:
              displayText.substring(0, 50) +
              (displayText.length > 50 ? '...' : ''),
          },
        });
      }
    } catch (error) {
      console.error('[SessionMessageHandler] Error sending message:', error);

      if (editAcpMutationApplied && editAcpHistorySnapshot) {
        try {
          await this.agentManager.restoreSessionHistory(editAcpHistorySnapshot);
        } catch (restoreError) {
          console.warn(
            '[SessionMessageHandler] Failed to restore ACP history after send failure:',
            restoreError,
          );
        }
      }

      if (editStoreMutationApplied) {
        await this.restoreConversationSnapshot(editRestoreSnapshot);
      }

      const err = error as unknown as Error;
      // Safely convert error to string
      const errorMsg = this.getErrorMessage(error);
      const lower = errorMsg.toLowerCase();

      // Suppress user-cancelled/aborted errors (ESC/Stop button)
      const isAbortLike =
        (err && (err as Error).name === 'AbortError') ||
        lower.includes('abort') ||
        lower.includes('aborted') ||
        lower.includes('request was aborted') ||
        lower.includes('canceled') ||
        lower.includes('cancelled') ||
        lower.includes('user_cancelled');

      if (isAbortLike) {
        // Do not show VS Code error popup for intentional cancellations.
        // Ensure the webview knows the stream ended due to user action.
        this.sendStreamEnd('user_cancelled', myRequestId);
        return;
      }
      // Check for session not found error and handle it appropriately
      if (
        errorMsg.includes('Session not found') ||
        this.shouldPromptAuth(error)
      ) {
        // Show a more user-friendly error message for expired sessions
        await this.promptAuth(
          'Your session has expired or is invalid. Please configure your provider to continue using Qwen Code.',
        );

        // Send a specific error to the webview for better UI handling
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired. Please authenticate again.' },
        });
        this.sendStreamEnd('session_expired', myRequestId);
      } else {
        const isTimeoutError =
          lower.includes('timeout') || lower.includes('timed out');
        if (isTimeoutError) {
          // Note: session_prompt no longer has a timeout, so this should rarely occur
          // This path may still be hit for other methods (initialize, etc.) or network-level timeouts
          console.warn(
            '[SessionMessageHandler] Request timed out; suppressing popup',
          );

          const timeoutMessage: ChatMessage = {
            role: 'assistant',
            content:
              'Request timed out. This may be due to a network issue. Please try again.',
            timestamp: Date.now(),
          };

          // Send a timeout message to the WebView
          this.sendToWebView({
            type: 'message',
            data: timeoutMessage,
          });
          this.sendStreamEnd('timeout', myRequestId);
        } else {
          // Handling of Non-Timeout Errors
          vscode.window.showErrorMessage(`Error sending message: ${errorMsg}`);
          this.sendToWebView({
            type: 'error',
            data: { message: errorMsg },
          });
          this.sendStreamEnd('error', myRequestId);
        }
      }
    }
  }

  /**
   * Handle new Qwen session request
   */
  private async handleNewQwenSession(): Promise<void> {
    try {
      console.log('[SessionMessageHandler] Creating new Qwen session...');

      // Ensure connection (auth) before creating a new session
      if (!this.agentManager.isConnected) {
        const proceeded = await this.promptAuth(
          'You need to configure your provider before creating a new session.',
        );
        if (!proceeded) {
          return;
        }
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      await this.agentManager.createNewSession(workingDir, { forceNew: true });
      this.updateCurrentConversationId(null);

      this.sendToWebView({
        type: 'conversationCleared',
        data: {},
      });

      // Reset title flag when creating a new session
      this.isTitleSet = false;
    } catch (error) {
      console.error(
        '[SessionMessageHandler] Failed to create new session:',
        error,
      );

      // Safely convert error to string
      const errorMsg = this.getErrorMessage(error);
      // Check for authentication/session expiration errors
      if (this.shouldPromptAuth(error)) {
        // Show a more user-friendly error message for expired sessions
        await this.promptAuth(
          'Your session has expired or is invalid. Please configure your provider to create a new session.',
        );

        // Send a specific error to the webview for better UI handling
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired. Please authenticate again.' },
        });
      } else {
        this.sendToWebView({
          type: 'error',
          data: { message: `Failed to create new session: ${errorMsg}` },
        });
      }
    }
  }

  /**
   * Handle switch Qwen session request
   */
  private async handleSwitchQwenSession(sessionId: string): Promise<void> {
    try {
      console.log('[SessionMessageHandler] Switching to session:', sessionId);

      // If not connected yet, offer to authenticate or view offline
      if (!this.agentManager.isConnected) {
        const choice = await this.promptAuthOrOffline(
          'You are not authenticated. Configure your provider to fully restore this session, or view it offline.',
        );

        if (choice === 'offline') {
          // Show messages from local cache only
          const messages =
            await this.agentManager.getSessionMessages(sessionId);
          this.updateCurrentConversationId(sessionId);
          this.sendToWebView({
            type: 'qwenSessionSwitched',
            data: { sessionId, messages },
          });
          this.sendToWebView({
            type: 'sessionLoadComplete',
            data: { sessionId },
          });
          vscode.window.showInformationMessage(
            'Showing cached session content. Configure your provider to interact with the AI.',
          );
          return;
        } else if (choice !== 'auth') {
          // User dismissed; clear loading state
          this.sendToWebView({
            type: 'sessionLoadComplete',
            data: { sessionId },
          });
          return;
        }
      }

      // Get session details (includes cwd and filePath when using ACP)
      let sessionDetails: Record<string, unknown> | null = null;
      try {
        const allSessions = await this.agentManager.getSessionList();
        sessionDetails =
          allSessions.find(
            (s: { id?: string; sessionId?: string }) =>
              s.id === sessionId || s.sessionId === sessionId,
          ) || null;
      } catch (err) {
        console.log(
          '[SessionMessageHandler] Could not get session details:',
          err,
        );
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      // Try to load session via ACP (now we should be connected)
      try {
        // Set current id and clear UI first so replayed updates append afterwards
        this.updateCurrentConversationId(sessionId);
        this.sendToWebView({
          type: 'qwenSessionSwitched',
          data: { sessionId, messages: [], session: sessionDetails },
        });

        const loadResponse = await this.agentManager.loadSessionViaAcp(
          sessionId,
          (sessionDetails?.cwd as string | undefined) || undefined,
        );
        console.log(
          '[SessionMessageHandler] session/load succeeded (per ACP spec result is null; actual history comes via session/update):',
          loadResponse,
        );

        // Reset title flag when switching sessions
        this.isTitleSet = false;

        // Notify webview that session history has finished loading
        this.sendToWebView({
          type: 'sessionLoadComplete',
          data: { sessionId },
        });

        // Successfully loaded session, return early to avoid fallback logic
        return;
      } catch (loadError) {
        console.warn(
          '[SessionMessageHandler] session/load failed, using fallback:',
          loadError,
        );

        // Check for authentication/session expiration errors
        if (this.shouldPromptAuth(loadError)) {
          // Show a more user-friendly error message for expired sessions
          await this.promptAuth(
            'Your session has expired or is invalid. Please configure your provider to switch sessions.',
          );

          // Send a specific error to the webview for better UI handling
          this.sendToWebView({
            type: 'sessionExpired',
            data: { message: 'Session expired. Please authenticate again.' },
          });
          return;
        }

        // Fallback: create new session
        const messages = await this.agentManager.getSessionMessages(sessionId);

        // If we are connected, try to create a fresh ACP session so user can interact
        if (this.agentManager.isConnected) {
          try {
            await this.agentManager.createNewSession(workingDir, {
              forceNew: true,
            });

            // Keep the viewed session identity aligned with what the webview sees
            // (the archived sessionId). The live ACP session lives on
            // agentManager.currentSessionId; the sync-on-first-message path
            // (see streamEnd handler) will flip both sides to the ACP id once
            // the user actually sends a message. Setting currentConversationId
            // to the new ACP id here would desync the backend from the webview
            // and cause rename/delete/title-update flows to target the wrong
            // session during the fallback window.
            this.updateCurrentConversationId(sessionId);

            this.sendToWebView({
              type: 'qwenSessionSwitched',
              data: { sessionId, messages, session: sessionDetails },
            });
            this.sendToWebView({
              type: 'sessionLoadComplete',
              data: { sessionId },
            });

            // Only show the cache warning if we actually fell back to local cache
            // and didn't successfully load via ACP
            // Check if we truly fell back by checking if loadError is not null/undefined
            // and if it's not a successful response that looks like an error
            if (
              loadError &&
              typeof loadError === 'object' &&
              !('result' in loadError)
            ) {
              vscode.window.showWarningMessage(
                'Session restored from local cache. Some context may be incomplete.',
              );
            }
          } catch (createError) {
            console.error(
              '[SessionMessageHandler] Failed to create session:',
              createError,
            );

            // Check for authentication/session expiration errors in session creation
            if (this.shouldPromptAuth(createError)) {
              // Show a more user-friendly error message for expired sessions
              await this.promptAuth(
                'Your session has expired or is invalid. Please configure your provider to switch sessions.',
              );

              // Send a specific error to the webview for better UI handling
              this.sendToWebView({
                type: 'sessionExpired',
                data: {
                  message: 'Session expired. Please authenticate again.',
                },
              });
              return;
            }

            throw createError;
          }
        } else {
          // Offline view only
          this.updateCurrentConversationId(sessionId);
          this.sendToWebView({
            type: 'qwenSessionSwitched',
            data: { sessionId, messages, session: sessionDetails },
          });
          this.sendToWebView({
            type: 'sessionLoadComplete',
            data: { sessionId },
          });
          vscode.window.showWarningMessage(
            'Showing cached session content. Configure your provider to interact with the AI.',
          );
        }
      }
    } catch (error) {
      console.error('[SessionMessageHandler] Failed to switch session:', error);

      // Safely convert error to string
      const errorMsg = this.getErrorMessage(error);
      // Check for authentication/session expiration errors
      if (this.shouldPromptAuth(error)) {
        // Show a more user-friendly error message for expired sessions
        await this.promptAuth(
          'Your session has expired or is invalid. Please configure your provider to switch sessions.',
        );

        // Send a specific error to the webview for better UI handling
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired. Please authenticate again.' },
        });
      } else {
        this.sendToWebView({
          type: 'error',
          data: { message: `Failed to switch session: ${errorMsg}` },
        });
      }
    }
  }

  /**
   * Handle get Qwen sessions request
   */
  private async handleGetQwenSessions(
    cursor?: number,
    size?: number,
  ): Promise<void> {
    try {
      // Paged when possible; falls back to full list if ACP not supported
      const page = await this.agentManager.getSessionListPaged({
        cursor,
        size,
      });
      const append = typeof cursor === 'number';
      this.sendToWebView({
        type: 'qwenSessionList',
        data: {
          sessions: page.sessions,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          append,
        },
      });
    } catch (error) {
      console.error('[SessionMessageHandler] Failed to get sessions:', error);

      // Safely convert error to string
      const errorMsg = this.getErrorMessage(error);
      // Check for authentication/session expiration errors
      if (this.shouldPromptAuth(error)) {
        // Show a more user-friendly error message for expired sessions
        await this.promptAuth(
          'Your session has expired or is invalid. Please configure your provider to view sessions.',
        );

        // Send a specific error to the webview for better UI handling
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired. Please authenticate again.' },
        });
      } else {
        this.sendToWebView({
          type: 'error',
          data: { message: `Failed to get sessions: ${errorMsg}` },
        });
      }
    }
  }

  /**
   * Handle cancel streaming request
   */
  private async handleCancelStreaming(): Promise<void> {
    try {
      console.log('[SessionMessageHandler] Canceling streaming...');

      // Cancel the current streaming operation in the agent manager
      await this.agentManager.cancelCurrentPrompt();

      // Use sendStreamEnd to include requestId for proper correlation
      this.sendStreamEnd('user_cancelled');

      console.log('[SessionMessageHandler] Streaming cancelled successfully');
    } catch (_error) {
      console.log('[SessionMessageHandler] Streaming cancelled (interrupted)');

      // Use sendStreamEnd (with duplicate guard) to include requestId
      this.sendStreamEnd('user_cancelled');
    }
  }

  /**
   * Handle resume session request
   */
  private async handleResumeSession(sessionId: string): Promise<void> {
    try {
      // If not connected, offer to authenticate or view offline
      if (!this.agentManager.isConnected) {
        const choice = await this.promptAuthOrOffline(
          'You are not authenticated. Configure your provider to fully restore this session, or view it offline.',
        );

        if (choice === 'offline') {
          const messages =
            await this.agentManager.getSessionMessages(sessionId);
          this.updateCurrentConversationId(sessionId);
          this.sendToWebView({
            type: 'qwenSessionSwitched',
            data: { sessionId, messages },
          });
          vscode.window.showInformationMessage(
            'Showing cached session content. Configure your provider to interact with the AI.',
          );
          return;
        } else if (choice !== 'auth') {
          return;
        }
      }

      // Try ACP load first
      try {
        // Pre-clear UI so replayed updates append afterwards
        this.updateCurrentConversationId(sessionId);
        this.sendToWebView({
          type: 'qwenSessionSwitched',
          data: { sessionId, messages: [] },
        });

        await this.agentManager.loadSessionViaAcp(sessionId);

        // Reset title flag when resuming sessions
        this.isTitleSet = false;

        // Successfully loaded session, return early to avoid fallback logic
        await this.handleGetQwenSessions();
        return;
      } catch (acpError) {
        // Check for authentication/session expiration errors
        if (this.shouldPromptAuth(acpError)) {
          // Show a more user-friendly error message for expired sessions
          await this.promptAuth(
            'Your session has expired or is invalid. Please configure your provider to resume sessions.',
          );

          // Send a specific error to the webview for better UI handling
          this.sendToWebView({
            type: 'sessionExpired',
            data: { message: 'Session expired. Please authenticate again.' },
          });
          return;
        }
      }

      await this.handleGetQwenSessions();
    } catch (error) {
      console.error('[SessionMessageHandler] Failed to resume session:', error);

      // Safely convert error to string
      const errorMsg = this.getErrorMessage(error);
      // Check for authentication/session expiration errors
      if (this.shouldPromptAuth(error)) {
        // Show a more user-friendly error message for expired sessions
        await this.promptAuth(
          'Your session has expired or is invalid. Please configure your provider to resume sessions.',
        );

        // Send a specific error to the webview for better UI handling
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired. Please authenticate again.' },
        });
      } else {
        this.sendToWebView({
          type: 'error',
          data: { message: `Failed to resume session: ${errorMsg}` },
        });
      }
    }
  }

  /**
   * Handle delete session request
   */
  private async handleDeleteQwenSession(sessionId: string): Promise<void> {
    try {
      if (
        sessionId === this.currentConversationId ||
        sessionId === this.agentManager.currentSessionId
      ) {
        this.sendToWebView({
          type: 'error',
          data: { message: 'Cannot delete the current active session.' },
        });
        return;
      }

      const success = await this.agentManager.deleteSession(sessionId);
      if (success) {
        this.sendToWebView({
          type: 'sessionDeleted',
          data: { sessionId },
        });
      } else {
        this.sendToWebView({
          type: 'error',
          data: { message: 'Failed to delete session.' },
        });
      }
    } catch (error) {
      const errorMsg = this.getErrorMessage(error);
      this.sendToWebView({
        type: 'error',
        data: { message: `Failed to delete session: ${errorMsg}` },
      });
    }
  }

  /**
   * Handle rename session request
   */
  private async handleRenameQwenSession(
    sessionId: string,
    title: string,
  ): Promise<void> {
    try {
      const trimmedTitle = title.trim().replace(/[\r\n]+/g, ' ');
      if (!trimmedTitle) {
        this.sendToWebView({
          type: 'error',
          data: { message: 'Please provide a name.' },
        });
        return;
      }
      // Matches SESSION_TITLE_MAX_LENGTH from @qwen-code/qwen-code-core/sessionService
      if (trimmedTitle.length > 200) {
        this.sendToWebView({
          type: 'error',
          data: { message: 'Name is too long. Maximum 200 characters.' },
        });
        return;
      }

      const success = await this.agentManager.renameSession(
        sessionId,
        trimmedTitle,
      );
      if (success) {
        this.sendToWebView({
          type: 'sessionRenamed',
          data: { sessionId, title: trimmedTitle },
        });
        if (sessionId === this.currentConversationId) {
          this.sendToWebView({
            type: 'sessionTitleUpdated',
            data: { sessionId, title: trimmedTitle },
          });
        }
      } else {
        this.sendToWebView({
          type: 'error',
          data: { message: 'Failed to rename session.' },
        });
      }
    } catch (error) {
      const errorMsg = this.getErrorMessage(error);
      this.sendToWebView({
        type: 'error',
        data: { message: `Failed to rename session: ${errorMsg}` },
      });
    }
  }

  /**
   * Set approval mode via agent (ACP session/set_mode)
   */
  private async handleSetApprovalMode(data?: {
    modeId?: ApprovalModeValue;
  }): Promise<void> {
    try {
      const modeId = data?.modeId || 'default';
      await this.agentManager.setApprovalModeFromUi(modeId);
      // No explicit response needed; WebView listens for modeChanged
    } catch (error) {
      console.error('[SessionMessageHandler] Failed to set mode:', error);
      const errorMsg = this.getErrorMessage(error);
      this.sendToWebView({
        type: 'error',
        data: { message: `Failed to set mode: ${errorMsg}` },
      });
    }
  }

  /**
   * Set model via agent (ACP session/set_model)
   * Displays VSCode native notifications on success or failure.
   */
  private async handleSetModel(data?: { modelId?: string }): Promise<void> {
    try {
      const modelId = data?.modelId;
      if (!modelId) {
        throw new Error('Model ID is required');
      }
      // Defensive guard: refuse non-runtime Qwen OAuth models in case the UI
      // is bypassed (programmatic call, stale webview, restored session).
      if (isDiscontinuedModel(modelId)) {
        console.warn(
          '[SessionMessageHandler] Rejected discontinued model',
          modelId,
        );
        const message = `Failed to switch model: ${DISCONTINUED_MESSAGES.blockedError}`;
        vscode.window.showErrorMessage(message);
        this.sendToWebView({
          type: 'error',
          data: { message },
        });
        return;
      }
      await this.agentManager.setModelFromUi(modelId);
      void vscode.window.showInformationMessage(
        `Model switched to: ${modelId}`,
      );
    } catch (error) {
      const errorMsg = this.getErrorMessage(error);
      console.error('[SessionMessageHandler] Failed to set model:', error);
      vscode.window.showErrorMessage(`Failed to switch model: ${errorMsg}`);
      this.sendToWebView({
        type: 'error',
        data: { message: `Failed to set model: ${errorMsg}` },
      });
    }
  }
}
