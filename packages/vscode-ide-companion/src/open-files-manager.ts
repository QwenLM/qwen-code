/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type {
  File,
  IdeContext,
} from '@qwen-code/qwen-code-core/src/ide/types.js';
import {
  isFileUri,
  isNotebookFileUri,
  isNotebookCellUri,
  removeFile,
  renameFile,
  getNotebookUriFromCellUri,
} from './services/open-files-manager/utils.js';
import {
  addOrMoveToFront,
  updateActiveContext,
} from './services/open-files-manager/text-handler.js';
import {
  addOrMoveToFrontNotebook,
  updateNotebookActiveContext,
  updateNotebookCellSelection,
} from './services/open-files-manager/notebook-handler.js';

/**
 * Keeps track of the workspace state, including open files, cursor position, and selected text.
 */
export class OpenFilesManager {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private debounceTimer: NodeJS.Timeout | undefined;
  private openFiles: File[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    const editorWatcher = vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (editor && isFileUri(editor.document.uri)) {
          addOrMoveToFront(this.openFiles, editor);
          this.fireWithDebounce();
        } else if (editor && isNotebookCellUri(editor.document.uri)) {
          // Handle when a notebook cell becomes active (which indicates the notebook is active)
          const notebookUri = getNotebookUriFromCellUri(editor.document.uri);
          if (notebookUri && isNotebookFileUri(notebookUri)) {
            // Find the notebook editor for this cell
            const notebookEditor = vscode.window.visibleNotebookEditors.find(
              (nbEditor) =>
                nbEditor.notebook.uri.toString() === notebookUri.toString(),
            );
            if (notebookEditor) {
              addOrMoveToFrontNotebook(this.openFiles, notebookEditor);
              this.fireWithDebounce();
            }
          }
        }
      },
    );

    // Watch for when notebook editors gain focus by monitoring focus changes
    // Since VS Code doesn't have a direct onDidChangeActiveNotebookEditor event,
    // we monitor when visible notebook editors change and assume the last one shown is active
    let notebookFocusWatcher: vscode.Disposable | undefined;
    if (vscode.window.onDidChangeVisibleNotebookEditors) {
      notebookFocusWatcher = vscode.window.onDidChangeVisibleNotebookEditors(
        () => {
          // When visible notebook editors change, the currently focused one is likely the active one
          const activeNotebookEditor = vscode.window.activeNotebookEditor;
          if (
            activeNotebookEditor &&
            isNotebookFileUri(activeNotebookEditor.notebook.uri)
          ) {
            addOrMoveToFrontNotebook(this.openFiles, activeNotebookEditor);
            this.fireWithDebounce();
          }
        },
      );
    }

    const selectionWatcher = vscode.window.onDidChangeTextEditorSelection(
      (event) => {
        if (isFileUri(event.textEditor.document.uri)) {
          updateActiveContext(this.openFiles, event.textEditor);
          this.fireWithDebounce();
        } else if (isNotebookCellUri(event.textEditor.document.uri)) {
          // Handle text selections within notebook cells
          updateNotebookCellSelection(
            this.openFiles,
            event.textEditor,
            event.selections,
          );
          this.fireWithDebounce();
        }
      },
    );

    // Add notebook cell selection watcher for .ipynb files if the API is available
    let notebookCellSelectionWatcher: vscode.Disposable | undefined;
    if (vscode.window.onDidChangeNotebookEditorSelection) {
      notebookCellSelectionWatcher =
        vscode.window.onDidChangeNotebookEditorSelection((event) => {
          if (isNotebookFileUri(event.notebookEditor.notebook.uri)) {
            // Ensure the notebook is added to the active list if selected
            addOrMoveToFrontNotebook(this.openFiles, event.notebookEditor);
            updateNotebookActiveContext(this.openFiles, event.notebookEditor);
            this.fireWithDebounce();
          }
        });
    }

    const closeWatcher = vscode.workspace.onDidCloseTextDocument((document) => {
      if (isFileUri(document.uri)) {
        removeFile(this.openFiles, document.uri);
        this.fireWithDebounce();
      }
    });

    // Add notebook close watcher if the API is available
    let notebookCloseWatcher: vscode.Disposable | undefined;
    if (vscode.workspace.onDidCloseNotebookDocument) {
      notebookCloseWatcher = vscode.workspace.onDidCloseNotebookDocument(
        (document) => {
          if (isNotebookFileUri(document.uri)) {
            removeFile(this.openFiles, document.uri);
            this.fireWithDebounce();
          }
        },
      );
    }

    const deleteWatcher = vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        if (isFileUri(uri) || isNotebookFileUri(uri)) {
          removeFile(this.openFiles, uri);
        }
      }
      this.fireWithDebounce();
    });

    const renameWatcher = vscode.workspace.onDidRenameFiles((event) => {
      for (const { oldUri, newUri } of event.files) {
        if (isFileUri(oldUri) || isNotebookFileUri(oldUri)) {
          if (isFileUri(newUri) || isNotebookFileUri(newUri)) {
            renameFile(this.openFiles, oldUri, newUri);
          } else {
            // The file was renamed to a non-file URI, so we should remove it.
            removeFile(this.openFiles, oldUri);
          }
        }
      }
      this.fireWithDebounce();
    });

    context.subscriptions.push(
      editorWatcher,
      selectionWatcher,
      closeWatcher,
      deleteWatcher,
      renameWatcher,
    );

    // Conditionally add notebook-specific watchers if they were created
    if (notebookCellSelectionWatcher) {
      context.subscriptions.push(notebookCellSelectionWatcher);
    }

    if (notebookCloseWatcher) {
      context.subscriptions.push(notebookCloseWatcher);
    }

    if (notebookFocusWatcher) {
      context.subscriptions.push(notebookFocusWatcher);
    }

    // Just add current active file on start-up.
    if (
      vscode.window.activeTextEditor &&
      isFileUri(vscode.window.activeTextEditor.document.uri)
    ) {
      addOrMoveToFront(this.openFiles, vscode.window.activeTextEditor);
    }

    // Also add current active notebook if applicable and the API is available
    if (
      vscode.window.activeNotebookEditor &&
      isNotebookFileUri(vscode.window.activeNotebookEditor.notebook.uri)
    ) {
      addOrMoveToFrontNotebook(
        this.openFiles,
        vscode.window.activeNotebookEditor,
      );
    }
  }

  private fireWithDebounce() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.onDidChangeEmitter.fire();
    }, 50); // 50ms
  }

  get state(): IdeContext {
    return {
      workspaceState: {
        openFiles: [...this.openFiles],
        isTrusted: vscode.workspace.isTrusted,
      },
    };
  }
}
