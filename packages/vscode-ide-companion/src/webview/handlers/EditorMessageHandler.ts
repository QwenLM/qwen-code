/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { BaseMessageHandler } from './BaseMessageHandler.js';
import { getFileName } from '../utils/webviewUtils.js';

/**
 * Editor message handler
 * Handles all editor state-related messages
 */
export class EditorMessageHandler extends BaseMessageHandler {
  canHandle(messageType: string): boolean {
    return ['getActiveEditor', 'focusActiveEditor'].includes(messageType);
  }

  async handle(message: { type: string; data?: unknown }): Promise<void> {
    switch (message.type) {
      case 'getActiveEditor':
        await this.handleGetActiveEditor();
        break;

      case 'focusActiveEditor':
        await this.handleFocusActiveEditor();
        break;

      default:
        console.warn(
          '[EditorMessageHandler] Unknown message type:',
          message.type,
        );
        break;
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
      console.error(
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
      console.error(
        '[EditorMessageHandler] Failed to focus active editor:',
        error,
      );
      vscode.window.showErrorMessage(`Failed to focus editor: ${error}`);
    }
  }
}
