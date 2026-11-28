/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface RemotePromptSidechannelEvent {
  sessionId: string;
  kind: 'prompt';
}

type RemotePromptListener = (event: RemotePromptSidechannelEvent) => void;

const listeners = new Set<RemotePromptListener>();

export function subscribeSidechannelRemotePrompt(
  listener: RemotePromptListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishSidechannelRemotePrompt(
  event: RemotePromptSidechannelEvent,
): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Sidechannel listeners are best-effort; never disrupt session delivery.
    }
  }
}
