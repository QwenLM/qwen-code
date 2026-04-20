/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { BaseMessageHandler } from './BaseMessageHandler.js';
import { getFileName } from '../utils/webviewUtils.js';
import { showDiffCommand } from '../../commands/index.js';
import {
  findLeftGroupOfChatWebview,
  ensureLeftGroupOfChatWebview,
} from '../../utils/editorGroupUtils.js';
import { ReadonlyFileSystemProvider } from '../../services/readonlyFileSystemProvider.js';
import { FileDiscoveryService } from '@qwen-code/qwen-code-core/src/services/fileDiscoveryService.js';
import {
  FileSearchFactory,
  type FileSearch,
} from '@qwen-code/qwen-code-core/src/utils/filesearch/fileSearch.js';
import * as crawlCache from '@qwen-code/qwen-code-core/src/utils/filesearch/crawlCache.js';
import { getErrorMessage } from '../../utils/errorMessage.js';

/**
 * File message handler
 * Handles all file-related messages
 */
export class FileMessageHandler extends BaseMessageHandler {
  private readonly fileDiscoveryServices = new Map<
    string,
    FileDiscoveryService
  >();
  private readonly fileSearchInstances = new Map<string, FileSearch>();
  private readonly fileSearchInitializing = new Map<string, Promise<void>>();
  // Per-rootPath generation token. Incremented whenever clearFileSearchCache
  // fires, so an in-flight initialize() can detect it raced against a cache
  // invalidation and skip re-caching the stale index.
  private readonly fileSearchInitTokens = new Map<string, symbol>();
  private readonly fileWatchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly globSpecialChars = new Set([
    '\\',
    '*',
    '?',
    '[',
    ']',
    '{',
    '}',
    '(',
    ')',
    '!',
    '+',
    '@',
  ]);

  canHandle(messageType: string): boolean {
    return [
      'attachFile',
      'showContextPicker',
      'getWorkspaceFiles',
      'openFile',
      'openDiff',
      'createAndOpenTempFile',
    ].includes(messageType);
  }

  private async getOrCreateFileSearch(
    rootPath: string,
  ): Promise<FileSearch | null> {
    const existing = this.fileSearchInstances.get(rootPath);
    if (existing) {
      return existing;
    }

    const initializing = this.fileSearchInitializing.get(rootPath);
    if (initializing) {
      await initializing;
      return this.fileSearchInstances.get(rootPath) ?? null;
    }

    // Mint a generation token before kicking off initialize(). Race guard
    // below compares against this token after the async build completes —
    // `clearFileSearchCache` deletes the map entry, so a mid-flight
    // invalidation flips the identity and we dispose rather than cache.
    const token = Symbol('fileSearchInit');
    this.fileSearchInitTokens.set(rootPath, token);

    const initPromise = (async () => {
      const search = FileSearchFactory.create({
        projectRoot: rootPath,
        ignoreDirs: ['.git', 'node_modules'],
        useGitignore: true,
        useQwenignore: false,
        cache: true,
        cacheTtl: 30000,
        enableRecursiveFileSearch: true,
        enableFuzzySearch: true,
      });
      await search.initialize();
      if (this.fileSearchInitTokens.get(rootPath) !== token) {
        // clearFileSearchCache fired while we were crawling; the index we
        // just built reflects a stale view of the filesystem. Dispose it
        // rather than re-caching under the same rootPath, which would
        // masquerade as fresh. Next getOrCreateFileSearch call starts new.
        void search.dispose?.();
        return;
      }
      this.fileSearchInstances.set(rootPath, search);
    })();

    this.fileSearchInitializing.set(rootPath, initPromise);

    try {
      await initPromise;
      return this.fileSearchInstances.get(rootPath) ?? null;
    } catch (error) {
      this.fileSearchInitializing.delete(rootPath);
      console.error(
        '[FileMessageHandler] Failed to initialize file search:',
        error,
      );
      return null;
    }
  }

  private clearFileSearchCache(rootPath: string): void {
    const existing = this.fileSearchInstances.get(rootPath);
    this.fileSearchInstances.delete(rootPath);
    this.fileSearchInitializing.delete(rootPath);
    // Invalidate any in-flight initialize() so it disposes instead of
    // writing its (now stale) index into fileSearchInstances when it lands.
    this.fileSearchInitTokens.delete(rootPath);
    // Drop the in-process crawl cache and, crucially, dispose the
    // worker-backed FileIndexService singleton so its in-memory snapshot
    // and fzf index are rebuilt from disk on the next search. Without
    // dispose(), the worker keeps serving stale results until the process
    // exits (FileIndexService.for() memoises by optionsKey).
    crawlCache.clear();
    void existing?.dispose?.().catch((err) => {
      console.warn('[FileMessageHandler] FileSearch dispose failed:', err);
    });
    console.log(
      '[FileMessageHandler] Cleared file search cache, trigger:',
      rootPath,
    );
  }

