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
import * as fs from 'fs';
import * as path from 'path';

const AUTH_REQUIRED_CODE_PATTERN = `(code: ${ACP_ERROR_CODES.AUTH_REQUIRED})`;

// Helper to check if error is authentication-related
function isAuthError(errorMsg: string): boolean {
  return (
    errorMsg.includes('Authentication required') ||
    errorMsg.includes(AUTH_REQUIRED_CODE_PATTERN) ||
    errorMsg.includes('Unauthorized') ||
    errorMsg.includes('Invalid token') ||
    errorMsg.includes('No active ACP session')
  );
}

/**
 * Session message handler
 */
export class SessionMessageHandler extends BaseMessageHandler {
  private currentStreamContent = '';
  private loginHandler: (() => Promise<void>) | null = null;
  private isTitleSet = false;

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
      'setModel',
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
          data?.attachments as
            | Array<{
                id: string;
                name: string;
                type: string;
                size: number;
                data: string;
                timestamp: number;
              }>
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
        await this.handleGetQwenSessions(
          (data?.cursor as number | undefined) ?? undefined,
          (data?.size as number | undefined) ?? undefined,
        );
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
   * Save base64 image to clipboard directory (aligned with CLI)
   */
  private async saveImageToFile(
    base64Data: string,
    fileName: string,
  ): Promise<string | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return null;

    const tempDir = path.join(workspaceFolder.uri.fsPath, 'clipboard');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = Date.now();
    const ext = path.extname(fileName) || '.png';
    const tempFileName = `clipboard-${timestamp}${ext}`;
    const tempFilePath = path.join(tempDir, tempFileName);

    // Extract base64 data if it's a data URL
    const dataUrlMatch = base64Data.match(/^data:[^;]+;base64,(.+)$/);
    const pureBase64 = dataUrlMatch ? dataUrlMatch[1] : base64Data;

    fs.writeFileSync(tempFilePath, Buffer.from(pureBase64, 'base64'));

