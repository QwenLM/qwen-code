/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentLifecycleEventType,
  AgentLifecyclePayload,
  OwnerEventBus,
} from '../ownerEvents.js';
import type { PromptEventBroadcaster } from '../routes/promptEventBroadcaster.js';
import type { AgentRegistry, AgentRecord } from './agentRegistry.js';

/**
 * The notification sink the lifecycle hands frames to. Structurally satisfied
 * by PushNotifier.notify (webpush/notifier.ts) — kept structural so tests can
 * pass a collector and so the lifecycle never imports webpush.
 */
export interface AgentNotifySink {
  notify(
    event: { type: string; data: unknown },
    ctx: { sessionId: string; sessionName?: string },
  ): Promise<void>;
}

/**
 * Drives agent status transitions off the gateway's OWN event plumbing (the
 * SessionEventPump's onEvent seam — no second daemon connection) and emits
 * the five lifecycle frames (design: "agentLifecycle.ts"):
 *
 *  - `session_died` on the agent's session      → `failed`   + agent_failed
 *  - terminal prompt completion (onPromptSettled)→ `completed`+ agent_completed
 *  - outstanding `permission_request`           → `blocked`  + agent_blocked
 *  - `session_update` while blocked             → `running`  (no frame; the
 *    spec registers exactly five event types — resumption is visible via
 *    GET /rc/agents)
 *
 * Every frame goes to: the parent session's SSE stream (when a parent
 * exists), the owner events stream, and the notification pipeline.
 * `setStatus` returning false (unknown id / already terminal) suppresses
 * emission, so a cancelled agent's late session_died is silent.
 */
export class AgentLifecycle {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly ownerEvents: OwnerEventBus,
    private readonly promptEvents?: PromptEventBroadcaster,
    private readonly notifier?: AgentNotifySink,
    /** Read-time cost rollup keyed by sessionId (one source of truth). */
    private readonly costFor?: (sessionId: string) => number | undefined,
  ) {}

  /** Build the wire payload for a record, attaching the live cost rollup. */
  private payloadFor(record: AgentRecord): AgentLifecyclePayload {
    const cost = this.costFor?.(record.sessionId);
    return {
      agentId: record.agentId,
      sessionId: record.sessionId,
      parentSessionId: record.parentSessionId,
      agentType: record.agentType,
      task: record.task,
      status: record.status,
      ...(cost !== undefined ? { costMicrocents: cost } : {}),
    };
  }

  /**
   * Emit one lifecycle frame on all three surfaces. Total: a throwing
   * notifier must never break the caller (notify is best-effort by contract;
   * the void + catch keeps rejections contained).
   *
   * The OWNER events stream (`/rc/events`) NEVER carries the agent's
   * spawning-prompt `task` text — only ids/enums/counts. The parent
   * session's own stream and the notifier both still receive the full
   * `agent` object (the parent already knows the task it spawned with, and
   * the notifier's `buildPayload` already strips to metadata before any push
   * leaves the process — see webpush/payload.ts).
   */
  emit(type: AgentLifecycleEventType, record: AgentRecord): void {
    const agent = this.payloadFor(record);
    const { task: _task, ...ownerSafeAgent } = agent;
    this.ownerEvents.publish({ type, agent: ownerSafeAgent });
    if (record.parentSessionId !== null) {
      this.promptEvents?.emit(record.parentSessionId, { type, data: agent });
    }
    void this.notifier
      ?.notify({ type, data: agent }, { sessionId: record.sessionId })
      .catch(() => {});
  }

  /**
   * Feed one daemon session event through the transition table. Wired into
   * SessionEventPump's `onEvent` by the boot wiring (cli.ts). No-op for
   * sessions that back no agent.
   */
  async handleSessionEvent(
    sessionId: string,
    ev: { type: string; data: unknown },
  ): Promise<void> {
    const rec = this.registry.findBySessionId(sessionId);
    if (!rec) return;

    if (ev.type === 'session_died') {
      if (await this.registry.setStatus(rec.agentId, 'failed')) {
        this.emit('agent_failed', this.registry.get(rec.agentId)!);
      }
      return;
    }
    if (ev.type === 'permission_request' && rec.status === 'running') {
      if (await this.registry.setStatus(rec.agentId, 'blocked')) {
        this.emit('agent_blocked', this.registry.get(rec.agentId)!);
      }
      return;
    }
    if (ev.type === 'session_update' && rec.status === 'blocked') {
      // Permission resolved (tool output flowing again) → back to running.
      // Deliberately NO frame: the spec registers exactly five event types.
      await this.registry.setStatus(rec.agentId, 'running');
    }
  }

  /**
   * Called by routes/agents.ts when the agent's daemon prompt settles:
   * resolve → completed, reject (after the spawn accept window) → failed.
   */
  async onPromptSettled(
    agentId: string,
    outcome: 'completed' | 'failed',
  ): Promise<void> {
    if (await this.registry.setStatus(agentId, outcome)) {
      this.emit(
        outcome === 'completed' ? 'agent_completed' : 'agent_failed',
        this.registry.get(agentId)!,
      );
    }
  }
}
