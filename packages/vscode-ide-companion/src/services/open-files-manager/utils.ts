/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { File } from '@qwen-code/qwen-code-core/src/ide/types.js';

export function isFileUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file';
}

export function isNotebookFileUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && uri.path.toLowerCase().endsWith('.ipynb');
}

export function isNotebookCellUri(uri: vscode.Uri): boolean {
  // Notebook cell URIs have the scheme 'vscode-notebook-cell'
  return uri.scheme === 'vscode-notebook-cell';
}

export function removeFile(openFiles: File[], uri: vscode.Uri): void {
  const index = openFiles.findIndex((f) => f.path === uri.fsPath);
  if (index !== -1) {
    openFiles.splice(index, 1);
  }
}

export function renameFile(
  openFiles: File[],
  oldUri: vscode.Uri,
  newUri: vscode.Uri,
): void {
  const index = openFiles.findIndex((f) => f.path === oldUri.fsPath);
  if (index !== -1) {
    openFiles[index].path = newUri.fsPath;
  }
}

export function deactivateCurrentActiveFile(openFiles: File[]): void {
  const currentActive = openFiles.find((f) => f.isActive);
  if (currentActive) {
    currentActive.isActive = false;
    currentActive.cursor = undefined;
    currentActive.selectedText = undefined;
  }
}

export function enforceMaxFiles(openFiles: File[], maxFiles: number): void {
  if (openFiles.length > maxFiles) {
    openFiles.pop();
  }
}

export function truncateSelectedText(
  selectedText: string | undefined,
  maxLength: number,
): string | undefined {
  if (!selectedText) {
    return undefined;
  }
  if (selectedText.length > maxLength) {
    return selectedText.substring(0, maxLength) + '... [TRUNCATED]';
  }
  return selectedText;
}

export function getNotebookUriFromCellUri(
  cellUri: vscode.Uri,
): vscode.Uri | null {
  // Most efficient approach: Check if the currently active notebook editor contains this cell
  const activeNotebookEditor = vscode.window.activeNotebookEditor;
  if (
    activeNotebookEditor &&
    isNotebookFileUri(activeNotebookEditor.notebook.uri)
  ) {
    for (let i = 0; i < activeNotebookEditor.notebook.cellCount; i++) {
      const cell = activeNotebookEditor.notebook.cellAt(i);
      if (cell.document.uri.toString() === cellUri.toString()) {
        return activeNotebookEditor.notebook.uri;
      }
    }
  }

  // If not in the active editor, check all visible notebook editors
  for (const editor of vscode.window.visibleNotebookEditors) {
    if (
      editor !== activeNotebookEditor &&
      isNotebookFileUri(editor.notebook.uri)
    ) {
      for (let i = 0; i < editor.notebook.cellCount; i++) {
        const cell = editor.notebook.cellAt(i);
        if (cell.document.uri.toString() === cellUri.toString()) {
          return editor.notebook.uri;
        }
      }
    }
  }
  return null;
}