    return path.relative(workspaceFolder.uri.fsPath, tempFilePath);
  }

  /**
   * Read image file and convert to base64 for multimodal sending
   */
  private async readImageFile(
    imagePath: string,
  ): Promise<{ data: string; mimeType: string } | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return null;

    const fullPath = path.join(workspaceFolder.uri.fsPath, imagePath);
    if (!fs.existsSync(fullPath)) return null;

    const buffer = fs.readFileSync(fullPath);
    const data = buffer.toString('base64');

    const ext = path.extname(fullPath).toLowerCase();
    const mimeTypeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.tiff': 'image/tiff',
      '.heic': 'image/heic',
    };

    return { data, mimeType: mimeTypeMap[ext] || 'image/png' };
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
    // Guard: ignore empty messages
    const trimmedText = text.replace(/\u200B/g, '').trim();
    if (!trimmedText) {
      return;
    }

    // Format message with context
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

    // Build multimodal prompt content
    const promptContent: PromptContent[] = [];

    // Save images to files and read back as multimodal content (aligned with CLI)
    const savedImagePaths: string[] = [];
    if (attachments && attachments.length > 0) {
      for (const attachment of attachments) {
        const imagePath = await this.saveImageToFile(
          attachment.data,
          attachment.name,
        );
        if (imagePath) {
          savedImagePaths.push(imagePath);
        }
      }
    }

    // Add text content
    if (formattedText) {
      promptContent.push({ type: 'text', text: formattedText });
    }

    // Add images as multimodal content
    for (const imagePath of savedImagePaths) {
      const imageData = await this.readImageFile(imagePath);
      if (imageData) {
        promptContent.push({
          type: 'image',
          data: imageData.data,
          mimeType: imageData.mimeType,
        });
      }
    }

    // Ensure conversation exists
    if (!this.currentConversationId) {
      try {
        const newConv = await this.conversationStore.createConversation();
        this.currentConversationId = newConv.id;
        this.sendToWebView({ type: 'conversationLoaded', data: newConv });
      } catch (error) {
        this.sendToWebView({
          type: 'error',
          data: { message: `Failed to create conversation: ${error}` },
        });
        return;
      }
    }

    // Set session title for first message
    const conversation = await this.conversationStore
      .getConversation(this.currentConversationId)
      .catch(() => null);
    if (
      (!conversation || conversation.messages.length === 0) &&
      !this.isTitleSet
    ) {
      const title = text.substring(0, 50) + (text.length > 50 ? '...' : '');
      this.sendToWebView({
        type: 'sessionTitleUpdated',
        data: { sessionId: this.currentConversationId, title },
      });
      this.isTitleSet = true;
    }

    // Save and forward user message
    const userMessage: ChatMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    await this.conversationStore.addMessage(
      this.currentConversationId,
      userMessage,
    );
    this.sendToWebView({
      type: 'message',
      data: { ...userMessage, fileContext, attachments },
    });

    // Check connection
    if (!this.agentManager.isConnected) {
      await this.promptLogin('You need to login first to use Qwen Code.');
      return;
    }

    // Ensure ACP session exists
    if (!this.agentManager.currentSessionId) {
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        await this.agentManager.createNewSession(
          workspaceFolder?.uri.fsPath || process.cwd(),
        );
      } catch (createErr) {
        const errorMsg =
          createErr instanceof Error ? createErr.message : String(createErr);
        if (isAuthError(errorMsg)) {
          await this.promptLogin(
            'Your login session has expired. Please login again.',
          );
        } else {
          vscode.window.showErrorMessage(
            `Failed to create session: ${errorMsg}`,
          );
        }
        return;
      }
    }

    // Send to agent
    try {
      this.currentStreamContent = '';
      this.sendToWebView({
        type: 'streamStart',
        data: { timestamp: Date.now() },
      });
      await this.agentManager.sendMessage(promptContent);

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
    } catch (error) {
      const errorMsg = error ? String(error) : 'Unknown error';
      const lower = errorMsg.toLowerCase();

      // User cancelled
      if (
        lower.includes('abort') ||
        lower.includes('cancel') ||
        (error as Error)?.name === 'AbortError'
      ) {
        this.sendToWebView({
          type: 'streamEnd',
          data: { timestamp: Date.now(), reason: 'user_cancelled' },
        });
        return;
      }

      // Auth error
      if (isAuthError(errorMsg)) {
        await this.promptLogin(
          'Your login session has expired. Please login again.',
        );
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired. Please login again.' },
        });
        return;
      }

      // Timeout
      if (lower.includes('timeout')) {
        this.sendToWebView({
          type: 'message',
          data: {
            role: 'assistant',
            content: 'Request timed out. Please try again.',
            timestamp: Date.now(),
          },
        });
        return;
      }

      // Other errors
      vscode.window.showErrorMessage(`Error sending message: ${error}`);
      this.sendToWebView({ type: 'error', data: { message: errorMsg } });
    }
  }

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

  private sendStreamEnd(reason?: string): void {
    this.sendToWebView({
      type: 'streamEnd',
      data: { timestamp: Date.now(), reason },
    });
  }

  private async handleNewQwenSession(): Promise<void> {
    if (!this.agentManager.isConnected) {
      const proceeded = await this.promptLogin(
        'You need to login before creating a new session.',
      );
      if (!proceeded) return;
    }

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      await this.agentManager.createNewSession(
        workspaceFolder?.uri.fsPath || process.cwd(),
      );
      this.sendToWebView({ type: 'conversationCleared', data: {} });
      this.isTitleSet = false;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (isAuthError(errorMsg)) {
        await this.promptLogin(
          'Your login session has expired. Please login again.',
        );
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired.' },
        });
      } else {
        this.sendToWebView({
          type: 'error',
          data: { message: `Failed to create new session: ${error}` },
        });
      }
    }
  }

  private async handleSwitchQwenSession(sessionId: string): Promise<void> {
    // Handle offline mode
    if (!this.agentManager.isConnected) {
      const choice = await this.promptLoginOrOffline(
        'You are not logged in. Login to restore session, or view offline.',
      );
      if (choice === 'offline') {
        const messages = await this.agentManager.getSessionMessages(sessionId);
        this.currentConversationId = sessionId;
        this.sendToWebView({
          type: 'qwenSessionSwitched',
          data: { sessionId, messages },
        });
        vscode.window.showInformationMessage(
          'Showing cached content. Login to interact.',
        );
        return;
      }
      if (choice !== 'login') return;
    }

    try {
      // Get session details
      let sessionDetails: Record<string, unknown> | null = null;
      try {
        const allSessions = await this.agentManager.getSessionList();
        sessionDetails =
          allSessions.find(
            (s: { id?: string; sessionId?: string }) =>
              s.id === sessionId || s.sessionId === sessionId,
          ) || null;
      } catch {
        // Ignore details fetch errors
      }

      // Try ACP load
      this.currentConversationId = sessionId;
      this.sendToWebView({
        type: 'qwenSessionSwitched',
        data: { sessionId, messages: [], session: sessionDetails },
      });

      await this.agentManager.loadSessionViaAcp(
        sessionId,
        sessionDetails?.cwd as string | undefined,
      );
      this.isTitleSet = false;
    } catch (loadError) {
      const errorMsg =
        loadError instanceof Error ? loadError.message : String(loadError);

      if (isAuthError(errorMsg)) {
        await this.promptLogin(
          'Your login session has expired. Please login again.',
        );
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired.' },
        });
        return;
      }

      // Fallback: load from local cache
      const messages = await this.agentManager.getSessionMessages(sessionId);
      this.sendToWebView({
        type: 'qwenSessionSwitched',
        data: { sessionId, messages },
      });
      vscode.window.showWarningMessage(
        'Session restored from cache. Some context may be incomplete.',
      );
    }
  }

  private async handleGetQwenSessions(
    cursor?: number,
    size?: number,
  ): Promise<void> {
    try {
      const page = await this.agentManager.getSessionListPaged({
        cursor,
        size,
      });
      this.sendToWebView({
        type: 'qwenSessionList',
        data: {
          sessions: page.sessions,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          append: typeof cursor === 'number',
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (isAuthError(errorMsg)) {
        await this.promptLogin(
          'Your login session has expired. Please login again.',
        );
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired.' },
        });
      } else {
        this.sendToWebView({
          type: 'error',
          data: { message: `Failed to get sessions: ${error}` },
        });
      }
    }
  }

  private async handleSaveSession(tag: string): Promise<void> {
    if (!this.currentConversationId) {
      this.sendToWebView({
        type: 'saveSessionResponse',
        data: { success: false, message: 'No active conversation to save' },
      });
      return;
    }

    try {
      const response = await this.agentManager.saveSessionViaAcp(
        this.currentConversationId,
        tag,
      );
      this.sendToWebView({ type: 'saveSessionResponse', data: response });
      await this.handleGetQwenSessions();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (isAuthError(errorMsg)) {
        await this.promptLogin(
          'Your login session has expired. Please login again.',
        );
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired.' },
        });
      } else {
        this.sendToWebView({
          type: 'saveSessionResponse',
          data: { success: false, message: `Failed to save session: ${error}` },
        });
      }
    }
  }

  private async handleCancelStreaming(): Promise<void> {
    await this.agentManager.cancelCurrentPrompt().catch(() => {});
    this.sendToWebView({
      type: 'streamEnd',
      data: { timestamp: Date.now(), reason: 'user_cancelled' },
    });
  }

  private async handleResumeSession(sessionId: string): Promise<void> {
    if (!this.agentManager.isConnected) {
      const choice = await this.promptLoginOrOffline(
        'You are not logged in. Login to restore session, or view offline.',
      );
      if (choice === 'offline') {
        const messages = await this.agentManager.getSessionMessages(sessionId);
        this.currentConversationId = sessionId;
        this.sendToWebView({
          type: 'qwenSessionSwitched',
          data: { sessionId, messages },
        });
        vscode.window.showInformationMessage(
          'Showing cached content. Login to interact.',
        );
        return;
      }
      if (choice !== 'login') return;
    }

    try {
      this.currentConversationId = sessionId;
      this.sendToWebView({
        type: 'qwenSessionSwitched',
        data: { sessionId, messages: [] },
      });
      await this.agentManager.loadSessionViaAcp(sessionId);
      this.isTitleSet = false;
      await this.handleGetQwenSessions();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (isAuthError(errorMsg)) {
        await this.promptLogin(
          'Your login session has expired. Please login again.',
        );
        this.sendToWebView({
          type: 'sessionExpired',
          data: { message: 'Session expired.' },
        });
      } else {
        this.sendToWebView({
          type: 'error',
          data: { message: `Failed to resume session: ${error}` },
        });
      }
    }
  }

  private async handleSetApprovalMode(data?: {
    modeId?: ApprovalModeValue;
  }): Promise<void> {
    const modeId = data?.modeId || 'default';
    await this.agentManager.setApprovalModeFromUi(modeId).catch((error) => {
      this.sendToWebView({
        type: 'error',
        data: { message: `Failed to set mode: ${error}` },
      });
    });
  }

  private async handleSetModel(data?: { modelId?: string }): Promise<void> {
    const modelId = data?.modelId;
    if (!modelId) {
      this.sendToWebView({
        type: 'error',
        data: { message: 'Model ID is required' },
      });
      return;
    }
    try {
      await this.agentManager.setModelFromUi(modelId);
      void vscode.window.showInformationMessage(
        `Model switched to: ${modelId}`,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to switch model: ${errorMsg}`);
      this.sendToWebView({
        type: 'error',
        data: { message: `Failed to set model: ${errorMsg}` },
      });
    }
  }
}
