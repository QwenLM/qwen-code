/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as vscode from 'vscode';
import type { File } from '@qwen-code/qwen-code-core/src/ide/types.js';
import { MAX_FILES, MAX_SELECTED_TEXT_LENGTH } from './constants.js';
import {
  deactivateCurrentActiveFile,
  enforceMaxFiles,
  truncateSelectedText,
} from './utils.js';

export function addOrMoveToFront(openFiles: File[], editor: vscode.TextEditor) {
  // Deactivate previous active file
  deactivateCurrentActiveFile(openFiles);

  // Remove if it exists
  const index = openFiles.findIndex(
    (f) => f.path === editor.document.uri.fsPath,
  );
  if (index !== -1) {
    openFiles.splice(index, 1);
  }

  // Add to the front as active
  openFiles.unshift({
    path: editor.document.uri.fsPath,
    timestamp: Date.now(),
    isActive: true,
  });

  // Enforce max length
  enforceMaxFiles(openFiles, MAX_FILES);

  updateActiveContext(openFiles, editor);
}

export function updateActiveContext(
  openFiles: File[],
  editor: vscode.TextEditor,
) {
  const file = openFiles.find((f) => f.path === editor.document.uri.fsPath);
  if (!file || !file.isActive) {
    return;
  }

  file.cursor = editor.selection.active
    ? {
        line: editor.selection.active.line + 1,
        character: editor.selection.active.character,
      }
    : undefined;

  let selectedText: string | undefined =
    editor.document.getText(editor.selection) || undefined;
  selectedText = truncateSelectedText(selectedText, MAX_SELECTED_TEXT_LENGTH);
  file.selectedText = selectedText;
}
