/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { BaseMessageHandler } from './BaseMessageHandler.js';
import type { ChatMessage } from '../../services/qwenAgentManager.js';
import type { ApprovalModeValue } from '../../types/approvalModeValueTypes.js';
import { ACP_ERROR_CODES } from '../../constants/acpSchema.js';
import type { PromptContent } from '../../services/acpSessionManager.js';
import {
  cleanupOldClipboardImages,
  saveBase64ImageSync,
} from '@qwen-code/qwen-code-core/src/utils/clipboardImageStorage.js';

const AUTH_REQUIRED_CODE_PATTERN = `(code: ${ACP_ERROR_CODES.AUTH_REQUIRED})`;

/**
 * Session message handler
 * Handles all session-related messages
 */
export class SessionMessageHandler extends BaseMessageHandler {
  private currentStreamContent = '';
  private loginHandler: (() => Promise<void>) | null = null;
  private isTitleSet = false; // Flag to track if title has been set

  canHandle(messageType: string): boolean {
    return [
      'sendMessage',
      'newQwenSession',
      'switchQwenSession',
      'getQwenSessions',
      'saveSession',
      'resumeSession',
      'cancelStreaming',
      // UI action: open a new chat tab (new WebviewPanel)
      'openNewChatTab',
      // Settings-related messages
      'setApprovalMode',
    ].includes(messageType);
  }

  /**
   * Set login handler
   */
  setLoginHandler(handler: () => Promise<void>): void {
    this.loginHandler = handler;
  }

