/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import * as vscode from 'vscode';

export function shouldResolveAgainstWorkspace(filePath: string): boolean {
  return !path.posix.isAbsolute(filePath) && !path.win32.isAbsolute(filePath);
}

/**
 * Resolve a workspace-relative path against the first workspace folder.
 * Absolute paths are returned unchanged, and so are relative paths in a window
 * with no folder open, since there is nothing to resolve them against.
 */
export function resolveWorkspacePath(filePath: string): string {
  if (!shouldResolveAgainstWorkspace(filePath)) {
    return filePath;
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return filePath;
  }
  return vscode.Uri.joinPath(workspaceFolder.uri, filePath).fsPath;
}
