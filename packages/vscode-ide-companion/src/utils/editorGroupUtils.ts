/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { openChatCommand } from '../commands/index.js';

const CHAT_WEBVIEW_TYPE = 'mainThreadWebview-qwenCode.chat';

function isChatWebview(tab: vscode.Tab): boolean {
  const input: unknown = (tab as { input?: unknown }).input;
  return (
    !!input &&
    typeof input === 'object' &&
    (input as { viewType: string }).viewType === CHAT_WEBVIEW_TYPE
  );
}

function findWebviewGroup(): vscode.TabGroup | undefined {
  return vscode.window.tabGroups.all.find((group) =>
    group.tabs.some(isChatWebview),
  );
}

/**
 * Find the editor group immediately to the left of the Qwen chat webview.
 * - If the chat webview group is the leftmost group, returns undefined.
 * - If no chat webview is found in any editor group, returns undefined.
 */
export function findLeftGroupOfChatWebview(): vscode.ViewColumn | undefined {
  try {
    const webviewGroup = findWebviewGroup();
    if (!webviewGroup) {
      return undefined;
    }

    // Among groups with smaller viewColumn, pick the largest (closest neighbor).
    let candidate: vscode.ViewColumn | undefined;
    for (const g of vscode.window.tabGroups.all) {
      if (
        g.viewColumn < webviewGroup.viewColumn &&
        (candidate === undefined || g.viewColumn > candidate)
      ) {
        candidate = g.viewColumn;
      }
    }
    return candidate;
  } catch (_err) {
    return undefined;
  }
}

/**
 * Find the editor group immediately to the right of the Qwen chat webview.
 * - If the chat webview group is the rightmost group, returns undefined.
 * - If no chat webview is found in any editor group, returns undefined.
 */
export function findRightGroupOfChatWebview(): vscode.ViewColumn | undefined {
  try {
    const webviewGroup = findWebviewGroup();
    if (!webviewGroup) {
      return undefined;
    }

    // Among groups with larger viewColumn, pick the smallest (closest neighbor).
    let candidate: vscode.ViewColumn | undefined;
    for (const g of vscode.window.tabGroups.all) {
      if (
        g.viewColumn > webviewGroup.viewColumn &&
        (candidate === undefined || g.viewColumn < candidate)
      ) {
        candidate = g.viewColumn;
      }
    }
    return candidate;
  } catch (_err) {
    return undefined;
  }
}

/**
 * Wait for a condition to become true, driven by tab-group change events.
 * Falls back to a timeout to avoid hanging forever.
 */
function waitForTabGroupsCondition(
  condition: () => boolean,
  timeout: number = 2000,
): Promise<boolean> {
  if (condition()) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    const subscription = vscode.window.tabGroups.onDidChangeTabGroups(() => {
      if (!condition()) {
        return;
      }
      clearTimeout(timeoutHandle);
      subscription.dispose();
      resolve(true);
    });

    const timeoutHandle = setTimeout(() => {
      subscription.dispose();
      resolve(false);
    }, timeout);
  });
}

/**
 * Ensure there is an editor group directly to the left of the Qwen chat webview.
 * - If one exists, return its ViewColumn.
 * - If none exists, focus the chat panel and create a new group on its left,
 *   then return the new group's ViewColumn.
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
  const webviewGroup = findWebviewGroup();

  if (!webviewGroup) {
    return undefined;
  }

  const initialGroupCount = vscode.window.tabGroups.all.length;

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

  // Wait for the new group to actually be created (check that group count increased)
  const groupCreated = await waitForTabGroupsCondition(
    () => vscode.window.tabGroups.all.length > initialGroupCount,
    1000, // 1 second timeout
  );

  if (!groupCreated) {
    // Fallback if group creation didn't complete in time
    return vscode.ViewColumn.One;
  }

  // After creating a new group to the left, the new group takes ViewColumn.One
  // and all existing groups shift right. So the new left group is always ViewColumn.One.
  // However, to be safe, let's query for it again.
  const newLeftGroup = findLeftGroupOfChatWebview();

  // Restore focus to chat (optional), so we don't disturb user focus
  try {
    await vscode.commands.executeCommand(openChatCommand);
  } catch {
    // Ignore
  }

  // If we successfully found the new left group, return it
  // Otherwise, fallback to ViewColumn.One (the newly created group should be first)
  return newLeftGroup ?? vscode.ViewColumn.One;
}
