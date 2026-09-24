/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live updates for the Web Shell collaboration views.
 *
 * Two sources feed one stream per workspace:
 * - `changed`: a write under the workspace's agent store (agents or a
 *   thread). Found with `fs.watch`, so every writer — routes, the dispatch
 *   loop, thread tools inside agent sessions — is covered without each of them
 *   having to remember to publish.
 * - `progress`: a running agent's reply as it streams, published by the
 *   dispatch port. It goes straight to the browser and never waits on disk.
 */

import { watch, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import {
  getAgentsDir,
  getThreadsDir,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';

export interface AgentPermissionPrompt {
  requestId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
}

export interface AgentRunStep {
  id: string;
  title: string;
  status: 'running' | 'done' | 'failed';
}

export interface AgentRunProgressEvent {
  type: 'progress';
  threadId: string;
  runId: string;
  attempt: number;
  sessionId: string;
  stage: string;
  detail: string;
  outputText: string;
  thoughtText: string;
  /** Last time the agent did anything; the client derives "stalled" from it. */
  activityAt: number;
  permission?: AgentPermissionPrompt;
  steps?: AgentRunStep[];
}

export type AgentLiveEvent =
  | { type: 'changed'; threadId?: string }
  | AgentRunProgressEvent;

type Listener = (event: AgentLiveEvent) => void;

interface Hub {
  listeners: Set<Listener>;
  watchers: FSWatcher[];
  pending: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

const hubs = new Map<string, Hub>();
const CHANGE_DEBOUNCE_MS = 100;
const WORKSPACE_CHANGE = '';

export function publishAgentEvent(
  workspaceCwd: string,
  event: AgentLiveEvent,
): void {
  const hub = hubs.get(workspaceCwd);
  if (!hub) return;
  for (const listener of hub.listeners) listener(event);
}

function queueChange(hub: Hub, threadId: string): void {
  hub.pending.add(threadId);
  hub.timer ??= setTimeout(() => {
    hub.timer = undefined;
    const pending = [...hub.pending];
    hub.pending.clear();
    for (const id of pending) {
      const event: AgentLiveEvent =
        id === WORKSPACE_CHANGE
          ? { type: 'changed' }
          : { type: 'changed', threadId: id };
      for (const listener of hub.listeners) listener(event);
    }
  }, CHANGE_DEBOUNCE_MS);
}

function watchDir(hub: Hub, dir: string, onFile: (name: string) => void): void {
  try {
    const watcher = watch(dir, (_event, name) => {
      // Lock directories and atomic-write temp files are not state.
      if (name?.endsWith('.json')) onFile(name);
    });
    watcher.on('error', () => watcher.close());
    watcher.unref();
    hub.watchers.push(watcher);
  } catch {
    // No watcher, no push: the client still refetches after its own writes
    // and on every reconnect, so it degrades to "update on action".
  }
}

/**
 * Subscribes to one workspace's live events. The file watchers start with the
 * first subscriber and close with the last, so an idle daemon holds none.
 */
export async function subscribeAgentEvents(
  workspaceCwd: string,
  listener: Listener,
): Promise<() => void> {
  let hub = hubs.get(workspaceCwd);
  if (!hub) {
    const created: Hub = {
      listeners: new Set(),
      watchers: [],
      pending: new Set(),
    };
    hub = created;
    hubs.set(workspaceCwd, created);
    const threadsDir = getThreadsDir(workspaceCwd);
    await mkdir(threadsDir, { recursive: true }).catch(() => {});
    watchDir(created, getAgentsDir(workspaceCwd), () =>
      queueChange(created, WORKSPACE_CHANGE),
    );
    watchDir(created, threadsDir, (name) =>
      queueChange(created, name.slice(0, -5)),
    );
  }
  const current = hub;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size > 0 || hubs.get(workspaceCwd) !== current)
      return;
    hubs.delete(workspaceCwd);
    if (current.timer) clearTimeout(current.timer);
    for (const watcher of current.watchers) watcher.close();
  };
}
