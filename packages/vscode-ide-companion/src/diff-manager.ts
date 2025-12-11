/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  IdeDiffAcceptedNotificationSchema,
  IdeDiffClosedNotificationSchema,
} from '@qwen-code/qwen-code-core/src/ide/types.js';
import { type JSONRPCNotification } from '@modelcontextprotocol/sdk/types.js';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DIFF_SCHEME } from './extension.js';
import {
  findLeftGroupOfChatWebview,
  ensureLeftGroupOfChatWebview,
} from './utils/editorGroupUtils.js';

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private content = new Map<string, string>();
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

  get onDidChange(): vscode.Event<vscode.Uri> {
    return this.onDidChangeEmitter.event;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? '';
  }

  setContent(uri: vscode.Uri, content: string): void {
    this.content.set(uri.toString(), content);
    this.onDidChangeEmitter.fire(uri);
  }

  deleteContent(uri: vscode.Uri): void {
    this.content.delete(uri.toString());
  }

  getContent(uri: vscode.Uri): string | undefined {
    return this.content.get(uri.toString());
  }
}

// Information about a diff view that is currently open.
interface DiffInfo {
  originalFilePath: string;
  oldContent: string;
  newContent: string;
  leftDocUri: vscode.Uri;
  rightDocUri: vscode.Uri;
}

/**
 * Manages the state and lifecycle of diff views within the IDE.
 */
export class DiffManager {
  private readonly onDidChangeEmitter =
    new vscode.EventEmitter<JSONRPCNotification>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private diffDocuments = new Map<string, DiffInfo>();
  private readonly subscriptions: vscode.Disposable[] = [];
  // Dedupe: remember recent showDiff calls keyed by (file+content)
  private recentlyShown = new Map<string, number>();
  private pendingDelayTimers = new Map<string, NodeJS.Timeout>();
  private static readonly DEDUPE_WINDOW_MS = 1500;
  // Optional hooks from extension to influence diff behavior
  // - shouldDelay: when true, we defer opening diffs briefly (e.g., while a permission drawer is open)
  // - shouldSuppress: when true, we skip opening diffs entirely (e.g., in auto/yolo mode)
  private shouldDelay?: () => boolean;
  private shouldSuppress?: () => boolean;
  // Timed suppression window (e.g. immediately after permission allow)
  private suppressUntil: number | null = null;

