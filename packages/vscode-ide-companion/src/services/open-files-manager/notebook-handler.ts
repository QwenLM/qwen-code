/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { File } from '@qwen-code/qwen-code-core/src/ide/types.js';
import { MAX_FILES, MAX_SELECTED_TEXT_LENGTH } from './constants.js';
import {
  deactivateCurrentActiveFile,
  enforceMaxFiles,
  truncateSelectedText,
  getNotebookUriFromCellUri,
} from './utils.js';

export function addOrMoveToFrontNotebook(
  openFiles: File[],
  notebookEditor: vscode.NotebookEditor,
) {
  // Deactivate previous active file
  deactivateCurrentActiveFile(openFiles);

  // Remove if it exists
  const index = openFiles.findIndex(
    (f) => f.path === notebookEditor.notebook.uri.fsPath,
  );
  if (index !== -1) {
    openFiles.splice(index, 1);
  }

  // Add to the front as active
  openFiles.unshift({
    path: notebookEditor.notebook.uri.fsPath,
    timestamp: Date.now(),
    isActive: true,
  });

  // Enforce max length
  enforceMaxFiles(openFiles, MAX_FILES);

  updateNotebookActiveContext(openFiles, notebookEditor);
}

export function updateNotebookActiveContext(
  openFiles: File[],
  notebookEditor: vscode.NotebookEditor,
) {
  const file = openFiles.find(
    (f) => f.path === notebookEditor.notebook.uri.fsPath,
  );
  if (!file || !file.isActive) {
    return;
  }

  // For notebook editors, selections may span multiple cells
  // We'll gather selected text from all selected cells
  const selections = notebookEditor.selections;
  let combinedSelectedText = '';

  for (const selection of selections) {
    // Process each selected cell range
    for (let i = selection.start; i < selection.end; i++) {
      const cell = notebookEditor.notebook.cellAt(i);
      if (cell && cell.kind === vscode.NotebookCellKind.Code) {
        // For now, we'll get the full cell content if it's in a selection
        // TODO: Implement per-cell cursor position and finer-grained selection if needed
        combinedSelectedText += cell.document.getText() + '\n';
      }
    }
  }

  if (combinedSelectedText) {
    combinedSelectedText = combinedSelectedText.trim();
    file.selectedText = truncateSelectedText(
      combinedSelectedText,
      MAX_SELECTED_TEXT_LENGTH,
    );
  } else {
    file.selectedText = undefined;
  }
}

export function updateNotebookCellSelection(
  openFiles: File[],
  cellEditor: vscode.TextEditor,
  selections: readonly vscode.Selection[],
) {
  // Find the parent notebook by traversing the URI
  const notebookUri = getNotebookUriFromCellUri(cellEditor.document.uri);
  if (!notebookUri) {
    return;
  }

  // Find the corresponding file entry for this notebook
  const file = openFiles.find((f) => f.path === notebookUri.fsPath);
  if (!file || !file.isActive) {
    return;
  }

  // Extract the selected text from the cell editor
  let selectedText = '';
  for (const selection of selections) {
    const text = cellEditor.document.getText(selection);
    if (text) {
      selectedText += text + '\n';
    }
  }

  if (selectedText) {
    selectedText = selectedText.trim();
    file.selectedText = truncateSelectedText(
      selectedText,
      MAX_SELECTED_TEXT_LENGTH,
    );
  } else {
    file.selectedText = undefined;
  }
}
