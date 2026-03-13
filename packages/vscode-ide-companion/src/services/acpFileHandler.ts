/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ACP File Operation Handler
 *
 * Responsible for handling file read and write operations in the ACP protocol
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { getErrorMessage } from '../utils/errorMessage.js';

/**
 * ACP File Operation Handler Class
 * Provides file read and write functionality according to ACP protocol specifications
 */
export class AcpFileHandler {
  /**
   * Handle read text file request
   *
   * @param params - File read parameters
   * @param params.path - File path
   * @param params.sessionId - Session ID
   * @param params.line - Starting line number (optional)
   * @param params.limit - Read line limit (optional)
   * @returns File content
   * @throws Error when file reading fails
   */
  async handleReadTextFile(params: {
    path: string;
    sessionId: string;
    line: number | null;
    limit: number | null;
  }): Promise<{ content: string }> {
    console.log(`[ACP] fs/read_text_file request received for: ${params.path}`);
    console.log(`[ACP] Parameters:`, {
      line: params.line,
      limit: params.limit,
      sessionId: params.sessionId,
    });

    try {
      const uri = vscode.Uri.file(params.path);
      // openTextDocument handles encoding detection (BOM, files.encoding setting,
      // chardet) and returns properly decoded Unicode text regardless of the
      // source encoding (UTF-8, GBK, Shift-JIS, etc.).
      const document = await vscode.workspace.openTextDocument(uri);
      const content = document.getText();
      console.log(
        `[ACP] Successfully read file: ${params.path} (${content.length} chars)`,
      );

      // Handle line offset and limit.
      // ACP spec: `line` is 1-based (first line = 1).
      if (params.line !== null || params.limit !== null) {
        const lines = content.split('\n');
        const startLine = Math.max(0, (params.line ?? 1) - 1);
        const endLine = params.limit ? startLine + params.limit : lines.length;
        const selectedLines = lines.slice(startLine, endLine);
        const result = { content: selectedLines.join('\n') };
        console.log(`[ACP] Returning ${selectedLines.length} lines`);
        return result;
      }

      const result = { content };
      console.log(`[ACP] Returning full file content`);
      return result;
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(`[ACP] Failed to read file ${params.path}:`, errorMsg);

      // Detect "file not found" from both Node.js (code === 'ENOENT') and
      // VS Code's FileSystemError.FileNotFound (code === 'FileNotFound').
      const errorCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;

      if (errorCode === 'ENOENT' || errorCode === 'FileNotFound') {
        // Normalise to a Node-style ENOENT so downstream ACP layers
        // (mapReadTextFileError → AcpFileSystemService) can recognise it.
        const enoent = new Error(
          `ENOENT: no such file or directory, open '${params.path}'`,
        ) as NodeJS.ErrnoException;
        enoent.code = 'ENOENT';
        enoent.path = params.path;
        throw enoent;
      }

      throw new Error(`Failed to read file '${params.path}': ${errorMsg}`);
    }
  }

  /**
   * Handle write text file request
   *
   * @param params - File write parameters
   * @param params.path - File path
   * @param params.content - File content
   * @param params.sessionId - Session ID
   * @returns null indicates success
   * @throws Error when file writing fails
   */
  async handleWriteTextFile(params: {
    path: string;
    content: string;
    sessionId: string;
  }): Promise<null> {
    console.log(
      `[ACP] fs/write_text_file request received for: ${params.path}`,
    );
    console.log(`[ACP] Content size: ${params.content.length} bytes`);

    try {
      const uri = vscode.Uri.file(params.path);

      // Ensure the parent directory exists.
      const dirUri = vscode.Uri.file(path.dirname(params.path));
      console.log(`[ACP] Ensuring directory exists: ${dirUri.fsPath}`);
      await vscode.workspace.fs.createDirectory(dirUri);

      // Determine whether the file already exists so we can choose the right
      // write strategy.
      let fileExists = false;
      try {
        await vscode.workspace.fs.stat(uri);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      if (fileExists) {
        // Open the document so VS Code tracks its original encoding, replace
        // all content via WorkspaceEdit, then save.  VS Code writes back using
        // the same encoding it detected on open (e.g. GBK), preserving the
        // original encoding without any manual codec work.
        const document = await vscode.workspace.openTextDocument(uri);
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        );
        edit.replace(uri, fullRange, params.content);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
          throw new Error('WorkspaceEdit was not applied');
        }
        const updatedDoc = await vscode.workspace.openTextDocument(uri);
        if (updatedDoc.isDirty) {
          const saved = await updatedDoc.save();
          if (!saved) {
            throw new Error(`File could not be saved: ${params.path}`);
          }
        }
      } else {
        // New file – write UTF-8 bytes directly.
        const bytes = Buffer.from(params.content, 'utf-8');
        await vscode.workspace.fs.writeFile(uri, bytes);
      }

      console.log(`[ACP] Successfully wrote file: ${params.path}`);
      return null;
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(`[ACP] Failed to write file ${params.path}:`, errorMsg);

      throw new Error(`Failed to write file '${params.path}': ${errorMsg}`);
    }
  }
}
