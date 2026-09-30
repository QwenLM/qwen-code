/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DispatchRecord } from '@qwen-code/qwen-code-core';
import {
  claimAgentHostSession,
  readAgentWorkspace,
  releaseAgentHostSession,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import { dispatchOnce } from '@qwen-code/qwen-code-core/agents/workspace-agents/dispatcher.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { beginKeepaliveSessionResume } from '../scheduled-task-keepalive.js';
import type { WorkspaceGenerationGuard } from '../workspace-registry.js';
import { AGENT_HOST_SESSION_SOURCE_TYPE } from '../../runtime/agent-session-source.js';
import { createSessionDispatchPort } from './session-dispatch-port.js';

const DEFAULT_AGENT_KEEPALIVE_INTERVAL_MS = 1_000;
const DEFAULT_AGENT_RESUME_TIMEOUT_MS = 70_000;

interface AgentHostBridge {
  recordHeartbeat(sessionId: string): unknown;
  // Not narrowed to `Promise<unknown>`: the same object is handed to the
  // dispatch port as an `AgentSessionBridge`, which is a `Pick` of the real
  // bridge, so a looser return here makes it unassignable there.
  resumeSession: AcpSessionBridge['resumeSession'];
  // Not narrowed to `{ sessionId }`: the same object is handed to the dispatch
  // port as an `AgentSessionBridge`, which is a `Pick` of the real bridge, so
  // a narrower return here makes it unassignable there.
  spawnOrAttach: AcpSessionBridge['spawnOrAttach'];
  closeSession(sessionId: string): Promise<unknown>;
  // Dispatch reads and writes sessions, which live in this process's bridge,
  // so the loop runs here rather than being forwarded into a child. The ACP
  // round trip existed only because the bodies used to be background agents
  // inside one host process.
  sendPrompt: AcpSessionBridge['sendPrompt'];
  listWorkspaceSessions: AcpSessionBridge['listWorkspaceSessions'];
  cancelSession: AcpSessionBridge['cancelSession'];
  // Read by the port's `totalTokens`: an agent session reports what it has
  // spent, and the per-tree budget charges the difference across a run.
  getSessionStatsStatus: AcpSessionBridge['getSessionStatsStatus'];
  // Mid-turn delivery: the port hands a message to a session that is already
  // working, so the host's bridge surface has to carry it too.
  enqueueMidTurnMessage: AcpSessionBridge['enqueueMidTurnMessage'];
}

export interface AgentHostSessionOwner {
  dispatch(): Promise<void>;
  stop(): Promise<void>;
}

export function startAgentHostSessionOwner(options: {
  bridge: AgentHostBridge;
  workspaceCwd: string;
  generationGuard?: WorkspaceGenerationGuard;
}): AgentHostSessionOwner {
  const { bridge, workspaceCwd } = options;
  const assertGenerationOpen = () => options.generationGuard?.assertOpen();
  const port = createSessionDispatchPort({ bridge, workspaceCwd });
  let ensuring: Promise<string> | undefined;
  let reviving:
    | {
        completion: Promise<unknown>;
        deadline: Promise<unknown>;
        definitivelyFailed: boolean;
      }
    | undefined;

  const ensure = async (): Promise<string> => {
    assertGenerationOpen();
    const workspace = await readAgentWorkspace(workspaceCwd);
    assertGenerationOpen();
    if (workspace.hostSessionId) {
      try {
        bridge.recordHeartbeat(workspace.hostSessionId);
      } catch {
        assertGenerationOpen();
        if (!reviving) {
          const started = beginKeepaliveSessionResume(
            bridge,
            {
              sessionId: workspace.hostSessionId,
              workspaceCwd,
              sourceType: AGENT_HOST_SESSION_SOURCE_TYPE,
              sourceId: workspace.workspaceId,
            },
            DEFAULT_AGENT_RESUME_TIMEOUT_MS,
          );
          const current = {
            ...started,
            definitivelyFailed: false,
          };
          reviving = current;
          void started.completion
            .catch((error: unknown) => {
              current.definitivelyFailed = true;
              throw error;
            })
            .finally(() => {
              if (reviving === current) reviving = undefined;
            })
            .catch(() => {});
        }
        const current = reviving;
        try {
          await current.deadline;
          assertGenerationOpen();
        } catch (error) {
          await Promise.resolve();
          if (!current.definitivelyFailed) throw error;
          assertGenerationOpen();
          await releaseAgentHostSession(workspaceCwd, workspace.hostSessionId);
          return ensure();
        }
      }
      return workspace.hostSessionId;
    }

    const spawned = await bridge.spawnOrAttach({
      workspaceCwd,
      sessionScope: 'thread',
      sourceType: AGENT_HOST_SESSION_SOURCE_TYPE,
      sourceId: workspace.workspaceId,
    });
    let winner: string;
    try {
      assertGenerationOpen();
      winner = await claimAgentHostSession(workspaceCwd, spawned.sessionId);
      assertGenerationOpen();
    } catch (error) {
      await releaseAgentHostSession(workspaceCwd, spawned.sessionId).catch(
        () => false,
      );
      await bridge.closeSession(spawned.sessionId).catch(() => {});
      throw error;
    }
    if (winner !== spawned.sessionId) {
      await bridge.closeSession(spawned.sessionId).catch(() => {});
      return ensure();
    }
    return winner;
  };

  const ensureResident = (): Promise<string> => {
    ensuring ??= ensure().finally(() => {
      ensuring = undefined;
    });
    return ensuring;
  };

  let dispatching: Promise<DispatchRecord[]> | undefined;
  const dispatch = (): Promise<DispatchRecord[]> => {
    dispatching ??= dispatchOnce(workspaceCwd, port).finally(() => {
      dispatching = undefined;
    });
    return dispatching;
  };

  const tick = async (): Promise<void> => {
    assertGenerationOpen();
    const workspace = await readAgentWorkspace(workspaceCwd);
    assertGenerationOpen();
    if (!workspace.hostSessionId) return;
    // The host still holds the workspace claim, so exactly one daemon
    // dispatches; it no longer holds the agents themselves.
    await ensureResident();
    assertGenerationOpen();
    await dispatch();
  };

  let running = false;
  let inFlight: Promise<void> | undefined;
  // Declared before `stop` so the closure can clear it, and assigned after so
  // the interval's own callback can call `stop`. The cycle is why this is a
  // `let` that eslint reads as never reassigned before its first use.
  // eslint-disable-next-line prefer-const
  let timer: ReturnType<typeof setInterval> | undefined;
  // Memoized so that every caller awaits the same drain. A boolean flag makes
  // `stop()` idempotent but not single-flight: the second caller would return
  // at once and go on to release and close the host session while an `ensure()`
  // is still inside `spawnOrAttach`, which is what the drain exists to prevent.
  // `clearInterval` runs before the first await, so a caller that does not
  // await still stops the ticks synchronously.
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      if (timer) clearInterval(timer);
      // A tick or dispatch already in flight can still be inside ensure();
      // releasing the host session before it settles would orphan whatever it
      // spawns. Drain first — the caller's teardown order depends on it.
      await Promise.allSettled([inFlight, dispatching, ensuring]);
    })());
  timer = setInterval(() => {
    if (options.generationGuard?.closed) {
      void stop();
      return;
    }
    if (running) return;
    running = true;
    inFlight = tick()
      .catch(() => {})
      .finally(() => {
        running = false;
        inFlight = undefined;
      });
  }, DEFAULT_AGENT_KEEPALIVE_INTERVAL_MS);
  timer.unref?.();

  return {
    async dispatch() {
      await ensureResident();
      assertGenerationOpen();
      await dispatch();
    },
    stop,
  };
}