  async handle(message: { type: string; data?: unknown }): Promise<void> {
    type SendMessagePayload = {
      text?: string;
      context?: Array<{
        type: string;
        name: string;
        value: string;
        startLine?: number;
        endLine?: number;
      }>;
      fileContext?: {
        fileName: string;
        filePath: string;
        startLine?: number;
        endLine?: number;
      };
      attachments?: Array<{
        id: string;
        name: string;
        type: string;
        size: number;
        data: string;
        timestamp: number;
      }>;
    };

    type MessageData = {
      text?: string;
      context?: SendMessagePayload['context'];
      fileContext?: SendMessagePayload['fileContext'];
      attachments?: SendMessagePayload['attachments'];
      sessionId?: string;
      cursor?: number;
      size?: number;
      tag?: string;
    };

    const data = message.data as MessageData | undefined;

    switch (message.type) {
      case 'sendMessage':
        await this.handleSendMessage(
          data?.text || '',
          data?.context,
          data?.fileContext,
          data?.attachments,
        );
        break;

      case 'newQwenSession':
        await this.handleNewQwenSession();
        break;

      case 'switchQwenSession':
        await this.handleSwitchQwenSession(data?.sessionId || '');
        break;

      case 'getQwenSessions':
        await this.handleGetQwenSessions(data?.cursor, data?.size);
        break;

      case 'saveSession':
        await this.handleSaveSession(data?.tag || '');
        break;

      case 'resumeSession':
        await this.handleResumeSession(data?.sessionId || '');
        break;

      case 'openNewChatTab':
        // Open a brand new chat tab (WebviewPanel) via the extension command
        // This does not alter the current conversation in this tab; the new tab
        // will initialize its own state and (optionally) create a new session.
        try {
          await vscode.commands.executeCommand('qwenCode.openNewChatTab');
        } catch (error) {
          console.error(
            '[SessionMessageHandler] Failed to open new chat tab:',
            error,
          );
          this.sendToWebView({
            type: 'error',
            data: { message: `Failed to open new chat tab: ${error}` },
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

      default:
        console.warn(
          '[SessionMessageHandler] Unknown message type:',
          message.type,
        );
        break;
    }
  }

  /**
   * Save base64 image to a temporary file
   * Uses the shared clipboard image storage utility from core package.
   * @param base64Data The base64 encoded image data (with or without data URL prefix)
   * @param fileName Original filename
   * @returns The relative path to the saved file or null if failed
   */
  private saveImageToFile(base64Data: string, fileName: string): string | null {
    // Get workspace folder
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      console.error('[SessionMessageHandler] No workspace folder found');
      return null;
    }

    const relativePath = saveBase64ImageSync(
      base64Data,
      fileName,
      workspaceFolder.uri.fsPath,
    );

    if (relativePath) {
      console.log('[SessionMessageHandler] Saved image to:', relativePath);
    }

    return relativePath;
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

  /**
   * Notify the webview that streaming has finished.
   */
  private sendStreamEnd(reason?: string): void {
    const data: { timestamp: number; reason?: string } = {
      timestamp: Date.now(),
    };

    if (reason) {
      data.reason = reason;
    }

    this.sendToWebView({
      type: 'streamEnd',
      data,
    });
  }

  /**
   * Prompt user to login and invoke the registered login handler/command.
   * Returns true if a login was initiated.
   */
  private async promptLogin(message: string): Promise<boolean> {
    const result = await vscode.window.showWarningMessage(message, 'Login Now');
    if (result === 'Login Now') {
      if (this.loginHandler) {
        await this.loginHandler();
      } else {
        await vscode.commands.executeCommand('qwen-code.login');
      }
      return true;
    }
    return false;
  }

  /**
   * Prompt user to login or view offline. Returns 'login', 'offline', or 'dismiss'.
   * When login is chosen, it triggers the login handler/command.
   */
  private async promptLoginOrOffline(
    message: string,
  ): Promise<'login' | 'offline' | 'dismiss'> {
    const selection = await vscode.window.showWarningMessage(
      message,
      'Login Now',
      'View Offline',
    );

    if (selection === 'Login Now') {
      if (this.loginHandler) {
        await this.loginHandler();
      } else {
        await vscode.commands.executeCommand('qwen-code.login');
      }
      return 'login';
    }
    if (selection === 'View Offline') {
      return 'offline';
    }
    return 'dismiss';
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
    attachments?: Array<{
      id: string;
      name: string;
      type: string;
      size: number;
      data: string;
      timestamp: number;
    }>,
  ): Promise<void> {
    console.log('[SessionMessageHandler] handleSendMessage called with:', text);
    if (attachments && attachments.length > 0) {
      console.log(
        '[SessionMessageHandler] Message includes',
        attachments.length,
        'image attachments',
      );
    }

    // Format message with file context if present
    let formattedText = text;
    if (context && context.length > 0) {
      const contextParts = context
        .map((ctx) => {
          if (ctx.startLine && ctx.endLine) {
            return `${ctx.value}#${ctx.startLine}${ctx.startLine !== ctx.endLine ? `-${ctx.endLine}` : ''}`;
          }
          return ctx.value;
        })
        .join('\n');

      formattedText = `${contextParts}\n\n${text}`;
    }

    if (!formattedText && (!attachments || attachments.length === 0)) {
      this.sendToWebView({
        type: 'error',
        data: { message: 'Message is empty.' },
      });
      return;
    }

    // Build prompt content
    let promptContent: PromptContent[] = [];

    // Add text content (with context if present)
    if (formattedText) {
      promptContent.push({
        type: 'text',
        text: formattedText,
      });
    }

    // Add image attachments - save to files and reference them
    if (attachments && attachments.length > 0) {
      console.log(
        '[SessionMessageHandler] Processing attachments - saving to files',
      );

      // Save images as files and add references to the text
      const imageReferences: string[] = [];

      for (const attachment of attachments) {
        console.log('[SessionMessageHandler] Processing attachment:', {
          id: attachment.id,
          name: attachment.name,
          type: attachment.type,
          dataLength: attachment.data.length,
        });

        // Save image to file (sync operation using shared utility)
        const imagePath = this.saveImageToFile(
          attachment.data,
          attachment.name,
        );
        if (imagePath) {
          // Add file reference to the message (like CLI does with @path)
          imageReferences.push(`@${imagePath}`);
          console.log(
            '[SessionMessageHandler] Added image reference:',
            `@${imagePath}`,
          );
        } else {
          console.warn(
            '[SessionMessageHandler] Failed to save image:',
            attachment.name,
          );
        }
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        cleanupOldClipboardImages(workspaceFolder.uri.fsPath).catch((error) => {
          console.warn(
            '[SessionMessageHandler] Failed to cleanup clipboard images:',
            error,
          );
        });
      }

      // Add image references to the text
      if (imageReferences.length > 0) {
        const imageText = imageReferences.join(' ');
        // Update the formatted text with image references
        const updatedText = formattedText
          ? `${formattedText}\n\n${imageText}`
          : imageText;

        // Replace the prompt content with updated text
        promptContent = [
          {
            type: 'text',
            text: updatedText,
          },
        ];

        console.log(
          '[SessionMessageHandler] Updated text with image references:',
          updatedText,
        );
      }
    }

    console.log('[SessionMessageHandler] Final promptContent:', {
      count: promptContent.length,
      types: promptContent.map((c) => c.type),
    });

    // Ensure we have an active conversation
    if (!this.currentConversationId) {
      console.log(
        '[SessionMessageHandler] No active conversation, creating one...',
      );
      try {
        const newConv = await this.conversationStore.createConversation();
        this.currentConversationId = newConv.id;
        this.sendToWebView({
          type: 'conversationLoaded',
          data: newConv,
        });
      } catch (error) {
        const errorMsg = `Failed to create conversation: ${error}`;
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

    // Check if this is the first message
    let isFirstMessage = false;
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

    // Generate title for first message, but only if it hasn't been set yet
    if (isFirstMessage && !this.isTitleSet) {
      const title = text.substring(0, 50) + (text.length > 50 ? '...' : '');
      this.sendToWebView({
        type: 'sessionTitleUpdated',
        data: {
          sessionId: this.currentConversationId,
          title,
        },
      });
      this.isTitleSet = true; // Mark title as set
    }

    // Save user message
    const userMessage: ChatMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };

    // Store the original message with just text
    await this.conversationStore.addMessage(
      this.currentConversationId,
      userMessage,
    );

    // Send to WebView with file context and attachments
    this.sendToWebView({
      type: 'message',
      data: { ...userMessage, fileContext, attachments },
    });

    // Check if agent is connected
    if (!this.agentManager.isConnected) {
      console.warn('[SessionMessageHandler] Agent not connected');

      // Show non-modal notification with Login button
      await this.promptLogin('You need to login first to use Qwen Code.');
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
        const errorMsg =
          createErr instanceof Error ? createErr.message : String(createErr);
        if (
          errorMsg.includes('Authentication required') ||
          errorMsg.includes(AUTH_REQUIRED_CODE_PATTERN)
        ) {
          await this.promptLogin(
            'Your login session has expired or is invalid. Please login again to continue using Qwen Code.',
          );
          return;
        }
        vscode.window.showErrorMessage(`Failed to create session: ${errorMsg}`);
        return;
      }
    }

    // Send to agent
    try {
      this.resetStreamContent();

      this.sendToWebView({
        type: 'streamStart',
        data: { timestamp: Date.now() },
      });

      // Send multimodal content instead of plain text
      await this.agentManager.sendMessage(promptContent);

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

      this.sendStreamEnd();
    } catch (error) {
      console.error('[SessionMessageHandler] Error sending message:', error);

      const err = error as unknown as Error;
      // Safely convert error to string
      const errorMsg = error ? String(error) : 'Unknown error';
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
        this.sendStreamEnd('user_cancelled');
        return;
      }
      // Check for session not found error and handle it appropriately
      if (
        errorMsg.includes('Session not found') ||
        errorMsg.includes('No active ACP session') ||
        errorMsg.includes('Authentication required') ||
        errorMsg.includes(AUTH_REQUIRED_CODE_PATTERN) ||
        errorMsg.includes('Unauthorized') ||
        errorMsg.includes('Invalid token')
      ) {
        // Show a more user-friendly error message for expired sessions
        await this.promptLogin(
          'Your login session has expired or is invalid. Please login again to continue using Qwen Code.',
        );

        // Send a specific error to the webview for better UI handling
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired. Please login again.' },
        });
        this.sendStreamEnd('session_expired');
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
          this.sendStreamEnd('timeout');
        } else {
          // Handling of Non-Timeout Errors
          vscode.window.showErrorMessage(`Error sending message: ${error}`);
          this.sendToWebView({
            type: 'error',
            data: { message: errorMsg },
          });
          this.sendStreamEnd('error');
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

      // Ensure connection (login) before creating a new session
      if (!this.agentManager.isConnected) {
        const proceeded = await this.promptLogin(
          'You need to login before creating a new session.',
        );
        if (!proceeded) {
          return;
        }
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      await this.agentManager.createNewSession(workingDir);

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
      const errorMsg = error ? String(error) : 'Unknown error';
      // Check for authentication/session expiration errors
      if (
        errorMsg.includes('Authentication required') ||
        errorMsg.includes(AUTH_REQUIRED_CODE_PATTERN) ||
        errorMsg.includes('Unauthorized') ||
        errorMsg.includes('Invalid token') ||
        errorMsg.includes('No active ACP session')
      ) {
        // Show a more user-friendly error message for expired sessions
        await this.promptLogin(
          'Your login session has expired or is invalid. Please login again to create a new session.',
        );

        // Send a specific error to the webview for better UI handling
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired. Please login again.' },
        });
      } else {
        this.sendToWebView({
          type: 'error',
          data: { message: `Failed to create new session: ${error}` },
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

      // If not connected yet, offer to login or view offline
      if (!this.agentManager.isConnected) {
        const choice = await this.promptLoginOrOffline(
          'You are not logged in. Login now to fully restore this session, or view it offline.',
        );

        if (choice === 'offline') {
          // Show messages from local cache only
          const messages =
            await this.agentManager.getSessionMessages(sessionId);
          this.currentConversationId = sessionId;
          this.sendToWebView({
            type: 'qwenSessionSwitched',
            data: { sessionId, messages },
          });
          vscode.window.showInformationMessage(
            'Showing cached session content. Login to interact with the AI.',
          );
          return;
        } else if (choice !== 'login') {
          // User dismissed; do nothing
          return;
        }
      }

      // Get session details (includes cwd and filePath when using ACP)
      type SessionDetails = {
        id?: string;
        sessionId?: string;
        cwd?: string;
        [key: string]: unknown;
      };
      let sessionDetails: SessionDetails | null = null;
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
        this.currentConversationId = sessionId;
        this.sendToWebView({
          type: 'qwenSessionSwitched',
          data: { sessionId, messages: [], session: sessionDetails },
        });

        const loadResponse = await this.agentManager.loadSessionViaAcp(
          sessionId,
          sessionDetails?.cwd,
        );
        console.log(
          '[SessionMessageHandler] session/load succeeded (per ACP spec result is null; actual history comes via session/update):',
          loadResponse,
        );

        // Reset title flag when switching sessions
        this.isTitleSet = false;

        // Successfully loaded session, return early to avoid fallback logic
        return;
      } catch (loadError) {
        console.warn(
          '[SessionMessageHandler] session/load failed, using fallback:',
          loadError,
        );

        // Safely convert error to string
        const errorMsg = loadError ? String(loadError) : 'Unknown error';

        // Check for authentication/session expiration errors
        if (
          errorMsg.includes('Authentication required') ||
          errorMsg.includes(AUTH_REQUIRED_CODE_PATTERN) ||
          errorMsg.includes('Unauthorized') ||
          errorMsg.includes('Invalid token') ||
          errorMsg.includes('No active ACP session')
        ) {
          // Show a more user-friendly error message for expired sessions
          await this.promptLogin(
            'Your login session has expired or is invalid. Please login again to switch sessions.',
          );

          // Send a specific error to the webview for better UI handling
          this.sendToWebView({
            type: 'sessionExpired',
            data: { message: 'Session expired. Please login again.' },
          });
          return;
        }

        // Fallback: create new session
        const messages = await this.agentManager.getSessionMessages(sessionId);

        // If we are connected, try to create a fresh ACP session so user can interact
        if (this.agentManager.isConnected) {
          try {
            const newAcpSessionId =
              await this.agentManager.createNewSession(workingDir);

            this.currentConversationId = newAcpSessionId;

            this.sendToWebView({
              type: 'qwenSessionSwitched',
              data: { sessionId, messages, session: sessionDetails },
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

            // Safely convert error to string
            const createErrorMsg = createError
              ? String(createError)
              : 'Unknown error';
            // Check for authentication/session expiration errors in session creation
            if (
              createErrorMsg.includes('Authentication required') ||
              createErrorMsg.includes(AUTH_REQUIRED_CODE_PATTERN) ||
              createErrorMsg.includes('Unauthorized') ||
              createErrorMsg.includes('Invalid token') ||
              createErrorMsg.includes('No active ACP session')
            ) {
              // Show a more user-friendly error message for expired sessions
              await this.promptLogin(
                'Your login session has expired or is invalid. Please login again to switch sessions.',
              );

              // Send a specific error to the webview for better UI handling
              this.sendToWebView({
                type: 'sessionExpired',
                data: { message: 'Session expired. Please login again.' },
              });
              return;
            }

            throw createError;
          }
        } else {
          // Offline view only
          this.currentConversationId = sessionId;
          this.sendToWebView({
            type: 'qwenSessionSwitched',
            data: { sessionId, messages, session: sessionDetails },
          });
          vscode.window.showWarningMessage(
            'Showing cached session content. Login to interact with the AI.',
          );
        }
      }
    } catch (error) {
      console.error('[SessionMessageHandler] Failed to switch session:', error);

      // Safely convert error to string
      const errorMsg = error ? String(error) : 'Unknown error';
      // Check for authentication/session expiration errors
      if (
        errorMsg.includes('Authentication required') ||
        errorMsg.includes(AUTH_REQUIRED_CODE_PATTERN) ||
        errorMsg.includes('Unauthorized') ||
        errorMsg.includes('Invalid token') ||
        errorMsg.includes('No active ACP session')
      ) {
        // Show a more user-friendly error message for expired sessions
        await this.promptLogin(
          'Your login session has expired or is invalid. Please login again to switch sessions.',
        );

        // Send a specific error to the webview for better UI handling
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired. Please login again.' },
        });
      } else {
        this.sendToWebView({
          type: 'error',
          data: { message: `Failed to switch session: ${error}` },
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
      const errorMsg = error ? String(error) : 'Unknown error';
      // Check for authentication/session expiration errors
      if (
        errorMsg.includes('Authentication required') ||
        errorMsg.includes(AUTH_REQUIRED_CODE_PATTERN) ||
        errorMsg.includes('Unauthorized') ||
        errorMsg.includes('Invalid token') ||
        errorMsg.includes('No active ACP session')
      ) {
        // Show a more user-friendly error message for expired sessions
        await this.promptLogin(
          'Your login session has expired or is invalid. Please login again to view sessions.',
        );

        // Send a specific error to the webview for better UI handling
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired. Please login again.' },
        });
      } else {
        this.sendToWebView({
          type: 'error',
          data: { message: `Failed to get sessions: ${error}` },
        });
      }
    }
  }

  /**
   * Handle save session request
   */
  private async handleSaveSession(tag: string): Promise<void> {
    try {
      if (!this.currentConversationId) {
        throw new Error('No active conversation to save');
      }

      // Try ACP save first
      try {
        const response = await this.agentManager.saveSessionViaAcp(
          this.currentConversationId,
          tag,
        );

        this.sendToWebView({
          type: 'saveSessionResponse',
          data: response,
        });
      } catch (acpError) {
        // Safely convert error to string
        const errorMsg = acpError ? String(acpError) : 'Unknown error';
        // Check for authentication/session expiration errors
        if (
          errorMsg.includes('Authentication required') ||
          errorMsg.includes(AUTH_REQUIRED_CODE_PATTERN) ||
          errorMsg.includes('Unauthorized') ||
          errorMsg.includes('Invalid token') ||
          errorMsg.includes('No active ACP session')
        ) {
          // Show a more user-friendly error message for expired sessions
          await this.promptLogin(
            'Your login session has expired or is invalid. Please login again to save sessions.',
          );

          // Send a specific error to the webview for better UI handling
          this.sendToWebView({
            type: 'sessionExpired',
            data: { message: 'Session expired. Please login again.' },
          });
          return;
        }
      }

      await this.handleGetQwenSessions();
    } catch (error) {
      console.error('[SessionMessageHandler] Failed to save session:', error);

      // Safely convert error to string
      const errorMsg = error ? String(error) : 'Unknown error';
      // Check for authentication/session expiration errors
      if (
        errorMsg.includes('Authentication required') ||
        errorMsg.includes(AUTH_REQUIRED_CODE_PATTERN) ||
        errorMsg.includes('Unauthorized') ||
        errorMsg.includes('Invalid token') ||
        errorMsg.includes('No active ACP session')
      ) {
        // Show a more user-friendly error message for expired sessions
        await this.promptLogin(
          'Your login session has expired or is invalid. Please login again to save sessions.',
        );

        // Send a specific error to the webview for better UI handling
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired. Please login again.' },
        });
      } else {
        this.sendToWebView({
          type: 'saveSessionResponse',
          data: {
            success: false,
            message: `Failed to save session: ${error}`,
          },
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

      // Send streamEnd message to WebView to update UI
      this.sendToWebView({
        type: 'streamEnd',
        data: { timestamp: Date.now(), reason: 'user_cancelled' },
      });

      console.log('[SessionMessageHandler] Streaming cancelled successfully');
    } catch (_error) {
      console.log('[SessionMessageHandler] Streaming cancelled (interrupted)');

      // Always send streamEnd to update UI, regardless of errors
      this.sendToWebView({
        type: 'streamEnd',
        data: { timestamp: Date.now(), reason: 'user_cancelled' },
      });
    }
  }

  /**
   * Handle resume session request
   */
  private async handleResumeSession(sessionId: string): Promise<void> {
    try {
      // If not connected, offer to login or view offline
      if (!this.agentManager.isConnected) {
        const choice = await this.promptLoginOrOffline(
          'You are not logged in. Login now to fully restore this session, or view it offline.',
        );

        if (choice === 'offline') {
          const messages =
            await this.agentManager.getSessionMessages(sessionId);
          this.currentConversationId = sessionId;
          this.sendToWebView({
            type: 'qwenSessionSwitched',
            data: { sessionId, messages },
          });
          vscode.window.showInformationMessage(
            'Showing cached session content. Login to interact with the AI.',
          );
          return;
        } else if (choice !== 'login') {
          return;
        }
      }

      // Try ACP load first
      try {
        // Pre-clear UI so replayed updates append afterwards
        this.currentConversationId = sessionId;
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
        // Safely convert error to string
        const errorMsg = acpError ? String(acpError) : 'Unknown error';
        // Check for authentication/session expiration errors
        if (
          errorMsg.includes('Authentication required') ||
          errorMsg.includes(AUTH_REQUIRED_CODE_PATTERN) ||
          errorMsg.includes('Unauthorized') ||
          errorMsg.includes('Invalid token') ||
          errorMsg.includes('No active ACP session')
        ) {
          // Show a more user-friendly error message for expired sessions
          await this.promptLogin(
            'Your login session has expired or is invalid. Please login again to resume sessions.',
          );

          // Send a specific error to the webview for better UI handling
          this.sendToWebView({
            type: 'sessionExpired',
            data: { message: 'Session expired. Please login again.' },
          });
          return;
        }
      }

      await this.handleGetQwenSessions();
    } catch (error) {
      console.error('[SessionMessageHandler] Failed to resume session:', error);

      // Safely convert error to string
      const errorMsg = error ? String(error) : 'Unknown error';
      // Check for authentication/session expiration errors
      if (
        errorMsg.includes('Authentication required') ||
        errorMsg.includes(AUTH_REQUIRED_CODE_PATTERN) ||
        errorMsg.includes('Unauthorized') ||
        errorMsg.includes('Invalid token') ||
        errorMsg.includes('No active ACP session')
      ) {
        // Show a more user-friendly error message for expired sessions
        await this.promptLogin(
          'Your login session has expired or is invalid. Please login again to resume sessions.',
        );

        // Send a specific error to the webview for better UI handling
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired. Please login again.' },
        });
      } else {
        this.sendToWebView({
          type: 'error',
          data: { message: `Failed to resume session: ${error}` },
        });
      }
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
      this.sendToWebView({
        type: 'error',
        data: { message: `Failed to set mode: ${error}` },
      });
    }
  }
}
