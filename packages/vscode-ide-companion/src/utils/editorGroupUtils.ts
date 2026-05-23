/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';

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

function findNeighborGroup(
  isOnSide: (v: vscode.ViewColumn) => boolean,
  isCloser: (cur: vscode.ViewColumn, cand: vscode.ViewColumn) => boolean,
): vscode.ViewColumn | undefined {
  let candidate: vscode.ViewColumn | undefined;
  for (const g of vscode.window.tabGroups.all) {
    if (!isOnSide(g.viewColumn)) continue;
    if (candidate === undefined || isCloser(candidate, g.viewColumn)) {
      candidate = g.viewColumn;
    }
  }
  return candidate;
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
    return findNeighborGroup(
      (v) => v < webviewGroup.viewColumn,
      (cur, cand) => cand > cur,
    );
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
    return findNeighborGroup(
      (v) => v > webviewGroup.viewColumn,
      (cur, cand) => cand < cur,
    );
  } catch (_err) {
    return undefined;
  }
}
