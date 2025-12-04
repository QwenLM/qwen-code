/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { getFileName } from './utils/webviewUtils.js';

/**
 * File Operations Handler
 * Responsible for handling file opening and diff viewing functionality
 */
export class FileOperations {
  /**
   * Open file and optionally navigate to specified line and column
   * @param filePath File path, can include line and column numbers (format: path/to/file.ts:123 or path/to/file.ts:123:45)
   */
  static async openFile(filePath?: string): Promise<void> {
    try {
      if (!filePath) {
        console.warn('[FileOperations] No file path provided');
        return;
      }

      console.log('[FileOperations] Opening file:', filePath);

      // Parse file path, line number, and column number
      // Formats: path/to/file.ts, path/to/file.ts:123, path/to/file.ts:123:45
      const match = filePath.match(/^(.+?)(?::(\d+))?(?::(\d+))?$/);
      if (!match) {
        console.warn('[FileOperations] Invalid file path format:', filePath);
        return;
      }

      const [, path, lineStr, columnStr] = match;
      const lineNumber = lineStr ? parseInt(lineStr, 10) - 1 : 0; // VS Code uses 0-based line numbers
      const columnNumber = columnStr ? parseInt(columnStr, 10) - 1 : 0; // VS Code uses 0-based column numbers

      // Convert to absolute path if relative
      let absolutePath = path;
      if (!path.startsWith('/') && !path.match(/^[a-zA-Z]:/)) {
        // Relative path - resolve against workspace
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          absolutePath = vscode.Uri.joinPath(workspaceFolder.uri, path).fsPath;
        }
      }

      // Open the document
      const uri = vscode.Uri.file(absolutePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
      });

      // Navigate to line and column if specified
      if (lineStr) {
        const position = new vscode.Position(lineNumber, columnNumber);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenter,
        );
      }

      console.log('[FileOperations] File opened successfully:', absolutePath);
    } catch (error) {
      console.error('[FileOperations] Failed to open file:', error);
      vscode.window.showErrorMessage(`Failed to open file: ${error}`);
    }
  }

  /**
   * Open diff view to compare file changes
   * @param data Diff data, including file path, old content, and new content
   */
  static async openDiff(data?: {
    path?: string;
    oldText?: string;
    newText?: string;
  }): Promise<void> {
    try {
      if (!data || !data.path) {
        console.warn('[FileOperations] No file path provided for diff');
        return;
      }

      const { path, oldText = '', newText = '' } = data;
      console.log('[FileOperations] Opening diff for:', path);

      // Convert to absolute path if relative
      let absolutePath = path;
      if (!path.startsWith('/') && !path.match(/^[a-zA-Z]:/)) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          absolutePath = vscode.Uri.joinPath(workspaceFolder.uri, path).fsPath;
        }
      }

      // Get the file name for display
      const fileName = getFileName(absolutePath);

      // Create URIs for old and new content
      // Use untitled scheme for old content (before changes)
      const oldUri = vscode.Uri.parse(`untitled:${absolutePath}.old`).with({
        scheme: 'untitled',
      });

      // Use the actual file URI for new content
      const newUri = vscode.Uri.file(absolutePath);

      // Create a TextDocument for the old content using an in-memory document
      const _oldDocument = await vscode.workspace.openTextDocument(
        oldUri.with({ scheme: 'untitled' }),
      );

      // Write old content to the document
      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        oldUri.with({ scheme: 'untitled' }),
        new vscode.Position(0, 0),
        oldText,
      );
      await vscode.workspace.applyEdit(edit);

      // Check if new file exists, if not create it with new content
      try {
        await vscode.workspace.fs.stat(newUri);
      } catch {
        // File doesn't exist, create it
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(newUri, encoder.encode(newText));
      }

      // Open diff view
      await vscode.commands.executeCommand(
        'vscode.diff',
        oldUri.with({ scheme: 'untitled' }),
        newUri,
        `${fileName} (Before ↔ After)`,
        {
          viewColumn: vscode.ViewColumn.Beside,
          preview: false,
          preserveFocus: false,
        },
      );

      console.log('[FileOperations] Diff opened successfully');
    } catch (error) {
      console.error('[FileOperations] Failed to open diff:', error);
      vscode.window.showErrorMessage(`Failed to open diff: ${error}`);
    }
  }
}
