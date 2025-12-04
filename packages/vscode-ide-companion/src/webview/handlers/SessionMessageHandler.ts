/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { BaseMessageHandler } from './BaseMessageHandler.js';
import type { ChatMessage } from '../../agents/qwenAgentManager.js';

/**
 * Session message handler
 * Handles all session-related messages
 */
export class SessionMessageHandler extends BaseMessageHandler {
  private currentStreamContent = '';
  private isSavingCheckpoint = false;
  private loginHandler: (() => Promise<void>) | null = null;

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
    ].includes(messageType);
  }

  /**
   * Set login handler
   */
  setLoginHandler(handler: () => Promise<void>): void {
    this.loginHandler = handler;
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
        );
        break;

      case 'newQwenSession':
        await this.handleNewQwenSession();
        break;

      case 'switchQwenSession':
        await this.handleSwitchQwenSession((data?.sessionId as string) || '');
        break;

      case 'getQwenSessions':
        await this.handleGetQwenSessions();
        break;

      case 'saveSession':
        await this.handleSaveSession((data?.tag as string) || '');
        break;

      case 'resumeSession':
        await this.handleResumeSession((data?.sessionId as string) || '');
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

  /**
   * Check if saving checkpoint
   */
  getIsSavingCheckpoint(): boolean {
    return this.isSavingCheckpoint;
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
  ): Promise<void> {
    console.log('[SessionMessageHandler] handleSendMessage called with:', text);

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

    // Generate title for first message
    if (isFirstMessage) {
      const title = text.substring(0, 50) + (text.length > 50 ? '...' : '');
      this.sendToWebView({
        type: 'sessionTitleUpdated',
        data: {
          sessionId: this.currentConversationId,
          title,
        },
      });
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

    // Send to WebView
    this.sendToWebView({
      type: 'message',
      data: { ...userMessage, fileContext },
    });

    // Check if agent is connected
    if (!this.agentManager.isConnected) {
      console.warn('[SessionMessageHandler] Agent not connected');

      // Show non-modal notification with Login button
      const result = await vscode.window.showWarningMessage(
        'You need to login first to use Qwen Code.',
        'Login Now',
      );

      if (result === 'Login Now') {
        // Use login handler directly
        if (this.loginHandler) {
          await this.loginHandler();
        } else {
          // Fallback to command
          vscode.window.showInformationMessage(
            'Please wait while we connect to Qwen Code...',
          );
          await vscode.commands.executeCommand('qwenCode.login');
        }
      }
      return;
    }

    // Validate current session before sending message
    const isSessionValid = await this.agentManager.checkSessionValidity();
    if (!isSessionValid) {
      console.warn('[SessionMessageHandler] Current session is not valid');

      // Show non-modal notification with Login button
      const result = await vscode.window.showWarningMessage(
        'Your session has expired. Please login again to continue using Qwen Code.',
        'Login Now',
      );

      if (result === 'Login Now') {
        // Use login handler directly
        if (this.loginHandler) {
          await this.loginHandler();
        } else {
          // Fallback to command
          vscode.window.showInformationMessage(
            'Please wait while we connect to Qwen Code...',
          );
          await vscode.commands.executeCommand('qwenCode.login');
        }
      }
      return;
    }

    // Send to agent
    try {
      this.resetStreamContent();

      this.sendToWebView({
        type: 'streamStart',
        data: { timestamp: Date.now() },
      });

      await this.agentManager.sendMessage(formattedText);

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

      this.sendToWebView({
        type: 'streamEnd',
        data: { timestamp: Date.now() },
      });

      // Auto-save checkpoint
      if (this.currentConversationId) {
        try {
          const conversation = await this.conversationStore.getConversation(
            this.currentConversationId,
          );

          const messages = conversation?.messages || [];

          this.isSavingCheckpoint = true;

          const result = await this.agentManager.saveCheckpoint(
            messages,
            this.currentConversationId,
          );

          setTimeout(() => {
            this.isSavingCheckpoint = false;
          }, 2000);

          if (result.success) {
            console.log(
              '[SessionMessageHandler] Checkpoint saved:',
              result.tag,
            );
          }
        } catch (error) {
          console.error(
            '[SessionMessageHandler] Checkpoint save failed:',
            error,
          );
          this.isSavingCheckpoint = false;
        }
      }
    } catch (error) {
      console.error('[SessionMessageHandler] Error sending message:', error);

      const errorMsg = String(error);
      // Check for session not found error and handle it appropriately
      if (
        errorMsg.includes('Session not found') ||
        errorMsg.includes('No active ACP session') ||
        errorMsg.includes('Authentication required') ||
        errorMsg.includes('(code: -32000)') ||
        errorMsg.includes('Unauthorized') ||
        errorMsg.includes('Invalid token')
      ) {
        // Show a more user-friendly error message for expired sessions
        const result = await vscode.window.showWarningMessage(
          'Your login session has expired or is invalid. Please login again to continue using Qwen Code.',
          'Login Now',
        );

        if (result === 'Login Now') {
          if (this.loginHandler) {
            await this.loginHandler();
          } else {
            await vscode.commands.executeCommand('qwenCode.login');
          }
        }

        // Send a specific error to the webview for better UI handling
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired. Please login again.' },
        });
      } else {
        vscode.window.showErrorMessage(`Error sending message: ${error}`);
        this.sendToWebView({
          type: 'error',
          data: { message: errorMsg },
        });
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
        const result = await vscode.window.showWarningMessage(
          'You need to login before creating a new session.',
          'Login Now',
        );
        if (result === 'Login Now') {
          if (this.loginHandler) {
            await this.loginHandler();
          } else {
            await vscode.commands.executeCommand('qwenCode.login');
          }
        } else {
          return;
        }
      }

      // Save current session before creating new one
      if (this.currentConversationId && this.agentManager.isConnected) {
        try {
          const conversation = await this.conversationStore.getConversation(
            this.currentConversationId,
          );
          const messages = conversation?.messages || [];

          await this.agentManager.saveCheckpoint(
            messages,
            this.currentConversationId,
          );
        } catch (error) {
          console.warn('[SessionMessageHandler] Failed to auto-save:', error);
        }
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();

      await this.agentManager.createNewSession(workingDir);

      this.sendToWebView({
        type: 'conversationCleared',
        data: {},
      });
    } catch (error) {
      console.error(
        '[SessionMessageHandler] Failed to create new session:',
        error,
      );

      const errorMsg = String(error);
      // Check for authentication/session expiration errors
      if (
        errorMsg.includes('Authentication required') ||
        errorMsg.includes('(code: -32000)') ||
        errorMsg.includes('Unauthorized') ||
        errorMsg.includes('Invalid token') ||
        errorMsg.includes('No active ACP session')
      ) {
        // Show a more user-friendly error message for expired sessions
        const result = await vscode.window.showWarningMessage(
          'Your login session has expired or is invalid. Please login again to create a new session.',
          'Login Now',
        );

        if (result === 'Login Now') {
          if (this.loginHandler) {
            await this.loginHandler();
          } else {
            await vscode.commands.executeCommand('qwenCode.login');
          }
        }

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
        const selection = await vscode.window.showWarningMessage(
          'You are not logged in. Login now to fully restore this session, or view it offline.',
          'Login Now',
          'View Offline',
        );

        if (selection === 'Login Now') {
          if (this.loginHandler) {
            await this.loginHandler();
          } else {
            await vscode.commands.executeCommand('qwenCode.login');
          }
        } else if (selection === 'View Offline') {
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
        } else {
          // User dismissed; do nothing
          return;
        }
      }

      // Save current session before switching
      if (
        this.currentConversationId &&
        this.currentConversationId !== sessionId &&
        this.agentManager.isConnected
      ) {
        try {
          const conversation = await this.conversationStore.getConversation(
            this.currentConversationId,
          );
          const messages = conversation?.messages || [];

          await this.agentManager.saveCheckpoint(
            messages,
            this.currentConversationId,
          );
        } catch (error) {
          console.warn('[SessionMessageHandler] Failed to auto-save:', error);
        }
      }

      // Get session details
      let sessionDetails = null;
      try {
        const allSessions = await this.agentManager.getSessionList();
        sessionDetails = allSessions.find(
          (s: { id?: string; sessionId?: string }) =>
            s.id === sessionId || s.sessionId === sessionId,
        );
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
        const loadResponse =
          await this.agentManager.loadSessionViaAcp(sessionId);
        console.log(
          '[SessionMessageHandler] session/load succeeded:',
          loadResponse,
        );

        this.currentConversationId = sessionId;

        const messages = await this.agentManager.getSessionMessages(sessionId);

        this.sendToWebView({
          type: 'qwenSessionSwitched',
          data: { sessionId, messages, session: sessionDetails },
        });
      } catch (loadError) {
        console.warn(
          '[SessionMessageHandler] session/load failed, using fallback:',
          loadError,
        );

        const errorMsg = String(loadError);
        // Check for authentication/session expiration errors
        if (
          errorMsg.includes('Authentication required') ||
          errorMsg.includes('(code: -32000)') ||
          errorMsg.includes('Unauthorized') ||
          errorMsg.includes('Invalid token') ||
          errorMsg.includes('No active ACP session')
        ) {
          // Show a more user-friendly error message for expired sessions
          const result = await vscode.window.showWarningMessage(
            'Your login session has expired or is invalid. Please login again to switch sessions.',
            'Login Now',
          );

          if (result === 'Login Now') {
            if (this.loginHandler) {
              await this.loginHandler();
            } else {
              await vscode.commands.executeCommand('qwenCode.login');
            }
          }

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

            vscode.window.showWarningMessage(
              'Session restored from local cache. Some context may be incomplete.',
            );
          } catch (createError) {
            console.error(
              '[SessionMessageHandler] Failed to create session:',
              createError,
            );

            const createErrorMsg = String(createError);
            // Check for authentication/session expiration errors in session creation
            if (
              createErrorMsg.includes('Authentication required') ||
              createErrorMsg.includes('(code: -32000)') ||
              createErrorMsg.includes('Unauthorized') ||
              createErrorMsg.includes('Invalid token') ||
              createErrorMsg.includes('No active ACP session')
            ) {
              // Show a more user-friendly error message for expired sessions
              const result = await vscode.window.showWarningMessage(
                'Your login session has expired or is invalid. Please login again to switch sessions.',
                'Login Now',
              );

              if (result === 'Login Now') {
                if (this.loginHandler) {
                  await this.loginHandler();
                } else {
                  await vscode.commands.executeCommand('qwenCode.login');
                }
              }

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

      const errorMsg = String(error);
      // Check for authentication/session expiration errors
      if (
        errorMsg.includes('Authentication required') ||
        errorMsg.includes('(code: -32000)') ||
        errorMsg.includes('Unauthorized') ||
        errorMsg.includes('Invalid token') ||
        errorMsg.includes('No active ACP session')
      ) {
        // Show a more user-friendly error message for expired sessions
        const result = await vscode.window.showWarningMessage(
          'Your login session has expired or is invalid. Please login again to switch sessions.',
          'Login Now',
        );

        if (result === 'Login Now') {
          if (this.loginHandler) {
            await this.loginHandler();
          } else {
            await vscode.commands.executeCommand('qwenCode.login');
          }
        }

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
  private async handleGetQwenSessions(): Promise<void> {
    try {
      const sessions = await this.agentManager.getSessionList();
      this.sendToWebView({
        type: 'qwenSessionList',
        data: { sessions },
      });
    } catch (error) {
      console.error('[SessionMessageHandler] Failed to get sessions:', error);

      const errorMsg = String(error);
      // Check for authentication/session expiration errors
      if (
        errorMsg.includes('Authentication required') ||
        errorMsg.includes('(code: -32000)') ||
        errorMsg.includes('Unauthorized') ||
        errorMsg.includes('Invalid token') ||
        errorMsg.includes('No active ACP session')
      ) {
        // Show a more user-friendly error message for expired sessions
        const result = await vscode.window.showWarningMessage(
          'Your login session has expired or is invalid. Please login again to view sessions.',
          'Login Now',
        );

        if (result === 'Login Now') {
          if (this.loginHandler) {
            await this.loginHandler();
          } else {
            await vscode.commands.executeCommand('qwenCode.login');
          }
        }

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

      const conversation = await this.conversationStore.getConversation(
        this.currentConversationId,
      );
      const messages = conversation?.messages || [];

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
        const errorMsg = String(acpError);
        // Check for authentication/session expiration errors
        if (
          errorMsg.includes('Authentication required') ||
          errorMsg.includes('(code: -32000)') ||
          errorMsg.includes('Unauthorized') ||
          errorMsg.includes('Invalid token') ||
          errorMsg.includes('No active ACP session')
        ) {
          // Show a more user-friendly error message for expired sessions
          const result = await vscode.window.showWarningMessage(
            'Your login session has expired or is invalid. Please login again to save sessions.',
            'Login Now',
          );

          if (result === 'Login Now') {
            if (this.loginHandler) {
              await this.loginHandler();
            } else {
              await vscode.commands.executeCommand('qwenCode.login');
            }
          }

          // Send a specific error to the webview for better UI handling
          this.sendToWebView({
            type: 'sessionExpired',
            data: { message: 'Session expired. Please login again.' },
          });
          return;
        }

        // Fallback to direct save
        const response = await this.agentManager.saveSessionDirect(
          messages,
          tag,
        );

        this.sendToWebView({
          type: 'saveSessionResponse',
          data: response,
        });
      }

      await this.handleGetQwenSessions();
    } catch (error) {
      console.error('[SessionMessageHandler] Failed to save session:', error);

      const errorMsg = String(error);
      // Check for authentication/session expiration errors
      if (
        errorMsg.includes('Authentication required') ||
        errorMsg.includes('(code: -32000)') ||
        errorMsg.includes('Unauthorized') ||
        errorMsg.includes('Invalid token') ||
        errorMsg.includes('No active ACP session')
      ) {
        // Show a more user-friendly error message for expired sessions
        const result = await vscode.window.showWarningMessage(
          'Your login session has expired or is invalid. Please login again to save sessions.',
          'Login Now',
        );

        if (result === 'Login Now') {
          if (this.loginHandler) {
            await this.loginHandler();
          } else {
            await vscode.commands.executeCommand('qwenCode.login');
          }
        }

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
        const selection = await vscode.window.showWarningMessage(
          'You are not logged in. Login now to fully restore this session, or view it offline.',
          'Login Now',
          'View Offline',
        );

        if (selection === 'Login Now') {
          if (this.loginHandler) {
            await this.loginHandler();
          } else {
            await vscode.commands.executeCommand('qwenCode.login');
          }
        } else if (selection === 'View Offline') {
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
        } else {
          return;
        }
      }

      // Try ACP load first
      try {
        await this.agentManager.loadSessionViaAcp(sessionId);

        this.currentConversationId = sessionId;

        const messages = await this.agentManager.getSessionMessages(sessionId);

        this.sendToWebView({
          type: 'qwenSessionSwitched',
          data: { sessionId, messages },
        });
      } catch (acpError) {
        const errorMsg = String(acpError);
        // Check for authentication/session expiration errors
        if (
          errorMsg.includes('Authentication required') ||
          errorMsg.includes('(code: -32000)') ||
          errorMsg.includes('Unauthorized') ||
          errorMsg.includes('Invalid token') ||
          errorMsg.includes('No active ACP session')
        ) {
          // Show a more user-friendly error message for expired sessions
          const result = await vscode.window.showWarningMessage(
            'Your login session has expired or is invalid. Please login again to resume sessions.',
            'Login Now',
          );

          if (result === 'Login Now') {
            if (this.loginHandler) {
              await this.loginHandler();
            } else {
              await vscode.commands.executeCommand('qwenCode.login');
            }
          }

          // Send a specific error to the webview for better UI handling
          this.sendToWebView({
            type: 'sessionExpired',
            data: { message: 'Session expired. Please login again.' },
          });
          return;
        }

        // Fallback to direct load
        const messages = await this.agentManager.loadSessionDirect(sessionId);

        if (messages) {
          this.currentConversationId = sessionId;

          this.sendToWebView({
            type: 'qwenSessionSwitched',
            data: { sessionId, messages },
          });
        } else {
          throw new Error('Failed to load session');
        }
      }

      await this.handleGetQwenSessions();
    } catch (error) {
      console.error('[SessionMessageHandler] Failed to resume session:', error);

      const errorMsg = String(error);
      // Check for authentication/session expiration errors
      if (
        errorMsg.includes('Authentication required') ||
        errorMsg.includes('(code: -32000)') ||
        errorMsg.includes('Unauthorized') ||
        errorMsg.includes('Invalid token') ||
        errorMsg.includes('No active ACP session')
      ) {
        // Show a more user-friendly error message for expired sessions
        const result = await vscode.window.showWarningMessage(
          'Your login session has expired or is invalid. Please login again to resume sessions.',
          'Login Now',
        );

        if (result === 'Login Now') {
          if (this.loginHandler) {
            await this.loginHandler();
          } else {
            await vscode.commands.executeCommand('qwenCode.login');
          }
        }

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
}
