/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { logger } from '../../utils/logger.js';
import * as vscode from 'vscode';
import { pathToFileURL } from 'node:url';
import { BaseMessageHandler } from './BaseMessageHandler.js';
import type { ChatMessage } from '../../services/qwenAgentManager.js';
import type { Conversation } from '../../services/conversationStore.js';
import {
  getDisplayableImageMimeType,
  type ImageAttachment,
} from '../../utils/imageSupport.js';
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
  const markdownLinkPath = pathToFileURL(filePath)
    .href.replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
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
                isImage?: boolean;
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
                isImage?: boolean;
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
          logger.error(
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
        logger.warn(
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
      logger.warn(
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
   *   `this.currentRequestId`, the call is silently dropped â€” this
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
      logger.warn(
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
      logger.error('[SessionMessageHandler] Failed to export session:', error);
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
      isImage?: boolean;
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
    logger.log('[SessionMessageHandler] handleSendMessage called', {
      textLength: text.length,
      attachmentCount: attachments?.length ?? 0,
    });
    // Guard: do not process empty or whitespace-only messages.
    // This prevents ghost user-message bubbles when slash-command completions
    // or model-selector interactions clear the input but still trigger a submit.
    const trimmedText = stripZeroWidthSpï^{¶‰Ëkºwµç_HØ]Ú
ØY\œ›ÜŠHÂˆÙÙÙ\‹Ø\›Šˆ	ÖÔÙ\ÜÚ[Û“Y\ÜØYÙR[™\—HÙ\ÜÚ[Û‹ÛØY˜Z[Y\Ú[™È˜[˜XÚÎ‰ËˆØY\œ›Ü‹ˆ
NÂ‚ˆËÈÚXÚÈ›Üˆ]][XØ][Û‹ÜÙ\ÜÚ[Ûˆ^\˜][Ûˆ\œ›ÜœÂˆYˆ
\ËœÚİ[›Û\]]
ØY\œ›ÜŠJHÂˆËÈÚİÈH[Ü™H\Ù\‹YœšY[™H\œ›ÜˆY\ÜØYÙH›Üˆ^\™YÙ\ÜÚ[ÛœÂˆ]ØZ]\Ëœ›Û\]]
ˆ	Ö[İ\ˆÙ\ÜÚ[Ûˆ\È^\™YÜˆ\È[˜[YˆX\ÙHÛÛ™šYİ\™H[İ\ˆ›İšY\ˆÈİÚ]ÚÙ\ÜÚ[ÛœË‰Ëˆ
NÂ‚ˆËÈÙ[™HÜXÚYšXÈ\œ›ÜˆÈHÙXšY]È›Üˆ™]\ˆRH[™[™Âˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	ÜÙ\ÜÚ[Û‘^\™Y	Ëˆ]NˆÈY\ÜØYÙNˆ	ÔÙ\ÜÚ[Ûˆ^\™YˆX\ÙH]][XØ]HYØZ[‹‰ÈKˆJNÂˆ™]\›ÂˆB‚ˆËÈ˜[˜XÚÎˆÜ™X]H™]ÈÙ\ÜÚ[Û‚ˆÛÛœİY\ÜØYÙ\ÈH]ØZ]\Ë˜YÙ[X[˜YÙ\‹™Ù]Ù\ÜÚ[Û“Y\ÜØYÙ\ÊÙ\ÜÚ[Û’Y
NÂ‚ˆËÈYˆÙH\™HÛÛ›™XİYHÈÜ™X]HHœ™\ÚPÔÙ\ÜÚ[ÛˆÛÈ\Ù\ˆØ[ˆ[\˜XİˆYˆ
\Ë˜YÙ[X[˜YÙ\‹š\ĞÛÛ›™XİY
HÂˆHÂˆ]ØZ]\Ë˜YÙ[X[˜YÙ\‹˜Ü™X]S™]ÔÙ\ÜÚ[ÛŠÛÜšÚ[™Ñ\‹Âˆ›Ü˜ÙS™]ÎˆYKˆJNÂ‚ˆËÈÙY\HšY]ÙYÙ\ÜÚ[ÛˆY[]H[YÛ™YÚ]Ú]HÙXšY]ÈÙY\ÂˆËÈ
H\˜Ú]™YÙ\ÜÚ[Û’Y
KˆH]™HPÔÙ\ÜÚ[Ûˆ]™\ÈÛ‚ˆËÈYÙ[X[˜YÙ\‹˜İ\œ™[Ù\ÜÚ[Û’YÈHŞ[˜Ë[Û‹Yš\œİ[Y\ÜØYÙH]ˆËÈ
ÙYHİ™X[Q[™[™\ŠHÚ[›\›İÚY\ÈÈHPÔYÛ˜ÙBˆËÈH\Ù\ˆXİX[HÙ[™ÈHY\ÜØYÙKˆÙ][™Èİ\œ™[ÛÛ™\œØ][Û’YˆËÈÈH™]ÈPÔY\™HÛİ[\Ş[˜ÈH˜XÚÙ[™œ›ÛHHÙXšY]ÂˆËÈ[™Ø]\ÙH™[˜[YKÙ[]Kİ]K]\]H›İÜÈÈ\™Ù]HÜ›Û™ÂˆËÈÙ\ÜÚ[Ûˆ\š[™ÈH˜[˜XÚÈÚ[™İË‚ˆ\Ë\]Pİ\œ™[ÛÛ™\œØ][Û’Y
Ù\ÜÚ[Û’Y
NÂ‚ˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ü]Ù[”Ù\ÜÚ[Û”İÚ]ÚY	Ëˆ]NˆÈÙ\ÜÚ[Û’YY\ÜØYÙ\ËÙ\ÜÚ[ÛˆÙ\ÜÚ[Û‘]Z[ÈKˆJNÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	ÜÙ\ÜÚ[Û“ØYÛÛ\]IËˆ]NˆÈÙ\ÜÚ[Û’YKˆJNÂ‚ˆËÈÛ›HÚİÈHØXÚHØ\›š[™ÈYˆÙHXİX[H™[˜XÚÈÈØØ[ØXÚBˆËÈ[™Y‰İİXØÙ\ÜÙ[HØYšXHPÔˆËÈÚXÚÈYˆÙH[H™[˜XÚÈHÚXÚÚ[™ÈYˆØY\œ›Üˆ\È›İ[İ[™Yš[™YˆËÈ[™Yˆ]	ÜÈ›İHİXØÙ\ÜÙ[™\ÜÛœÙH]ÛÚÜÈZÙH[ˆ\œ›Ü‚ˆYˆ
ˆØY\œ›Üˆ	‰‚ˆ\[ÙˆØY\œ›ÜˆOOH	ÛØš™Xİ	È	‰‚ˆJ	Ü™\İ[	È[ˆØY\œ›ÜŠBˆ
HÂˆœØÛÙKÚ[™İËœÚİÕØ\›š[™ÓY\ÜØYÙJˆ	ÔÙ\ÜÚ[Ûˆ™\İÜ™Yœ›ÛHØØ[ØXÚKˆÛÛYHÛÛ^X^H™H[˜ÛÛ\]K‰Ëˆ
NÂˆBˆHØ]Ú
Ü™X]Q\œ›ÜŠHÂˆÙÙÙ\‹™\œ›ÜŠˆ	ÖÔÙ\ÜÚ[Û“Y\ÜØYÙR[™\—H˜Z[YÈÜ™X]HÙ\ÜÚ[Û‰ËˆÜ™X]Q\œ›Ü‹ˆ
NÂ‚ˆËÈÚXÚÈ›Üˆ]][XØ][Û‹ÜÙ\ÜÚ[Ûˆ^\˜][Ûˆ\œ›ÜœÈ[ˆÙ\ÜÚ[ÛˆÜ™X][Û‚ˆYˆ
\ËœÚİ[›Û\]]
Ü™X]Q\œ›ÜŠJHÂˆËÈÚİÈH[Ü™H\Ù\‹YœšY[™H\œ›ÜˆY\ÜØYÙH›Üˆ^\™YÙ\ÜÚ[ÛœÂˆ]ØZ]\Ëœ›Û\]]
ˆ	Ö[İ\ˆÙ\ÜÚ[Ûˆ\È^\™YÜˆ\È[˜[YˆX\ÙHÛÛ™šYİ\™H[İ\ˆ›İšY\ˆÈİÚ]ÚÙ\ÜÚ[ÛœË‰Ëˆ
NÂ‚ˆËÈÙ[™HÜXÚYšXÈ\œ›ÜˆÈHÙXšY]È›Üˆ™]\ˆRH[™[™Âˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	ÜÙ\ÜÚ[Û‘^\™Y	Ëˆ]NˆÂˆY\ÜØYÙNˆ	ÔÙ\ÜÚ[Ûˆ^\™YˆX\ÙH]][XØ]HYØZ[‹‰ËˆKˆJNÂˆ™]\›ÂˆB‚ˆ›İÈÜ™X]Q\œ›ÜÂˆBˆH[ÙHÂˆËÈÙ™›[™HšY]ÈÛ›Bˆ\Ë\]Pİ\œ™[ÛÛ™\œØ][Û’Y
Ù\ÜÚ[Û’Y
NÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ü]Ù[”Ù\ÜÚ[Û”İÚ]ÚY	Ëˆ]NˆÈÙ\ÜÚ[Û’YY\ÜØYÙ\ËÙ\ÜÚ[ÛˆÙ\ÜÚ[Û‘]Z[ÈKˆJNÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	ÜÙ\ÜÚ[Û“ØYÛÛ\]IËˆ]NˆÈÙ\ÜÚ[Û’YKˆJNÂˆœØÛÙKÚ[™İËœÚİÕØ\›š[™ÓY\ÜØYÙJˆ	ÔÚİÚ[™ÈØXÚYÙ\ÜÚ[ÛˆÛÛ[ˆÛÛ™šYİ\™H[İ\ˆ›İšY\ˆÈ[\˜XİÚ]HRK‰Ëˆ
NÂˆBˆBˆHØ]Ú
\œ›ÜŠHÂˆÙÙÙ\‹™\œ›ÜŠ	ÖÔÙ\ÜÚ[Û“Y\ÜØYÙR[™\—H˜Z[YÈİÚ]ÚÙ\ÜÚ[Û‰Ë\œ›ÜŠNÂ‚ˆËÈØY™[HÛÛ™\\œ›ÜˆÈİš[™ÂˆÛÛœİ\œ›Ü“\ÙÈH\Ë™Ù]\œ›Ü“Y\ÜØYÙJ\œ›ÜŠNÂˆËÈÚXÚÈ›Üˆ]][XØ][Û‹ÜÙ\ÜÚ[Ûˆ^\˜][Ûˆ\œ›ÜœÂˆYˆ
\ËœÚİ[›Û\]]
\œ›ÜŠJHÂˆËÈÚİÈH[Ü™H\Ù\‹YœšY[™H\œ›ÜˆY\ÜØYÙH›Üˆ^\™YÙ\ÜÚ[ÛœÂˆ]ØZ]\Ëœ›Û\]]
ˆ	Ö[İ\ˆÙ\ÜÚ[Ûˆ\È^\™YÜˆ\È[˜[YˆX\ÙHÛÛ™šYİ\™H[İ\ˆ›İšY\ˆÈİÚ]ÚÙ\ÜÚ[ÛœË‰Ëˆ
NÂ‚ˆËÈÙ[™HÜXÚYšXÈ\œ›ÜˆÈHÙXšY]È›Üˆ™]\ˆRH[™[™Âˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	ÜÙ\ÜÚ[Û‘^\™Y	Ëˆ]NˆÈY\ÜØYÙNˆ	ÔÙ\ÜÚ[Ûˆ^\™YˆX\ÙH]][XØ]HYØZ[‹‰ÈKˆJNÂˆH[ÙHÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ù\œ›Ü‰Ëˆ]NˆÈY\ÜØYÙNˆ˜Z[YÈİÚ]ÚÙ\ÜÚ[Ûˆ	Ù\œ›Ü“\ÙßXKˆJNÂˆBˆBˆB‚ˆÊŠ‚ˆ
ˆ[™HÙ]]Ù[ˆÙ\ÜÚ[ÛœÈ™\]Y\İˆ
‹Âˆš]˜]H\Ş[˜È[™QÙ]]Ù[”Ù\ÜÚ[ÛœÊˆİ\œÛÜÎˆ[X™\‹ˆÚ^™OÎˆ[X™\‹ˆ
Nˆ›ÛZ\ÙO›ÚYˆÂˆHÂˆËÈYÙYÚ[ˆÜÜÚX›NÈ˜[È˜XÚÈÈ[\İYˆPÔ›İİ\ÜYˆÛÛœİYÙHH]ØZ]\Ë˜YÙ[X[˜YÙ\‹™Ù]Ù\ÜÚ[Û“\İYÙY
Âˆİ\œÛÜ‹ˆÚ^™KˆJNÂˆÛÛœİ\[™H\[Ùˆİ\œÛÜˆOOH	Û[X™\‰ÎÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ü]Ù[”Ù\ÜÚ[Û“\İ	Ëˆ]NˆÂˆÙ\ÜÚ[ÛœÎˆYÙKœÙ\ÜÚ[ÛœËˆ™^İ\œÛÜˆYÙK›™^İ\œÛÜ‹ˆ\Ó[Ü™NˆYÙKš\Ó[Ü™Kˆ\[™ˆKˆJNÂˆHØ]Ú
\œ›ÜŠHÂˆÙÙÙ\‹™\œ›ÜŠ	ÖÔÙ\ÜÚ[Û“Y\ÜØYÙR[™\—H˜Z[YÈÙ]Ù\ÜÚ[ÛœÎ‰Ë\œ›ÜŠNÂ‚ˆËÈØY™[HÛÛ™\\œ›ÜˆÈİš[™ÂˆÛÛœİ\œ›Ü“\ÙÈH\Ë™Ù]\œ›Ü“Y\ÜØYÙJ\œ›ÜŠNÂˆËÈÚXÚÈ›Üˆ]][XØ][Û‹ÜÙ\ÜÚ[Ûˆ^\˜][Ûˆ\œ›ÜœÂˆYˆ
\ËœÚİ[›Û\]]
\œ›ÜŠJHÂˆËÈÚİÈH[Ü™H\Ù\‹YœšY[™H\œ›ÜˆY\ÜØYÙH›Üˆ^\™YÙ\ÜÚ[ÛœÂˆ]ØZ]\Ëœ›Û\]]
ˆ	Ö[İ\ˆÙ\ÜÚ[Ûˆ\È^\™YÜˆ\È[˜[YˆX\ÙHÛÛ™šYİ\™H[İ\ˆ›İšY\ˆÈšY]ÈÙ\ÜÚ[ÛœË‰Ëˆ
NÂ‚ˆËÈÙ[™HÜXÚYšXÈ\œ›ÜˆÈHÙXšY]È›Üˆ™]\ˆRH[™[™Âˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	ÜÙ\ÜÚ[Û‘^\™Y	Ëˆ]NˆÈY\ÜØYÙNˆ	ÔÙ\ÜÚ[Ûˆ^\™YˆX\ÙH]][XØ]HYØZ[‹‰ÈKˆJNÂˆH[ÙHÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ù\œ›Ü‰Ëˆ]NˆÈY\ÜØYÙNˆ˜Z[YÈÙ]Ù\ÜÚ[ÛœÎˆ	Ù\œ›Ü“\ÙßXKˆJNÂˆBˆBˆB‚ˆÊŠ‚ˆ
ˆ[™HØ[˜Ù[İ™X[Z[™È™\]Y\İˆ
‹Âˆš]˜]H\Ş[˜È[™PØ[˜Ù[İ™X[Z[™Ê
Nˆ›ÛZ\ÙO›ÚYˆÂˆHÂˆÙÙÙ\‹›ÙÊ	ÖÔÙ\ÜÚ[Û“Y\ÜØYÙR[™\—HØ[˜Ù[[™Èİ™X[Z[™Ë‹‹‰ÊNÂ‚ˆËÈØ[˜Ù[Hİ\œ™[İ™X[Z[™ÈÜ\˜][Ûˆ[ˆHYÙ[X[˜YÙ\‚ˆ]ØZ]\Ë˜YÙ[X[˜YÙ\‹˜Ø[˜Ù[İ\œ™[›Û\

NÂ‚ˆËÈ\ÙHÙ[™İ™X[Q[™È[˜ÛYH™\]Y\İY›Üˆ›Ü\ˆÛÜœ™[][Û‚ˆ\ËœÙ[™İ™X[Q[™
	İ\Ù\—ØØ[˜Ù[Y	ÊNÂ‚ˆÙÙÙ\‹›ÙÊ	ÖÔÙ\ÜÚ[Û“Y\ÜØYÙR[™\—Hİ™X[Z[™ÈØ[˜Ù[YİXØÙ\ÜÙ[IÊNÂˆHØ]Ú
Ù\œ›ÜŠHÂˆÙÙÙ\‹›ÙÊ	ÖÔÙ\ÜÚ[Û“Y\ÜØYÙR[™\—Hİ™X[Z[™ÈØ[˜Ù[Y
[\œ\Y
IÊNÂ‚ˆËÈ\ÙHÙ[™İ™X[Q[™
Ú]\XØ]HİX\™
HÈ[˜ÛYH™\]Y\İYˆ\ËœÙ[™İ™X[Q[™
	İ\Ù\—ØØ[˜Ù[Y	ÊNÂˆBˆB‚ˆÊŠ‚ˆ
ˆ[™H™\İ[YHÙ\ÜÚ[Ûˆ™\]Y\İˆ
‹Âˆš]˜]H\Ş[˜È[™T™\İ[YTÙ\ÜÚ[ÛŠÙ\ÜÚ[Û’Yˆİš[™ÊNˆ›ÛZ\ÙO›ÚYˆÂˆHÂˆËÈYˆ›İÛÛ›™XİYÙ™™\ˆÈ]][XØ]HÜˆšY]ÈÙ™›[™BˆYˆ
]\Ë˜YÙ[X[˜YÙ\‹š\ĞÛÛ›™XİY
HÂˆÛÛœİÚÚXÙHH]ØZ]\Ëœ›Û\]]Ü“Ù™›[™Jˆ	Ö[İH\™H›İ]][XØ]YˆÛÛ™šYİ\™H[İ\ˆ›İšY\ˆÈ[H™\İÜ™H\ÈÙ\ÜÚ[Û‹ÜˆšY]È]Ù™›[™K‰Ëˆ
NÂ‚ˆYˆ
ÚÚXÙHOOH	ÛÙ™›[™IÊHÂˆÛÛœİY\ÜØYÙ\ÈBˆ]ØZ]\Ë˜YÙ[X[˜YÙ\‹™Ù]Ù\ÜÚ[Û“Y\ÜØYÙ\ÊÙ\ÜÚ[Û’Y
NÂˆ\Ë\]Pİ\œ™[ÛÛ™\œØ][Û’Y
Ù\ÜÚ[Û’Y
NÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ü]Ù[”Ù\ÜÚ[Û”İÚ]ÚY	Ëˆ]NˆÈÙ\ÜÚ[Û’YY\ÜØYÙ\ÈKˆJNÂˆœØÛÙKÚ[™İËœÚİÒ[™›Ü›X][Û“Y\ÜØYÙJˆ	ÔÚİÚ[™ÈØXÚYÙ\ÜÚ[ÛˆÛÛ[ˆÛÛ™šYİ\™H[İ\ˆ›İšY\ˆÈ[\˜XİÚ]HRK‰Ëˆ
NÂˆ™]\›ÂˆH[ÙHYˆ
ÚÚXÙHOOH	Ø]]	ÊHÂˆ™]\›ÂˆBˆB‚ˆËÈHPÔØYš\œİˆHÂˆËÈ™KXÛX\ˆRHÛÈ™\^YY\]\È\[™Y\Ø\™Âˆ\Ë\]Pİ\œ™[ÛÛ™\œØ][Û’Y
Ù\ÜÚ[Û’Y
NÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ü]Ù[”Ù\ÜÚ[Û”İÚ]ÚY	Ëˆ]NˆÈÙ\ÜÚ[Û’YY\ÜØYÙ\Îˆ×HKˆJNÂ‚ˆ]ØZ]\Ë˜YÙ[X[˜YÙ\‹›ØYÙ\ÜÚ[Û•šXPXÜ
Ù\ÜÚ[Û’Y
NÂ‚ˆËÈ™\Ù]]H›YÈÚ[ˆ™\İ[Z[™ÈÙ\ÜÚ[ÛœÂˆ\Ëš\Õ]TÙ]H˜[ÙNÂ‚ˆËÈİXØÙ\ÜÙ[HØYYÙ\ÜÚ[Û‹™]\›ˆX\›HÈ]›ÚY˜[˜XÚÈÙÚXÂˆ]ØZ]\Ëš[™QÙ]]Ù[”Ù\ÜÚ[ÛœÊ
NÂˆ™]\›ÂˆHØ]Ú
XÜ\œ›ÜŠHÂˆËÈÚXÚÈ›Üˆ]][XØ][Û‹ÜÙ\ÜÚ[Ûˆ^\˜][Ûˆ\œ›ÜœÂˆYˆ
\ËœÚİ[›Û\]]
XÜ\œ›ÜŠJHÂˆËÈÚİÈH[Ü™H\Ù\‹YœšY[™H\œ›ÜˆY\ÜØYÙH›Üˆ^\™YÙ\ÜÚ[ÛœÂˆ]ØZ]\Ëœ›Û\]]
ˆ	Ö[İ\ˆÙ\ÜÚ[Ûˆ\È^\™YÜˆ\È[˜[YˆX\ÙHÛÛ™šYİ\™H[İ\ˆ›İšY\ˆÈ™\İ[YHÙ\ÜÚ[ÛœË‰Ëˆ
NÂ‚ˆËÈÙ[™HÜXÚYšXÈ\œ›ÜˆÈHÙXšY]È›Üˆ™]\ˆRH[™[™Âˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	ÜÙ\ÜÚ[Û‘^\™Y	Ëˆ]NˆÈY\ÜØYÙNˆ	ÔÙ\ÜÚ[Ûˆ^\™YˆX\ÙH]][XØ]HYØZ[‹‰ÈKˆJNÂˆ™]\›ÂˆBˆB‚ˆ]ØZ]\Ëš[™QÙ]]Ù[”Ù\ÜÚ[ÛœÊ
NÂˆHØ]Ú
\œ›ÜŠHÂˆÙÙÙ\‹™\œ›ÜŠ	ÖÔÙ\ÜÚ[Û“Y\ÜØYÙR[™\—H˜Z[YÈ™\İ[YHÙ\ÜÚ[Û‰Ë\œ›ÜŠNÂ‚ˆËÈØY™[HÛÛ™\\œ›ÜˆÈİš[™ÂˆÛÛœİ\œ›Ü“\ÙÈH\Ë™Ù]\œ›Ü“Y\ÜØYÙJ\œ›ÜŠNÂˆËÈÚXÚÈ›Üˆ]][XØ][Û‹ÜÙ\ÜÚ[Ûˆ^\˜][Ûˆ\œ›ÜœÂˆYˆ
\ËœÚİ[›Û\]]
\œ›ÜŠJHÂˆËÈÚİÈH[Ü™H\Ù\‹YœšY[™H\œ›ÜˆY\ÜØYÙH›Üˆ^\™YÙ\ÜÚ[ÛœÂˆ]ØZ]\Ëœ›Û\]]
ˆ	Ö[İ\ˆÙ\ÜÚ[Ûˆ\È^\™YÜˆ\È[˜[YˆX\ÙHÛÛ™šYİ\™H[İ\ˆ›İšY\ˆÈ™\İ[YHÙ\ÜÚ[ÛœË‰Ëˆ
NÂ‚ˆËÈÙ[™HÜXÚYšXÈ\œ›ÜˆÈHÙXšY]È›Üˆ™]\ˆRH[™[™Âˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	ÜÙ\ÜÚ[Û‘^\™Y	Ëˆ]NˆÈY\ÜØYÙNˆ	ÔÙ\ÜÚ[Ûˆ^\™YˆX\ÙH]][XØ]HYØZ[‹‰ÈKˆJNÂˆH[ÙHÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ù\œ›Ü‰Ëˆ]NˆÈY\ÜØYÙNˆ˜Z[YÈ™\İ[YHÙ\ÜÚ[Ûˆ	Ù\œ›Ü“\ÙßXKˆJNÂˆBˆBˆB‚ˆÊŠ‚ˆ
ˆ[™H[]HÙ\ÜÚ[Ûˆ™\]Y\İˆ
‹Âˆš]˜]H\Ş[˜È[™Q[]T]Ù[”Ù\ÜÚ[ÛŠÙ\ÜÚ[Û’Yˆİš[™ÊNˆ›ÛZ\ÙO›ÚYˆÂˆHÂˆYˆ
ˆÙ\ÜÚ[Û’YOOH\Ë˜İ\œ™[ÛÛ™\œØ][Û’YˆÙ\ÜÚ[Û’YOOH\Ë˜YÙ[X[˜YÙ\‹˜İ\œ™[Ù\ÜÚ[Û’Yˆ
HÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ù\œ›Ü‰Ëˆ]NˆÈY\ÜØYÙNˆ	ĞØ[››İ[]HHİ\œ™[Xİ]™HÙ\ÜÚ[Û‹‰ÈKˆJNÂˆ™]\›ÂˆB‚ˆÛÛœİİXØÙ\ÜÈH]ØZ]\Ë˜YÙ[X[˜YÙ\‹™[]TÙ\ÜÚ[ÛŠÙ\ÜÚ[Û’Y
NÂˆYˆ
İXØÙ\ÜÊHÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	ÜÙ\ÜÚ[Û‘[]Y	Ëˆ]NˆÈÙ\ÜÚ[Û’YKˆJNÂˆH[ÙHÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ù\œ›Ü‰Ëˆ]NˆÈY\ÜØYÙNˆ	Ñ˜Z[YÈ[]HÙ\ÜÚ[Û‹‰ÈKˆJNÂˆBˆHØ]Ú
\œ›ÜŠHÂˆÛÛœİ\œ›Ü“\ÙÈH\Ë™Ù]\œ›Ü“Y\ÜØYÙJ\œ›ÜŠNÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ù\œ›Ü‰Ëˆ]NˆÈY\ÜØYÙNˆ˜Z[YÈ[]HÙ\ÜÚ[Ûˆ	Ù\œ›Ü“\ÙßXKˆJNÂˆBˆB‚ˆÊŠ‚ˆ
ˆ[™H™[˜[YHÙ\ÜÚ[Ûˆ™\]Y\İˆ
‹Âˆš]˜]H\Ş[˜È[™T™[˜[YT]Ù[”Ù\ÜÚ[ÛŠˆÙ\ÜÚ[Û’Yˆİš[™Ëˆ]Nˆİš[™Ëˆ
Nˆ›ÛZ\ÙO›ÚYˆÂˆHÂˆÛÛœİš[[YY]HH]Kš[J
Kœ™\XÙJÖ×——JËÙË	È	ÊNÂˆYˆ
]š[[YY]JHÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ù\œ›Ü‰Ëˆ]NˆÈY\ÜØYÙNˆ	ÔX\ÙH›İšYHH˜[YK‰ÈKˆJNÂˆ™]\›ÂˆBˆËÈX]Ú\ÈÑTÔÒSÓ—ÕUWÓPVÓS‘Õœ›ÛH]Ù[‹XÛÙKÜ]Ù[‹XÛÙKXÛÜ™KÜÙ\ÜÚ[Û”Ù\šXÙBˆYˆ
š[[YY]K›[™İˆŒ
HÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ù\œ›Ü‰Ëˆ]NˆÈY\ÜØYÙNˆ	Ó˜[YH\ÈÛÈÛ™ËˆX^[][HŒÚ\˜Xİ\œË‰ÈKˆJNÂˆ™]\›ÂˆB‚ˆÛÛœİİXØÙ\ÜÈH]ØZ]\Ë˜YÙ[X[˜YÙ\‹œ™[˜[YTÙ\ÜÚ[ÛŠˆÙ\ÜÚ[Û’Yˆš[[YY]Kˆ
NÂˆYˆ
İXØÙ\ÜÊHÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	ÜÙ\ÜÚ[Û”™[˜[YY	Ëˆ]NˆÈÙ\ÜÚ[Û’Y]Nˆš[[YY]HKˆJNÂˆYˆ
Ù\ÜÚ[Û’YOOH\Ë˜İ\œ™[ÛÛ™\œØ][Û’Y
HÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	ÜÙ\ÜÚ[Û•]U\]Y	Ëˆ]NˆÈÙ\ÜÚ[Û’Y]Nˆš[[YY]HKˆJNÂˆBˆH[ÙHÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ù\œ›Ü‰Ëˆ]NˆÈY\ÜØYÙNˆ	Ñ˜Z[YÈ™[˜[YHÙ\ÜÚ[Û‹‰ÈKˆJNÂˆBˆHØ]Ú
\œ›ÜŠHÂˆÛÛœİ\œ›Ü“\ÙÈH\Ë™Ù]\œ›Ü“Y\ÜØYÙJ\œ›ÜŠNÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ù\œ›Ü‰Ëˆ]NˆÈY\ÜØYÙNˆ˜Z[YÈ™[˜[YHÙ\ÜÚ[Ûˆ	Ù\œ›Ü“\ÙßXKˆJNÂˆBˆB‚ˆÊŠ‚ˆ
ˆÙ]\›İ˜[[ÙHšXHYÙ[
PÔÙ\ÜÚ[Û‹ÜÙ]Û[ÙJBˆ
‹Âˆš]˜]H\Ş[˜È[™TÙ]\›İ˜[[ÙJ]OÎˆÂˆ[ÙRYÎˆ\›İ˜[[ÙU˜[YNÂˆJNˆ›ÛZ\ÙO›ÚYˆÂˆHÂˆÛÛœİ[ÙRYH]OË›[ÙRY	ÙY˜][	ÎÂˆ]ØZ]\Ë˜YÙ[X[˜YÙ\‹œÙ]\›İ˜[[ÙQœ›ÛUZJ[ÙRY
NÂˆËÈ›È^XÚ]™\ÜÛœÙH™YYYÈÙX•šY]È\İ[œÈ›Üˆ[ÙPÚ[™ÙYˆHØ]Ú
\œ›ÜŠHÂˆÙÙÙ\‹™\œ›ÜŠ	ÖÔÙ\ÜÚ[Û“Y\ÜØYÙR[™\—H˜Z[YÈÙ][ÙN‰Ë\œ›ÜŠNÂˆÛÛœİ\œ›Ü“\ÙÈH\Ë™Ù]\œ›Ü“Y\ÜØYÙJ\œ›ÜŠNÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ù\œ›Ü‰Ëˆ]NˆÈY\ÜØYÙNˆ˜Z[YÈÙ][ÙNˆ	Ù\œ›Ü“\ÙßXKˆJNÂˆBˆB‚ˆÊŠ‚ˆ
ˆÙ][Ù[šXHYÙ[
PÔÙ\ÜÚ[Û‹ÜÙ]Û[Ù[
Bˆ
ˆ\Ü^\È”ĞÛÙH˜]]™H›İYšXØ][ÛœÈÛˆİXØÙ\ÜÈÜˆ˜Z[\™K‚ˆ
‹Âˆš]˜]H\Ş[˜È[™TÙ][Ù[
]OÎˆÈ[Ù[YÎˆİš[™ÈJNˆ›ÛZ\ÙO›ÚYˆÂˆHÂˆÛÛœİ[Ù[YH]OË›[Ù[YÂˆYˆ
[[Ù[Y
HÂˆ›İÈ™]È\œ›ÜŠ	Ó[Ù[Q\È™\]Z\™Y	ÊNÂˆBˆËÈY™[œÚ]™HİX\™ˆ™Y\ÙH›Û‹\[[YH]Ù[ˆĞ]][Ù[È[ˆØ\ÙHHRBˆËÈ\È\\ÜÙY
›ÙÜ˜[[X]XÈØ[İ[HÙXšY]Ë™\İÜ™YÙ\ÜÚ[ÛŠK‚ˆYˆ
\Ñ\ØÛÛ[YY[Ù[
[Ù[Y
JHÂˆÙÙÙ\‹Ø\›Šˆ	ÖÔÙ\ÜÚ[Û“Y\ÜØYÙR[™\—H™Z™XİY\ØÛÛ[YY[Ù[	Ëˆ[Ù[Yˆ
NÂˆÛÛœİY\ÜØYÙHH˜Z[YÈİÚ]Ú[Ù[ˆ	ÑTĞÓÓ•S•QQÓQTÔĞQÑTË˜›ØÚÙY\œ›ÜŸXÂˆœØÛÙKÚ[™İËœÚİÑ\œ›Ü“Y\ÜØYÙJY\ÜØYÙJNÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ù\œ›Ü‰Ëˆ]NˆÈY\ÜØYÙHKˆJNÂˆ™]\›ÂˆBˆ]ØZ]\Ë˜YÙ[X[˜YÙ\‹œÙ][Ù[œ›ÛUZJ[Ù[Y
NÂˆ›ÚYœØÛÙKÚ[™İËœÚİÒ[™›Ü›X][Û“Y\ÜØYÙJˆ[Ù[İÚ]ÚYÎˆ	Û[Ù[YXˆ
NÂˆHØ]Ú
\œ›ÜŠHÂˆÛÛœİ\œ›Ü“\ÙÈH\Ë™Ù]\œ›Ü“Y\ÜØYÙJ\œ›ÜŠNÂˆÙÙÙ\‹™\œ›ÜŠ	ÖÔÙ\ÜÚ[Û“Y\ÜØYÙR[™\—H˜Z[YÈÙ][Ù[‰Ë\œ›ÜŠNÂˆœØÛÙKÚ[™İËœÚİÑ\œ›Ü“Y\ÜØYÙJ˜Z[YÈİÚ]Ú[Ù[ˆ	Ù\œ›Ü“\ÙßX
NÂˆ\ËœÙ[™ÕÙX•šY]ÊÂˆ\Nˆ	Ù\œ›Ü‰Ëˆ]NˆÈY\ÜØYÙNˆ˜Z[YÈÙ][Ù[ˆ	Ù\œ›Ü“\ÙßXKˆJNÂˆBˆBŸB