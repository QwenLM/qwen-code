/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';
import type { DaemonClient, DaemonLiveStatus } from '@qwen-code/sdk/daemon';

export interface LivePresence {
  callId?: string;
  state: 'connecting' | DaemonLiveStatus['state'];
  coordinator?: DaemonLiveStatus['coordinator'];
}

interface Entry {
  snapshot: LivePresence | undefined;
  listeners: Set<() => void>;
}

const entries = new WeakMap<DaemonClient, Entry>();

function entry(client: DaemonClient): Entry {
  let current = entries.get(client);
  if (!current) {
    current = { snapshot: undefined, listeners: new Set() };
    entries.set(client, current);
  }
  return current;
}

export function setLivePresence(
  client: DaemonClient,
  presence: LivePresence | undefined,
): void {
  const current = entry(client);
  if (
    current.snapshot?.callId === presence?.callId &&
    current.snapshot?.state === presence?.state &&
    current.snapshot?.coordinator?.sessionId ===
      presence?.coordinator?.sessionId
  ) {
    return;
  }
  current.snapshot = presence;
  current.listeners.forEach((listener) => listener());
}

export function getLivePresence(
  client: DaemonClient,
): LivePresence | undefined {
  return entry(client).snapshot;
}

export function useLivePresence(
  client: DaemonClient,
): LivePresence | undefined {
  return useSyncExternalStore(
    (listener) => {
      const current = entry(client);
      current.listeners.add(listener);
      return () => current.listeners.delete(listener);
    },
    () => entry(client).snapshot,
  );
}
