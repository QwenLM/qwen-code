/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ChatNavigationState {
  sessionId?: string;
  workspaceId?: string;
}

export function readChatNavigation(rawUrl: string): ChatNavigationState {
  try {
    const url = new URL(rawUrl);
    return {
      sessionId: normalizeValue(url.searchParams.get('session')),
      workspaceId: normalizeValue(url.searchParams.get('workspace')),
    };
  } catch {
    return {};
  }
}

export function writeChatNavigation(
  rawUrl: string,
  state: ChatNavigationState,
): string {
  const url = new URL(rawUrl);
  setValue(url, 'session', state.sessionId);
  setValue(url, 'workspace', state.workspaceId);
  return url.href;
}

function setValue(url: URL, name: string, value: string | undefined): void {
  const normalized = normalizeValue(value);
  if (normalized) url.searchParams.set(name, normalized);
  else url.searchParams.delete(name);
}

function normalizeValue(value: string | null | undefined): string | undefined {
  return value && value.length <= 1_024 ? value : undefined;
}