  constructor(
    private readonly log: (message: string) => void,
    private readonly diffContentProvider: DiffContentProvider,
    shouldDelay?: () => boolean,
    shouldSuppress?: () => boolean,
  ) {
    this.shouldDelay = shouldDelay;
    this.shouldSuppress = shouldSuppress;
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.onActiveEditorChange(editor);
      }),
    );
    this.onActiveEditorChange(vscode.window.activeTextEditor);
  }

  dispose() {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  /**
   * Checks if a diff view already exists for the given file path and content
   * @param filePath Path to the file being diffed
   * @param oldContent The original content (left side)
   * @param newContent The modified content (right side)
   * @returns True if a diff view with the same content already exists, false otherwise
   */
  private hasExistingDiff(
    filePath: string,
    oldContent: string,
    newContent: string,
  ): boolean {
    for (const diffInfo of this.diffDocuments.values()) {
      if (
        diffInfo.originalFilePath === filePath &&
        diffInfo.oldContent === oldContent &&
        diffInfo.newContent === newContent
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Finds an existing diff view for the given file path and focuses it
   * @param filePath Path to the file being diffed
   * @returns True if an existing diff view was found and focused, false otherwise
   */
  private async focusExistingDiff(filePath: string): Promise<boolean> {
    const normalizedPath = path.normalize(filePath);
    for (const [, diffInfo] of this.diffDocuments.entries()) {
      if (diffInfo.originalFilePath === normalizedPath) {
        const rightDocUri = diffInfo.rightDocUri;
        const leftDocUri = diffInfo.leftDocUri;

        const diffTitle = `${path.basename(filePath)} (Before ↔ After)`;

        try {
          await vscode.commands.executeCommand(
            'vscode.diff',
            leftDocUri,
            rightDocUri,
            diffTitle,
            {
              viewColumn: vscode.ViewColumn.Beside,
              preview: false,
              preserveFocus: true,
            },
          );
          return true;
        } catch (error) {
          this.log(`Failed to focus existing diff: ${error}`);
          return false;
        }
      }
    }
    return false;
  }

  /**
   * Creates and shows a new diff view.
   * - Overload 1: showDiff(filePath, newContent)
   * - Overload 2: showDiff(filePath, oldContent, newContent)
   * If only newContent is provided, the old content will be read from the
   * filesystem (empty string when file does not exist).
   */
  async showDiff(filePath: string, newContent: string): Promise<void>;
  async showDiff(
    filePath: string,
    oldContent: string,
    newContent: string,
  ): Promise<void>;
  async showDiff(filePath: string, a: string, b?: string): Promise<void> {
    const haveOld = typeof b === 'string';
    const oldContent = haveOld ? a : await this.readOldContentFromFs(filePath);
    const newContent = haveOld ? (b as string) : a;
    const normalizedPath = path.normalize(filePath);
    const key = this.makeKey(normalizedPath, oldContent, newContent);

    // Check if a diff view with the same content already exists
    if (this.hasExistingDiff(normalizedPath, oldContent, newContent)) {
      const last = this.recentlyShown.get(key) || 0;
      const now = Date.now();
      if (now - last < DiffManager.DEDUPE_WINDOW_MS) {
        // Within dedupe window: ignore the duplicate request entirely
        this.log(
          `Duplicate showDiff suppressed for ${filePath} (within ${DiffManager.DEDUPE_WINDOW_MS}ms)`,
        );
        return;
      }
      // Outside the dedupe window: softly focus the existing diff
      await this.focusExistingDiff(normalizedPath);
      this.recentlyShown.set(key, now);
      return;
    }
    // Left side: old content using qwen-diff scheme
    const leftDocUri = vscode.Uri.from({
      scheme: DIFF_SCHEME,
      path: normalizedPath,
      query: `old&rand=${Math.random()}`,
    });
    this.diffContentProvider.setContent(leftDocUri, oldContent);

    // Right side: new content using qwen-diff scheme
    const rightDocUri = vscode.Uri.from({
      scheme: DIFF_SCHEME,
      path: normalizedPath,
      query: `new&rand=${Math.random()}`,
    });
    this.diffContentProvider.setContent(rightDocUri, newContent);

    this.addDiffDocument(rightDocUri, {
      originalFilePath: normalizedPath,
      oldContent,
      newContent,
      leftDocUri,
      rightDocUri,
    });

    const diffTitle = `${path.basename(normalizedPath)} (Before ↔ After)`;
    await vscode.commands.executeCommand(
      'setContext',
      'qwen.diff.isVisible',
      true,
    );

    // Prefer opening the diff adjacent to the chat webview (so we don't
    // replace content inside the locked webview group). We try the group to
    // the left of the chat webview first; if none exists we fall back to
    // ViewColumn.Beside. With the chat locked in the leftmost group, this
    // fallback opens diffs to the right of the chat.
    let targetViewColumn = findLeftGroupOfChatWebview();
    if (targetViewColumn === undefined) {
      // If there is no left neighbor, create one to satisfy the requirement of
      // opening diffs to the left of the chat webview.
      targetViewColumn = await ensureLeftGroupOfChatWebview();
    }

    await vscode.commands.executeCommand(
      'vscode.diff',
      leftDocUri,
      rightDocUri,
      diffTitle,
      {
        // If a left-of-webview group was found, target it explicitly so the
        // diff opens there while keeping focus on the webview. Otherwise, use
        // the default "open to side" behavior.
        viewColumn: targetViewColumn ?? vscode.ViewColumn.Beside,
        preview: false,
        preserveFocus: true,
      },
    );
    await vscode.commands.executeCommand(
      'workbench.action.files.setActiveEditorWriteableInSession',
    );

    this.recentlyShown.set(key, Date.now());
  }

  /**
   * Closes an open diff view for a specific file.
   */
  async closeDiff(filePath: string, suppressNotification = false) {
    const normalizedPath = path.normalize(filePath);
    let uriToClose: vscode.Uri | undefined;
    for (const [, diffInfo] of this.diffDocuments.entries()) {
      if (diffInfo.originalFilePath === normalizedPath) {
        uriToClose = diffInfo.rightDocUri;
        break;
      }
    }

    if (uriToClose) {
      const rightDoc = await vscode.workspace.openTextDocument(uriToClose);
      const modifiedContent = rightDoc.getText();
      await this.closeDiffEditor(uriToClose);
      if (!suppressNotification) {
        this.onDidChangeEmitter.fire(
          IdeDiffClosedNotificationSchema.parse({
            jsonrpc: '2.0',
            method: 'ide/diffClosed',
            params: {
              filePath,
              content: modifiedContent,
            },
          }),
        );
      }
      return modifiedContent;
    }
    return;
  }

  /**
   * User accepts the changes in a diff view. Does not apply changes.
   */
  async acceptDiff(rightDocUri: vscode.Uri) {
    const diffInfo = this.diffDocuments.get(rightDocUri.toString());
    if (!diffInfo) {
      this.log(`No diff info found for ${rightDocUri.toString()}`);
      return;
    }

    const rightDoc = await vscode.workspace.openTextDocument(rightDocUri);
    const modifiedContent = rightDoc.getText();
    await this.closeDiffEditor(rightDocUri);

    this.onDidChangeEmitter.fire(
      IdeDiffAcceptedNotificationSchema.parse({
        jsonrpc: '2.0',
        method: 'ide/diffAccepted',
        params: {
          filePath: diffInfo.originalFilePath,
          content: modifiedContent,
        },
      }),
    );
  }

  /**
   * Called when a user cancels a diff view.
   */
  async cancelDiff(rightDocUri: vscode.Uri) {
    const diffInfo = this.diffDocuments.get(rightDocUri.toString());
    if (!diffInfo) {
      this.log(`No diff info found for ${rightDocUri.toString()}`);
      // Even if we don't have diff info, we should still close the editor.
      await this.closeDiffEditor(rightDocUri);
      return;
    }

    const rightDoc = await vscode.workspace.openTextDocument(rightDocUri);
    const modifiedContent = rightDoc.getText();
    await this.closeDiffEditor(rightDocUri);

    this.onDidChangeEmitter.fire(
      IdeDiffClosedNotificationSchema.parse({
        jsonrpc: '2.0',
        method: 'ide/diffClosed',
        params: {
          filePath: diffInfo.originalFilePath,
          content: modifiedContent,
        },
      }),
    );
  }

  private async onActiveEditorChange(editor: vscode.TextEditor | undefined) {
    let isVisible = false;
    if (editor) {
      isVisible = this.diffDocuments.has(editor.document.uri.toString());
      if (!isVisible) {
        for (const document of this.diffDocuments.values()) {
          if (document.originalFilePath === editor.document.uri.fsPath) {
            isVisible = true;
            break;
          }
        }
      }
    }
    await vscode.commands.executeCommand(
      'setContext',
      'qwen.diff.isVisible',
      isVisible,
    );
  }

  private addDiffDocument(uri: vscode.Uri, diffInfo: DiffInfo) {
    this.diffDocuments.set(uri.toString(), diffInfo);
  }

  private async closeDiffEditor(rightDocUri: vscode.Uri) {
    const diffInfo = this.diffDocuments.get(rightDocUri.toString());
    await vscode.commands.executeCommand(
      'setContext',
      'qwen.diff.isVisible',
      false,
    );

    if (diffInfo) {
      this.diffDocuments.delete(rightDocUri.toString());
      this.diffContentProvider.deleteContent(rightDocUri);
    }

    // Find and close the tab corresponding to the diff view
    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        const input = tab.input as {
          modified?: vscode.Uri;
          original?: vscode.Uri;
        };
        if (input && input.modified?.toString() === rightDocUri.toString()) {
          await vscode.window.tabGroups.close(tab);
          return;
        }
      }
    }
  }

  /** Close all open qwen-diff editors */
  async closeAll(): Promise<void> {
    // Collect keys first to avoid iterator invalidation while closing
    const uris = Array.from(this.diffDocuments.keys()).map((k) =>
      vscode.Uri.parse(k),
    );
    for (const uri of uris) {
      try {
        await this.closeDiffEditor(uri);
      } catch (err) {
        this.log(`Failed to close diff editor: ${err}`);
      }
    }
  }

  // Read the current content of file from the workspace; return empty string if not found
  private async readOldContentFromFs(filePath: string): Promise<string> {
    try {
      const fileUri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(fileUri);
      return document.getText();
    } catch {
      return '';
    }
  }

  private makeKey(filePath: string, oldContent: string, newContent: string) {
    // Simple stable key; content could be large but kept transiently
    return `${filePath}\u241F${oldContent}\u241F${newContent}`;
  }

  /** Temporarily suppress opening diffs for a short duration. */
  suppressFor(durationMs: number): void {
    this.suppressUntil = Date.now() + Math.max(0, durationMs);
  }
}
