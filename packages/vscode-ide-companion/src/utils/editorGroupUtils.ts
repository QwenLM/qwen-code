/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { openChatCommand } from '../commands/index.js';

/**
 * Find the editor group immediately to the left of the Qwen chat webview.
 * - If the chat webview group is the leftmost group, returns undefined.
 * - Uses the webview tab viewType 'mainThreadWebview-qwenCode.chat'.
 */
export function findLeftGroupOfChatWebview(): vscode.ViewColumn | undefined {
  try {
    const groups = vscode.window.tabGroups.all;

    // Locate the group that contains our chat webview
    const webviewGroup = groups.find((group) =>
      group.tabs.some((tab) => {
        const input: unknown = (tab as { input?: unknown }).input;
        const isWebviewInput = (inp: unknown): inp is { viewType: string } =>
          !!inp && typeof inp === 'object' && 'viewType' in inp;
        return (
          isWebviewInput(input) &&
          input.viewType === 'mainThreadWebview-qwenCode.chat'
        );
      }),
    );

    if (!webviewGroup) {
      return undefined;
    }

    // Among all groups to the left (smaller viewColumn), choose the one with
    // the largest viewColumn value (i.e. the immediate neighbor on the left).
    let candidate:
      | { group: vscode.TabGroup; viewColumn: vscode.ViewColumn }
      | undefined;
    for (const g of groups) {
      if (g.viewColumn < webviewGroup.viewColumn) {
        if (!candidate || g.viewColumn > candidate.viewColumn) {
          candidate = { group: g, viewColumn: g.viewColumn };
        }
      }
    }

    return candidate?.viewColumn;
  } catch (_err) {
    // Best-effort only; fall back to default behavior if anything goes wrong
    return undefined;
  }
}

/**
 * Ensure there is an editor group directly to the left of the Qwen chat webview.
 * - If one exists, return its ViewColumn.
 * - If none exists, focus the chat panel and create a new group on its left,
 *   then return the new group's ViewColumn (which equals the chat's previous column).
 * - If the chat webview cannot be located, returns undefined.
 */
export async function ensureLeftGroupOfChatWebview(): Promise<
  vscode.ViewColumn | undefined
> {
  // First try to find an existing left neighbor
  const existing = findLeftGroupOfChatWebview();
  if (existing !== undefined) {
    return existing;
  }

  // Locate the chat webview group
  const groups = vscode.window.tabGroups.all;
  const webviewGroup = groups.find((group) =>
    group.tabs.some((tab) => {
      const input: unknown = (tab as { input?: unknown }).input;
      const isWebviewInput = (inp: unknown): inp is { viewType: string } =>
        !!inp && typeof inp === 'object' && 'viewType' in inp;
      return (
        isWebviewInput(input) &&
        input.viewType === 'mainThreadWebview-qwenCode.chat'
      );
    }),
  );

  if (!webviewGroup) {
    return undefined;
  }

  const previousChatColumn = webviewGroup.viewColumn;

  // Make the chat group active by revealing the panel
  try {
    await vscode.commands.executeCommand(openChatCommand);
  } catch {
    // Best-effort; continue even if this fails
  }

  // Create a new group to the left of the chat group
  try {
    await vscode.commands.executeCommand('workbench.action.newGroupLeft');
  } catch {
    // If we fail to create a group, fall back to default behavior
    return undefined;
  }

  // Restore focus to chat (optional), so we don't disturb user focus
  try {
    await vscode.commands.executeCommand(openChatCommand);
  } catch {
    // Ignore
  }

  // The new left group's column equals the chat's previous column
  return previousChatColumn;
}