  private createWatcherForFolder(folder: vscode.WorkspaceFolder): void {
    const rootPath = folder.uri.fsPath;

    // Skip if watcher already exists for this folder
    if (this.fileWatchers.has(rootPath)) {
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '**/*'),
    );

    const onFileAddOrDelete = () => this.clearFileSearchCache(rootPath);
    watcher.onDidCreate(onFileAddOrDelete);
    watcher.onDidDelete(onFileAddOrDelete);
    // Note: onDidChange is not needed - file search is based on names, not content

    this.fileWatchers.set(rootPath, watcher);
  }

  private disposeWatcherForFolder(rootPath: string): void {
    const watcher = this.fileWatchers.get(rootPath);
    if (watcher) {
      watcher.dispose();
      this.fileWatchers.delete(rootPath);
    }
  }

  setupFileWatchers(): vscode.Disposable {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      for (const folder of workspaceFolders) {
        this.createWatcherForFolder(folder);
      }
    }

    const foldersChangeListener = vscode.workspace.onDidChangeWorkspaceFolders(
      (e) => {
        for (const folder of e.removed) {
          const rootPath = folder.uri.fsPath;
          this.clearFileSearchCache(rootPath);
          this.disposeWatcherForFolder(rootPath);
        }
        for (const folder of e.added) {
          const rootPath = folder.uri.fsPath;
          this.clearFileSearchCache(rootPath);
          this.createWatcherForFolder(folder);
        }
      },
    );

    return {
      dispose: () => {
        for (const watcher of this.fileWatchers.values()) {
          watcher.dispose();
        }
        this.fileWatchers.clear();
        foldersChangeListener.dispose();
      },
    };
  }

  async handle(message: { type: string; data?: unknown }): Promise<void> {
    const data = message.data as Record<string, unknown> | undefined;

    switch (message.type) {
      case 'attachFile':
        await this.handleAttachFile();
        break;

      case 'showContextPicker':
        await this.handleShowContextPicker();
        break;

      case 'getWorkspaceFiles':
        await this.handleGetWorkspaceFiles(
          data?.query as string | undefined,
          data?.requestId as number | undefined,
        );
        break;

      case 'openFile':
        await this.handleOpenFile(data?.path as string | undefined);
        break;

      case 'openDiff':
        await this.handleOpenDiff(data);
        break;

      case 'createAndOpenTempFile':
        await this.handleCreateAndOpenTempFile(data);
        break;

      default:
        console.warn(
          '[FileMessageHandler] Unknown message type:',
          message.type,
        );
        break;
    }
  }

  /**
   * Handle attach file request
   */
  private async handleAttachFile(): Promise<void> {
    try {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: 'Attach',
      });

      if (uris && uris.length > 0) {
        const uri = uris[0];
        const fileName = getFileName(uri.fsPath);

        this.sendToWebView({
          type: 'fileAttached',
          data: {
            id: `file-${Date.now()}`,
            type: 'file',
            name: fileName,
            value: uri.fsPath,
          },
        });
      }
    } catch (error) {
      console.error('[FileMessageHandler] Failed to attach file:', error);
      const errorMsg = getErrorMessage(error);
      this.sendToWebView({
        type: 'error',
        data: { message: `Failed to attach file: ${errorMsg}` },
      });
    }
  }

  /**
   * Handle show context picker request
   */
  private async handleShowContextPicker(): Promise<void> {
    try {
      const items: vscode.QuickPickItem[] = [];

      // Add current file
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        const fileName = getFileName(activeEditor.document.uri.fsPath);
        items.push({
          label: `$(file) ${fileName}`,
          description: 'Current file',
          detail: activeEditor.document.uri.fsPath,
        });
      }

      // Add file picker option
      items.push({
        label: '$(file) File...',
        description: 'Choose a file to attach',
      });

      // Add workspace files option
      items.push({
        label: '$(search) Search files...',
        description: 'Search workspace files',
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Attach context',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (selected) {
        if (selected.label.includes('Current file') && activeEditor) {
          const fileName = getFileName(activeEditor.document.uri.fsPath);
          this.sendToWebView({
            type: 'fileAttached',
            data: {
              id: `file-${Date.now()}`,
              type: 'file',
              name: fileName,
              value: activeEditor.document.uri.fsPath,
            },
          });
        } else if (selected.label.includes('File...')) {
          await this.handleAttachFile();
        } else if (selected.label.includes('Search files')) {
          const uri = await vscode.window.showOpenDialog({
            defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            openLabel: 'Attach',
          });

          if (uri && uri.length > 0) {
            const fileName = getFileName(uri[0].fsPath);
            this.sendToWebView({
              type: 'fileAttached',
              data: {
                id: `file-${Date.now()}`,
                type: 'file',
                name: fileName,
                value: uri[0].fsPath,
              },
            });
          }
        }
      }
    } catch (error) {
      console.error(
        '[FileMessageHandler] Failed to show context picker:',
        error,
      );
      const errorMsg = getErrorMessage(error);
      this.sendToWebView({
        type: 'error',
        data: { message: `Failed to show context picker: ${errorMsg}` },
      });
    }
  }

  /**
   * Get workspace files
   */
  private async handleGetWorkspaceFiles(
    query?: string,
    requestId?: number,
  ): Promise<void> {
    try {
      console.log('[FileMessageHandler] handleGetWorkspaceFiles start', {
        query,
        requestId,
      });
      const files: Array<{
        id: string;
        label: string;
        description: string;
        path: string;
      }> = [];
      const addedPaths = new Set<string>();

      const addFile = (uri: vscode.Uri, isCurrentFile = false) => {
        if (addedPaths.has(uri.fsPath)) {
          return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (workspaceFolder) {
          const rootPath = workspaceFolder.uri.fsPath;
          let discovery = this.fileDiscoveryServices.get(rootPath);
          if (!discovery) {
            discovery = new FileDiscoveryService(rootPath);
            this.fileDiscoveryServices.set(rootPath, discovery);
          }
          // Apply gitignore filtering so ignored paths don't appear in @ results.
          if (
            discovery.shouldIgnoreFile(uri.fsPath, {
              respectGitIgnore: true,
              respectQwenIgnore: false,
            })
          ) {
            return;
          }
        }

        const fileName = getFileName(uri.fsPath);
        const relativePath = workspaceFolder
          ? vscode.workspace.asRelativePath(uri, false)
          : uri.fsPath;

        // Filter by query if provided
        if (
          query &&
          !fileName.toLowerCase().includes(query.toLowerCase()) &&
          !relativePath.toLowerCase().includes(query.toLowerCase())
        ) {
          return;
        }

        files.push({
          id: isCurrentFile ? 'current-file' : uri.fsPath,
          label: fileName,
          description: relativePath,
          path: uri.fsPath,
        });
        addedPaths.add(uri.fsPath);
      };

      // Search or show recent files
      if (query) {
        console.log(
          '[FileMessageHandler] Searching workspace files with fuzzy search for query',
          query,
        );

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
          for (const folder of workspaceFolders) {
            const rootPath = folder.uri.fsPath;
            const fileSearch = await this.getOrCreateFileSearch(rootPath);
            if (!fileSearch) {
              continue;
            }

            const relativePaths = await fileSearch.search(query, {
              maxResults: 50,
            });

            for (let relativePath of relativePaths) {
              const isDirectory = relativePath.endsWith('/');
              if (isDirectory) {
                relativePath = relativePath.slice(0, -1);
              }
              const absolutePath = vscode.Uri.joinPath(
                folder.uri,
                relativePath,
              ).fsPath;

              files.push({
                id: absolutePath,
                label: relativePath,
                description: relativePath,
                path: absolutePath,
              });
              addedPaths.add(absolutePath);
            }
          }
        }
      } else {
        // Non-query mode: respond quickly with currently active and open files
        // Add current active file first
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          addFile(activeEditor.document.uri, true);
        }

        // Add all open tabs
        const tabGroups = vscode.window.tabGroups.all;
        for (const tabGroup of tabGroups) {
          for (const tab of tabGroup.tabs) {
            const input = tab.input as { uri?: vscode.Uri } | undefined;
            if (input && input.uri instanceof vscode.Uri) {
              addFile(input.uri);
            }
          }
        }

        // Send an initial quick response so UI can render immediately
        try {
          this.sendToWebView({
            type: 'workspaceFiles',
            data: { files, query, requestId },
          });
          console.log(
            '[FileMessageHandler] Sent initial workspaceFiles (open tabs/active)',
            files.length,
          );
        } catch (e) {
          console.warn(
            '[FileMessageHandler] Failed sending initial response',
            e,
          );
        }

        // If not enough files, add some workspace files (bounded)
        if (files.length < 10) {
          const recentUris = await vscode.workspace.findFiles(
            '**/*',
            '**/{.git,node_modules}/**',
            20,
          );

          for (const uri of recentUris) {
            if (files.length >= 20) {
              break;
            }
            addFile(uri);
          }
        }
      }

      this.sendToWebView({
        type: 'workspaceFiles',
        data: { files, query, requestId },
      });
      console.log(
        '[FileMessageHandler] Sent final workspaceFiles',
        files.length,
      );
    } catch (error) {
      console.error(
        '[FileMessageHandler] Failed to get workspace files:',
        error,
      );
      const errorMsg = getErrorMessage(error);
      this.sendToWebView({
        type: 'error',
        data: { message: `Failed to get workspace files: ${errorMsg}` },
      });
    }
  }

  /**
   * Open file
   */
  private async handleOpenFile(filePath?: string): Promise<void> {
    if (!filePath) {
      console.warn('[FileMessageHandler] No path provided for openFile');
      return;
    }

    try {
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
      console.error('[FileMessageHandler] Failed to open file:', error);
      vscode.window.showErrorMessage(
        `Failed to open file: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Open diff view
   */
  private async handleOpenDiff(
    data: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!data) {
      console.warn('[FileMessageHandler] No data provided for openDiff');
      return;
    }

    try {
      await vscode.commands.executeCommand(showDiffCommand, {
        path: (data.path as string) || '',
        oldText: (data.oldText as string) || '',
        newText: (data.newText as string) || '',
      });
    } catch (error) {
      console.error('[FileMessageHandler] Failed to open diff:', error);
      vscode.window.showErrorMessage(
        `Failed to open diff: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Create and open temporary readonly file
   */
  private async handleCreateAndOpenTempFile(
    data: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!data) {
      console.warn(
        '[FileMessageHandler] No data provided for createAndOpenTempFile',
      );
      return;
    }

    try {
      const content = (data.content as string) || '';
      const fileName = (data.fileName as string) || 'temp';

      // Get readonly file system provider from global singleton
      const readonlyProvider = ReadonlyFileSystemProvider.getInstance();
      if (!readonlyProvider) {
        const errorMessage = 'Readonly file system provider not initialized';
        console.error('[FileMessageHandler]', errorMessage);
        this.sendToWebView({
          type: 'error',
          data: { message: errorMessage },
        });
        return;
      }

      // Create readonly URI (without timestamp to ensure consistency)
      const uri = readonlyProvider.createUri(fileName, content);
      readonlyProvider.setContent(uri, content);

      // If the document already has an open tab, focus that same tab instead of opening a new one.
      let foundExistingTab = false;
      let existingViewColumn: vscode.ViewColumn | undefined;
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const input = tab.input as { uri?: vscode.Uri } | undefined;
          if (input?.uri && input.uri.toString() === uri.toString()) {
            foundExistingTab = true;
            existingViewColumn = tabGroup.viewColumn;
            break;
          }
        }
        if (foundExistingTab) {
          break;
        }
      }

      if (foundExistingTab) {
        const document = await vscode.workspace.openTextDocument(uri);
        const showOptions: vscode.TextDocumentShowOptions = {
          preview: false,
          preserveFocus: false,
        };
        if (existingViewColumn !== undefined) {
          showOptions.viewColumn = existingViewColumn;
        }
        await vscode.window.showTextDocument(document, showOptions);
        console.log(
          '[FileMessageHandler] Focused on existing readonly file:',
          uri.toString(),
          'in viewColumn:',
          existingViewColumn,
        );
        return;
      }

      // Find or ensure left group of chat webview
      let targetViewColumn = findLeftGroupOfChatWebview();
      if (targetViewColumn === undefined) {
        targetViewColumn = await ensureLeftGroupOfChatWebview();
      }

      // Open as readonly document in the left group and focus it (single click should be enough)
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, {
        viewColumn: targetViewColumn ?? vscode.ViewColumn.Beside,
        preview: false,
        preserveFocus: false,
      });

      console.log(
        '[FileMessageHandler] Created and opened readonly file:',
        uri.toString(),
        'in viewColumn:',
        targetViewColumn ?? 'Beside',
      );
    } catch (error) {
      console.error(
        '[FileMessageHandler] Failed to create and open temporary file:',
        error,
      );
      vscode.window.showErrorMessage(
        `Failed to create and open temporary file: ${getErrorMessage(error)}`,
      );
    }
  }

  private buildCaseInsensitiveGlob(query: string): string {
    let pattern = '';
    for (const char of query) {
      if (/[a-zA-Z]/.test(char)) {
        pattern += `[${char.toLowerCase()}${char.toUpperCase()}]`;
      } else if (this.globSpecialChars.has(char)) {
        pattern += `\\${char}`;
      } else {
        pattern += char;
      }
    }
    return pattern;
  }
}
