/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { logger } from '../../utils/logger.js';
import * as vscode from 'vscode';
import { BaseMessageHandler } from './BaseMessageHandler.js';
import { getFileName } from '../utils/webviewUtils.js';
import { getErrorMessage } from '../../utils/errorMessage.js';

/**
 * Editor message handler
 * Handles all editor state-related messages
 */
export class EditorMessageHandler extends BaseMessageHandler {
  canHandle(messageType: string): boolean {
    return ['getActiveEditor', 'focusActiveEditor', 'openExternalUrl'].includes(
      messageType,
    );
  }

  async handle(message: { type: string; data?: unknown }): Promise<void> {
    switch (message.type) {
      case 'openExternalUrl':
        await this.handleOpenExternalUrl(message.data);
        break;

      case 'getActiveEditor':
        await this.handleGetActiveEditor();
        break;

      case 'focusActiveEditor':
        await this.handleFocusActiveEditor();
        break;

      default:
        logger.warn(
          '[EditorMessageHandler] Unknown message type:',
          message.type,
        );
        break;
    }
  }

  private async handleOpenExternalUrl(data: unknown): Promise<void> {
    const value =
      data && typeof data === 'object'
        ? (data as { url?: unknown }).url
        : undefined;
    try {
      if (typeof value !== 'string') throw new Error('Invalid external URL.');
      const url = new URL(value);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password
      ) {
        throw new Error('Only HTTP and HTTPS URLs can be opened.');
      }
      if (!(await vscode.env.openExternal(vscode.Uri.parse(url.toString())))) {
        throw new Error(
          'Could not open the browser. Please use the displayed link.',
        );
      }
    } catch (error) {
      this.sendToWebView({
        type: 'error',
        data: { message: getErrorMessage(error) },
      });
    }
  }

  /**
   * Get current active editor info
   */
  private async handleGetActiveEditor(): Promise<void> {
    try {
      const activeEditor = vscode.window.activeTextEditor;

      if (activeEditor) {
        const filePath = activeEditor.document.uri.fsPath;
        const fileName = getFileName(filePath);

        let selectionInfo = null;
        if (!activeEditor.selection.isEmpty) {
          const selection = activeEditor.selection;
          selectionInfo = {
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
          };
        }

        this.sendToWebView({
          type: 'activeEditorChanged',
          data: { fileName, filePath, selection: selectionInfo },
        });
      } else {
        this.sendToWebView({
          type: 'activeEditorChanged',
          data: { fileName: null, filePath: null, selection: null },
        });
      }
    } catch (error) {
      logger.error(
        '[EditorMessageHandler] Failed to get active editor:',
        error,
      );
    }
  }

  /**
   * Focus on active editor
   */
  private async handleFocusActiveEditor(): Promise<void> {
    try {
      const activeEditor = vscode.window.activeTextEditor;

      if (activeEditor) {
        await vscode.window.showTextDocument(activeEditor.document, {
          viewColumn: activeEditor.viewColumn,
          preserveFocus: false,
        });
      } else {
        // If no active editor, show file picker
        const uri = await vscode.window.showOpenDialog({
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
          canSelectMany: false,
          canSelectFiles: true,
          canSelectFolders: false,
          openLabel: 'Open',
        });

        if (uri && uri.length > 0) {
          await vscode.window.showTextDocument(uri[0]);
        }
      }
    } catch (error) {
      logger.error(
        '[EditorMessageHandler] Failed to focus active editor:',
        error,
      );
      vscode.window.showErrorMessage(
        `Failed to focus editor: ${getErrorMessage(error)}`,
      );
    }
  }
}
