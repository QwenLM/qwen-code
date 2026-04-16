/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview TeamManager — central orchestrator for agent teams.
 *
 * Owns the Backend, subscribes to agent events, coordinates lifecycle,
 * handles message routing with priority, idle detection, and auto
 * task claiming.
 *
 * Follows the ArenaManager pattern: real AgentEventEmitter events
 * flow through the event bridge to drive coordination logic.
 */

import type { Backend, AgentSpawnConfig } from '../backends/types.js';
import { AgentStatus, isTerminalStatus } from '../runtime/agent-types.js';
import { AgentEventType } from '../runtime/agent-events.js';
import type {
  AgentStatusChangeEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentApprovalRequestEvent,
} from '../runtime/agent-events.js';
import {
  forwardApproval,
  wrapConfirmWithBadge,
} from './leaderPermissionBridge.js';
import type { TeammateApprovalRequestEvent } from './team-events.js';
import { TeamEventEmitter, TeamEventType } from './team-events.js';
import type { TeamFile, TeamMember, TeammateIdentity } from './types.js';
import { MAX_TEAMMATES } from './types.js';
import {
  formatAgentId,
  generateUniqueTeammateName,
  assignTeammateColor,
  writeTeamFile,
  findMemberByName,
} from './teamHelpers.js';
import {
  consumeUnread,
  sendStructuredMessage,
  writeMessage,
  readInbox,
} from './mailbox.js';
import {
  listTasks,
  claimTask,
  onTasksUpdated,
  unassignTeammateTasks,
} from './tasks.js';
import { buildTeammatePromptAddendum } from './promptAddendum.js';
import { runWithTeammateIdentity } from './identity.js';
import type { SubagentManager } from '../../subagents/subagent-manager.js';
import type { ToolConfig } from '../runtime/agent-types.js';

// ─── Types ──────────────────────────────────────────────────

/**
 * Minimal agent surface that TeamManager needs.
 * Both AgentInteractive and FakeAgent satisfy this.
 */
export interface TeamAgentHandle {
  getStatus(): AgentStatus;
  getEventEmitter():
    | {
        on(event: string, listener: (...args: never[]) => void): void;
        off(event: string, listener: (...args: never[]) => void): void;
      }
    | undefined;
  enqueueMessage(msg: string): void;
  abort(): void;
}

/** Configuration for spawning a teammate. */
export interface TeammateSpawnConfig {
  /** Human-readable name (will be sanitized). */
  name: string;
  /** Agent type (subagent definition name). */
  agentType?: string;
  /** Model identifier override. */
  model?: string;
  /** Custom system prompt. */
  prompt?: string;
  /** Working directory (defaults to team leader's cwd). */
  cwd?: string;
}

/** Priority levels for pending messages (lower = higher priority). */
const enum MessagePriority {
  SHUTDOWN = 0,
  LEADER = 1,
  PEER = 2,
}

/** A message waiting to be delivered to an agent. */
interface PendingMessage {
  text: string;
  from: string;
  priority: MessagePriority;
}

// ─── TeamManager ────────────────────────────────────────────

export class TeamManager {
  private readonly backend: Backend;
  private teamFile: TeamFile;
  private readonly teamEventEmitter = new TeamEventEmitter();

  /** Per-agent pending message queues. */
  private readonly pendingMessages = new Map<string, PendingMessage[]>();

  /** Cleanup functions for event bridge listeners. */
  private readonly eventBridgeCleanups: Array<() => void> = [];

  /** Unsubscribe from task update notifications. */
  private taskUpdateUnsubscribe?: () => void;

  /** Leader inbox polling interval. */
  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  /** Callback to inject teammate messages into the leader. */
  private leaderMessageCallback: ((message: string) => void) | null = null;

  /** Tracks how far we've read in the leader inbox. */
  private lastInboxOffset = 0;

  /** Set when a shutdown has been requested for any agent.
   *  Gates the per-idle mailbox read in flushNextMessage. */
  private _shutdownRequested = false;

  /** Per-agent last activity timestamp (updated on events). */
  private readonly lastActivityAt = new Map<string, number>();

  /** Per-agent teammate identity for re-entering AsyncLocalStorage. */
  private readonly agentIdentities = new Map<string, TeammateIdentity>();

  /** Optional subagent manager for loading specialized agent configs. */
  private readonly subagentManager: SubagentManager | null;

  constructor(
    backend: Backend,
    teamFile: TeamFile,
    subagentManager?: SubagentManager | null,
  ) {
    this.backend = backend;
    this.teamFile = teamFile;
    this.subagentManager = subagentManager ?? null;

    // Subscribe to task updates so we can auto-claim for
    // idle agents when new tasks appear.
    this.taskUpdateUnsubscribe = onTasksUpdated((teamName) => {
      if (teamName === this.teamFile.name) {
        void this.scanIdleAgentsForTasks();
      }
    });
  }

  // ─── Teammate lifecycle ─────────────────────────────────

  /**
   * Spawn a new teammate. Adds the member to the team file,
   * spawns via backend, and sets up the event bridge.
   */
  async spawnTeammate(config: TeammateSpawnConfig): Promise<void> {
    if (this.teamFile.members.length >= MAX_TEAMMATES) {
      throw new Error(
        `Maximum number of teammates (${MAX_TEAMMATES}) reached.`,
      );
    }

    const name = generateUniqueTeammateName(config.name, this.teamFile.members);
    const agentId = formatAgentId(name, this.teamFile.name);
    const color = assignTeammateColor(this.teamFile.members);
    const cwd = config.cwd ?? process.cwd();

    const member: TeamMember = {
      agentId,
      name,
      agentType: config.agentType,
      model: config.model,
      prompt: config.prompt,
      color,
      joinedAt: Date.now(),
      cwd,
      tmuxPaneId: '',
      backendType: this.backend.type,
      isActive: undefined,
      subscriptions: [],
    };

    // Load specialized subagent config when an agentType is specified.
    // Copies prompt, model, runConfig, and tools from the subagent
    // definition so the teammate behaves like that agent type.
    let subagentPrompt: string | undefined;
    let subagentModel: string | undefined;
    let subagentRunConfig: Record<string, unknown> | undefined;
    let toolConfig: ToolConfig | undefined;
    if (config.agentType && this.subagentManager) {
      const subagentConfig = await this.subagentManager.loadSubagent(
        config.agentType,
      );
      if (!subagentConfig) {
        throw new Error(`Subagent type "${config.agentType}" not found.`);
      }
      const runtimeCfg =
        this.subagentManager.convertToRuntimeConfig(subagentConfig);
      subagentPrompt = runtimeCfg.promptConfig.systemPrompt;
      subagentModel = runtimeCfg.modelConfig.model;
      subagentRunConfig = runtimeCfg.runConfig as Record<string, unknown>;
      toolConfig = runtimeCfg.toolConfig;
      // Ensure team coordination tools are always available,
      // even when the subagent defines a restricted tool set.
      if (toolConfig) {
        const teamTools = [
          'send_message',
          'task_list',
          'task_update',
          'task_create',
        ];
        const existing = new Set(
          toolConfig.tools.map((t) => (typeof t === 'string' ? t : t.name)),
        );
        for (const tool of teamTools) {
          if (!existing.has(tool)) {
            toolConfig.tools.push(tool);
          }
        }
      }
    }

    // Build system prompt: subagent prompt (if any) or user prompt + team addendum.
    const addendum = buildTeammatePromptAddendum(
      name,
      this.teamFile.name,
      'leader',
    );
    const basePrompt = subagentPrompt ?? config.prompt;
    const systemPrompt = basePrompt ? `${basePrompt}\n\n${addendum}` : addendum;

    // Build spawn config for the backend.
    const spawnConfig: AgentSpawnConfig = {
      agentId,
      command: '',
      args: [],
      cwd,
      inProcess: {
        agentName: name,
        completeOnIdle: false,
        initialTask:
          config.prompt ??
          'You have joined the team. Call task_list now to ' +
            'find pending tasks. Claim one with task_update ' +
            '(status: "in_progress"), do the work, report ' +
            'via send_message(to: "leader"), then mark ' +
            'completed with task_update.',
        runtimeConfig: {
          promptConfig: {
            systemPrompt,
          },
          modelConfig: {
            model: config.model ?? subagentModel,
          },
          runConfig: {
            ...subagentRunConfig,
          },
          toolConfig,
        },
      },
    };

    // Store identity so flushNextMessage can re-enter it
    // on follow-up turns (enqueueMessage runs outside the
    // original AsyncLocalStorage context).
    const identity: TeammateIdentity = {
      agentName: name,
      teamName: this.teamFile.name,
      agentId,
      color,
      isTeamLead: false,
    };

    // Register the member only after config validation succeeds.
    // If spawnAgent() fails below, we roll back to avoid ghost members.
    this.teamFile.members.push(member);
    this.pendingMessages.set(agentId, []);
    this.lastActivityAt.set(agentId, Date.now());
    this.agentIdentities.set(agentId, identity);

    try {
      // Wrap in teammate identity so that AsyncLocalStorage
      // propagates through the agent's start() async chain.
      await runWithTeammateIdentity(identity, () =>
        this.backend.spawnAgent(spawnConfig),
      );
    } catch (err) {
      // Roll back in-memory membership state so the name and
      // slot can be reused.
      const idx = this.teamFile.members.indexOf(member);
      if (idx !== -1) this.teamFile.members.splice(idx, 1);
      this.pendingMessages.delete(agentId);
      this.lastActivityAt.delete(agentId);
      this.agentIdentities.delete(agentId);
      throw err;
    }
    this.setupEventBridge(agentId, name);

    await writeTeamFile(this.teamFile.name, this.teamFile);

    this.teamEventEmitter.emit(TeamEventType.TEAMMATE_JOINED, {
      agentId,
      name,
      color,
      timestamp: Date.now(),
    });

    this.ensureLeaderInboxPolling();
  }

  // ─── Message routing ────────────────────────────────────

  /**
   * Send a message to a teammate by name.
   * If the agent is idle, delivers immediately. Otherwise,
   * queues with priority based on sender.
   */
  async sendMessage(
    toName: string,
    message: string,
    from?: string,
  ): Promise<void> {
    // Messages addressed to the leader go to leader's mailbox.
    if (
      toName.toLowerCase() === 'leader' ||
      toName === this.teamFile.leadAgentId
    ) {
      await writeMessage(this.teamFile.name, 'leader', {
        from: from ?? 'unknown',
        text: message,
        timestamp: new Date().toISOString(),
        read: false,
      });
      this.teamEventEmitter.emit(TeamEventType.MESSAGE_SENT, {
        from: from ?? 'unknown',
        to: 'leader',
        message,
        timestamp: Date.now(),
      });

      // Handle shutdown responses: if the teammate approved
      // the shutdown, abort the agent so it actually retires.
      if (
        this._shutdownRequested &&
        from &&
        /\bshutdown_approved\b/i.test(message)
      ) {
        const member = findMemberByName(this.teamFile.members, from);
        if (member) {
          const agent = this.getAgentFromBackend(member.agentId);
          if (agent) {
            agent.abort();
          }
        }
      }

      return;
    }

    const member = findMemberByName(this.teamFile.members, toName);
    if (!member) {
      throw new Error(`Teammate "${toName}" not found.`);
    }

    const priority = this.getSenderPriority(from);

    const queue = this.pendingMessages.get(member.agentId);
    if (queue) {
      queue.push({ text: message, from: from ?? '', priority });
    }

    this.teamEventEmitter.emit(TeamEventType.MESSAGE_SENT, {
      from: from ?? 'unknown',
      to: toName,
      message,
      timestamp: Date.now(),
    });

    // If agent is idle, flush immediately.
    const agent = this.getAgentFromBackend(member.agentId);
    if (agent && agent.getStatus() === AgentStatus.IDLE) {
      await this.flushNextMessage(member.agentId, member.name);
    }
  }

  /**
   * Broadcast a message to all teammates and the leader
   * (except the sender).
   */
  async broadcast(message: string, fromName: string): Promise<void> {
    const promises = this.teamFile.members
      .filter((m) => m.name.toLowerCase() !== fromName.toLowerCase())
      .map((m) => this.sendMessage(m.name, message, fromName));

    // Also deliver to leader inbox if sender is not the leader.
    if (fromName.toLowerCase() !== 'leader') {
      promises.push(this.sendMessage('leader', message, fromName));
    }

    await Promise.all(promises);
  }

  /**
   * Request cooperative shutdown of a teammate.
   * Sends a shutdown_request to the agent's mailbox.
   */
  async requestShutdown(name: string): Promise<void> {
    const member = findMemberByName(this.teamFile.members, name);
    if (!member) {
      throw new Error(`Teammate "${name}" not found.`);
    }

    this._shutdownRequested = true;

    await sendStructuredMessage(this.teamFile.name, member.name, {
      from: 'leader',
      type: 'shutdown_request',
      text:
        'The team leader has requested that you shut down. ' +
        'Please finish your current work and use ' +
        'send_message to reply to "leader" with either ' +
        '"shutdown_approved" or "shutdown_rejected: <reason>".',
      summary: 'Shutdown requested by leader',
    });

    // If agent is idle, flush immediately (shutdown has
    // highest priority and will be picked up from mailbox).
    const agent = this.getAgentFromBackend(member.agentId);
    if (agent && agent.getStatus() === AgentStatus.IDLE) {
      await this.flushNextMessage(member.agentId, member.name);
    }
  }

  /**
   * Read all messages sent to the leader by teammates.
   * Returns the messages and marks them as read.
   */
  async getLeaderMessages(): Promise<
    Array<{ from: string; text: string; timestamp: string }>
  > {
    try {
      const messages = await readInbox(this.teamFile.name, 'leader');
      return messages.map((m) => ({
        from: m.from,
        text: m.text,
        timestamp: m.timestamp,
      }));
    } catch {
      return [];
    }
  }

  // ─── Leader inbox polling ────────────────────────────────

  /**
   * Register the callback that delivers teammate messages
   * to the leader's conversation. Called by the CLI layer.
   */
  setLeaderMessageCallback(cb: (message: string) => void): void {
    this.leaderMessageCallback = cb;
  }

  /**
   * Start polling the leader inbox (idempotent).
   * Called automatically when the first teammate is spawned.
   */
  private ensureLeaderInboxPolling(): void {
    if (this.pollingInterval) return;
    this.pollingInterval = setInterval(() => void this.pollLeaderInbox(), 500);
  }

  /**
   * Stop polling the leader inbox.
   */
  stopLeaderInboxPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Check for new leader inbox messages and deliver them.
   */
  private async pollLeaderInbox(): Promise<void> {
    if (!this.leaderMessageCallback) {
      return;
    }
    try {
      const inbox = await readInbox(this.teamFile.name, 'leader');
      if (inbox.length <= this.lastInboxOffset) {
        // No new messages — check if all teammates are done.
        const terminated = this.allTeammatesTerminated();
        if (terminated) {
          this.stopLeaderInboxPolling();
          this.teamEventEmitter.emit(TeamEventType.ALL_TEAMMATES_TERMINATED, {
            timestamp: Date.now(),
          });
        }
        return;
      }

      const newMessages = inbox.slice(this.lastInboxOffset);
      this.lastInboxOffset = inbox.length;

      const formatted = newMessages
        .map(
          (m) =>
            `<teammate_message from="${m.from}">` +
            `\n${m.text}\n` +
            `</teammate_message>`,
        )
        .join('\n\n');

      this.leaderMessageCallback(formatted);
    } catch {
      // Inbox may not exist yet.
    }
  }

  /**
   * Returns true if any teammate is still actively working or
   * has pending messages/tasks to process. An IDLE teammate
   * with an empty queue is not considered active — it has
   * finished its current work and is waiting to be re-engaged.
   */
  hasActiveTeammates(): boolean {
    for (const member of this.teamFile.members) {
      const agent = this.getAgentFromBackend(member.agentId);
      if (!agent) continue;
      const status = agent.getStatus();
      if (isTerminalStatus(status)) continue;
      // A non-IDLE, non-terminal agent is actively processing.
      if (status !== AgentStatus.IDLE) return true;
      // IDLE but has queued messages — will resume shortly.
      const queue = this.pendingMessages.get(member.agentId);
      if (queue && queue.length > 0) return true;
    }
    return false;
  }

  /**
   * Returns true when all teammates have reached a
   * terminal status (COMPLETED, FAILED, CANCELLED).
   * Unlike hasActiveTeammates(), this does NOT treat idle
   * teammates as terminated — they are still alive and
   * can receive messages, so inbox polling must continue.
   */
  allTeammatesTerminated(): boolean {
    for (const member of this.teamFile.members) {
      const agent = this.getAgentFromBackend(member.agentId);
      if (!agent) continue;
      if (!isTerminalStatus(agent.getStatus())) return false;
    }
    return true;
  }

  /**
   * Returns a promise that resolves when either:
   * - A teammate message is delivered via the callback,
   * - All teammates have reached terminal status, or
   * - The timeout fires (default 30s).
   *
   * Returns the reason it resolved so the caller can
   * decide whether to inject a status summary.
   */
  waitForTeammateActivity(
    timeoutMs = 120_000,
    signal?: AbortSignal,
  ): Promise<'message' | 'terminated' | 'timeout' | 'aborted'> {
    return new Promise<'message' | 'terminated' | 'timeout' | 'aborted'>(
      (resolve) => {
        if (signal?.aborted) {
          resolve('aborted');
          return;
        }

        if (this.allTeammatesTerminated()) {
          resolve('terminated');
          return;
        }

        let resolved = false;
        const finish = (
          reason: 'message' | 'terminated' | 'timeout' | 'aborted',
        ) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          // Restore original callback if we wrapped it.
          if (wrappedCb) {
            this.leaderMessageCallback = origCb;
          }
          this.teamEventEmitter.off(
            TeamEventType.ALL_TEAMMATES_TERMINATED,
            onTerminated,
          );
          resolve(reason);
        };

        // Resolve immediately if the signal fires.
        const onAbort = () => finish('aborted');
        signal?.addEventListener('abort', onAbort, {
          once: true,
        });

        // Resolve when a message is delivered.
        const origCb = this.leaderMessageCallback;
        let wrappedCb = true;
        this.leaderMessageCallback = (msg) => {
          this.leaderMessageCallback = origCb;
          wrappedCb = false;
          origCb?.(msg);
          finish('message');
        };

        // Resolve when all teammates terminate.
        const onTerminated = () => finish('terminated');
        this.teamEventEmitter.once(
          TeamEventType.ALL_TEAMMATES_TERMINATED,
          onTerminated,
        );

        // Resolve on timeout.
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
      },
    );
  }

  /**
   * Build a human-readable status summary of all teammates.
   * Injected into the leader's conversation on wait timeout.
   */
  /** Seconds of inactivity before a teammate is considered stalled. */
  private static readonly STALL_THRESHOLD_S = 600;

  buildTeamStatusSummary(): string {
    const lines: string[] = [];
    let active = 0;
    let completed = 0;
    let stalled = 0;

    for (const member of this.teamFile.members) {
      const agent = this.getAgentFromBackend(member.agentId);
      if (!agent) continue;

      const status = agent.getStatus();
      const elapsed = Math.round((Date.now() - member.joinedAt) / 1000);

      if (isTerminalStatus(status)) {
        completed++;
        lines.push(`  - ${member.name}: ${status.toUpperCase()}`);
      } else {
        const lastAct = this.lastActivityAt.get(member.agentId);
        const lastActivityAgo = lastAct
          ? Math.round((Date.now() - lastAct) / 1000)
          : elapsed;

        if (lastActivityAgo >= TeamManager.STALL_THRESHOLD_S) {
          stalled++;
          lines.push(
            `  - ${member.name}: STALLED` +
              ` (no activity for ${lastActivityAgo}s)`,
          );
        } else {
          active++;
          lines.push(
            `  - ${member.name}: RUNNING` +
              ` (${elapsed}s, last activity` +
              ` ${lastActivityAgo}s ago)`,
          );
        }
      }
    }

    const parts = [
      '<team_status>',
      `${active} active, ${completed} completed` +
        (stalled > 0 ? `, ${stalled} stalled.` : '.'),
      ...lines,
    ];

    if (stalled > 0 && active === 0) {
      parts.push(
        '',
        'All remaining teammates are stalled.' +
          ' Proceed with the results you have' +
          ' — write your report now.',
      );
    } else {
      parts.push(
        '',
        'Do NOT call task_list to check on teammates.' +
          ' Their results will arrive as messages.' +
          ' Wait patiently or proceed with other work.',
      );
    }

    parts.push('</team_status>');
    return parts.join('\n');
  }

  /**
   * Returns true if all non-terminal teammates are stalled
   * (no activity for STALL_THRESHOLD_S seconds).
   */
  allRemainingStalled(): boolean {
    for (const member of this.teamFile.members) {
      const agent = this.getAgentFromBackend(member.agentId);
      if (!agent) continue;

      const status = agent.getStatus();
      if (isTerminalStatus(status)) continue;

      const lastAct = this.lastActivityAt.get(member.agentId);
      const ago = lastAct
        ? (Date.now() - lastAct) / 1000
        : (Date.now() - member.joinedAt) / 1000;

      if (ago < TeamManager.STALL_THRESHOLD_S) {
        return false;
      }
    }
    return true;
  }

  /**
   * Abort all teammates that have been stalled for longer
   * than the stall threshold. This transitions them from
   * RUNNING to CANCELLED so the leader can exit.
   */
  abortStalledTeammates(): void {
    for (const member of this.teamFile.members) {
      const agent = this.getAgentFromBackend(member.agentId);
      if (!agent) continue;

      const status = agent.getStatus();
      if (isTerminalStatus(status)) continue;

      const lastAct = this.lastActivityAt.get(member.agentId);
      const ago = lastAct
        ? (Date.now() - lastAct) / 1000
        : (Date.now() - member.joinedAt) / 1000;

      if (ago >= TeamManager.STALL_THRESHOLD_S) {
        agent.abort();
      }
    }
  }

  // ─── Accessors ──────────────────────────────────────────

  getTeamFile(): TeamFile {
    return this.teamFile;
  }

  getBackend(): Backend {
    return this.backend;
  }

  getEventEmitter(): TeamEventEmitter {
    return this.teamEventEmitter;
  }

  /** Mark that a shutdown has been requested so the mailbox is
   *  checked on the next idle transition. */
  markShutdownRequested(): void {
    this._shutdownRequested = true;
  }

  /**
   * Get an agent object from the backend by agent ID.
   * Works with both InProcessBackend and FakeBackend
   * (both expose getAgent()).
   */
  getAgentFromBackend(agentId: string): TeamAgentHandle | undefined {
    // InProcessBackend and FakeBackend both have getAgent()
    // but it's not on the Backend interface. Access via the
    // concrete type.
    const backend = this.backend as {
      getAgent?: (id: string) => TeamAgentHandle | undefined;
    };
    return backend.getAgent?.(agentId);
  }

  // ─── Cleanup ────────────────────────────────────────────

  async cleanup(): Promise<void> {
    this.stopLeaderInboxPolling();

    this.taskUpdateUnsubscribe?.();
    this.taskUpdateUnsubscribe = undefined;

    for (const cleanup of this.eventBridgeCleanups) {
      cleanup();
    }
    this.eventBridgeCleanups.length = 0;

    this.pendingMessages.clear();
    this.lastActivityAt.clear();
    this.teamEventEmitter.removeAllListeners();

    await this.backend.cleanup();
  }

  // ─── Private: Event bridge ──────────────────────────────

  /**
   * Set up event bridge for a single agent.
   * Subscribes to STATUS_CHANGE to drive idle detection,
   * message flushing, and auto task claiming.
   */
  private setupEventBridge(agentId: string, agentName: string): void {
    const agent = this.getAgentFromBackend(agentId);
    if (!agent) return;

    const emitter = agent.getEventEmitter();
    if (!emitter) return;

    // Track activity for stall detection.
    const recordActivity = () => {
      this.lastActivityAt.set(agentId, Date.now());
    };

    const onStatusChange = (event: AgentStatusChangeEvent) => {
      recordActivity();

      this.teamEventEmitter.emit(TeamEventType.TEAMMATE_STATUS_CHANGE, {
        agentId,
        name: agentName,
        previousStatus: event.previousStatus,
        newStatus: event.newStatus,
        timestamp: Date.now(),
      });

      if (event.newStatus === AgentStatus.IDLE) {
        this.teamEventEmitter.emit(TeamEventType.TEAMMATE_IDLE, {
          agentId,
          name: agentName,
          timestamp: Date.now(),
        });
        void this.flushNextMessage(agentId, agentName);
      }

      if (isTerminalStatus(event.newStatus)) {
        // Release any in_progress tasks back to pending so
        // other teammates can pick them up.
        void unassignTeammateTasks(this.teamFile.name, agentId).then(
          (count) => {
            if (count > 0) {
              void this.scanIdleAgentsForTasks();
            }
          },
        );

        this.teamEventEmitter.emit(TeamEventType.TEAMMATE_EXITED, {
          agentId,
          name: agentName,
          status: event.newStatus,
          timestamp: Date.now(),
        });
      }
    };

    const onToolCall = (_event: AgentToolCallEvent) => {
      recordActivity();
    };

    const onToolResult = (_event: AgentToolResultEvent) => {
      recordActivity();
    };

    emitter.on(AgentEventType.STATUS_CHANGE, onStatusChange);
    emitter.on(AgentEventType.TOOL_CALL, onToolCall);
    emitter.on(AgentEventType.TOOL_RESULT, onToolResult);
    this.eventBridgeCleanups.push(() => {
      emitter.off(AgentEventType.STATUS_CHANGE, onStatusChange);
      emitter.off(AgentEventType.TOOL_CALL, onToolCall);
      emitter.off(AgentEventType.TOOL_RESULT, onToolResult);
    });

    // Forward teammate tool approval requests to the leader's UI
    // via the permission bridge.
    const member = findMemberByName(this.teamFile.members, agentName);
    const onApproval = (event: AgentApprovalRequestEvent) => {
      const color = member?.color;
      const badged = wrapConfirmWithBadge(
        event.confirmationDetails as import('../../tools/tools.js').ToolCallConfirmationDetails,
        agentName,
        color,
      );
      const forwarded = forwardApproval(agentName, color, badged);
      if (!forwarded) {
        // No leader UI registered (headless / stream-json).
        // Emit a team event so the host can route the
        // approval through its own permission channel.
        this.emitTeammateApprovalRequest(agentName, event);
      }
    };

    emitter.on(AgentEventType.TOOL_WAITING_APPROVAL, onApproval);
    this.eventBridgeCleanups.push(() => {
      emitter.off(AgentEventType.TOOL_WAITING_APPROVAL, onApproval);
    });

    // Reconcile: if agent already reached IDLE before we
    // attached, flush now.
    if (
      (agent as { getStatus(): AgentStatus }).getStatus() === AgentStatus.IDLE
    ) {
      void this.flushNextMessage(agentId, agentName);
    }
  }

  // ─── Private: Permission fallback ───────────────────────

  /**
   * Emit a team-level approval event so the CLI (or any
   * other host) can route it through its own permission
   * channel (e.g. stream-json control requests, local
   * approval mode check). If nobody handles the event the
   * tool will remain blocked until the agent's stall timeout.
   */
  private emitTeammateApprovalRequest(
    agentName: string,
    event: AgentApprovalRequestEvent,
  ): void {
    const payload: TeammateApprovalRequestEvent = {
      teammateName: agentName,
      toolName: event.name,
      toolInput: (event.confirmationDetails as Record<string, unknown>) ?? {},
      respond: event.respond,
      timestamp: Date.now(),
    };
    this.teamEventEmitter.emit(
      TeamEventType.TEAMMATE_APPROVAL_REQUEST,
      payload,
    );
  }

  // ─── Private: Message priority & flushing ───────────────

  /**
   * Flush the next highest-priority message to an agent.
   * Priority: shutdown (mailbox) > leader > peer > auto-claim.
   */
  private async flushNextMessage(
    agentId: string,
    agentName: string,
  ): Promise<void> {
    const agent = this.getAgentFromBackend(agentId);
    if (!agent) return;
    if (agent.getStatus() !== AgentStatus.IDLE) return;

    // 1. Check mailbox for shutdown requests (highest priority).
    //    Only read the mailbox if a shutdown has actually been requested.
    if (this._shutdownRequested) {
      const shutdowns = await consumeUnread(
        this.teamFile.name,
        agentName,
        'shutdown_request',
      );
      if (shutdowns.length > 0) {
        this.enqueueWithIdentity(agentId, agent, shutdowns[0]!.text);
        return;
      }
    }

    // 2. Deliver the highest-priority pending message.
    const queue = this.pendingMessages.get(agentId);
    if (queue && queue.length > 0) {
      queue.sort((a, b) => a.priority - b.priority);
      const msg = queue.shift()!;
      this.enqueueWithIdentity(agentId, agent, msg.text);
      return;
    }

    // 3. Try auto-claiming a pending task.
    await this.tryAutoClaimTask(agentId, agentName);
  }

  /**
   * Enqueue a message within the agent's teammate identity so
   * that the resulting runLoop executes inside the correct
   * AsyncLocalStorage context.
   */
  private enqueueWithIdentity(
    agentId: string,
    agent: TeamAgentHandle,
    message: string,
  ): void {
    const identity = this.agentIdentities.get(agentId);
    if (identity) {
      runWithTeammateIdentity(identity, () => agent.enqueueMessage(message));
    } else {
      agent.enqueueMessage(message);
    }
  }

  /**
   * Try to claim the next pending task for an agent.
   */
  private async tryAutoClaimTask(
    agentId: string,
    agentName: string,
  ): Promise<void> {
    const agent = this.getAgentFromBackend(agentId);
    if (!agent) return;
    if (agent.getStatus() !== AgentStatus.IDLE) return;

    const pending = await listTasks(this.teamFile.name, {
      status: 'pending',
    });
    if (pending.length === 0) return;

    // Try to claim the first unblocked, unowned task.
    for (const task of pending) {
      if (task.owner) continue;
      if (task.blockedBy.length > 0) continue;

      const claimed = await claimTask(this.teamFile.name, task.id, agentId, {
        checkAgentBusy: true,
        ownerName: agentName,
      });
      if (claimed) {
        this.teamEventEmitter.emit(TeamEventType.TASK_AUTO_CLAIMED, {
          agentId,
          name: agentName,
          taskId: claimed.id,
          taskSubject: claimed.subject,
          timestamp: Date.now(),
        });

        const taskPrompt =
          `You have been assigned task #${claimed.id}: ` +
          `${claimed.subject}\n\n${claimed.description}`;
        this.enqueueWithIdentity(agentId, agent, taskPrompt);
        return;
      }
    }
  }

  /**
   * Scan all idle agents and try to auto-claim tasks.
   * Called when task list changes. Shares a single listTasks
   * call and runs claims concurrently.
   */
  private async scanIdleAgentsForTasks(): Promise<void> {
    // Pre-fetch pending tasks once instead of per-agent.
    const pending = await listTasks(this.teamFile.name, {
      status: 'pending',
    });
    if (pending.length === 0) return;

    const idleMembers = this.teamFile.members.filter((member) => {
      const agent = this.getAgentFromBackend(member.agentId);
      if (!agent) return false;
      if (agent.getStatus() !== AgentStatus.IDLE) return false;
      const queue = this.pendingMessages.get(member.agentId) ?? [];
      return queue.length === 0;
    });

    await Promise.all(
      idleMembers.map((member) =>
        this.tryAutoClaimTask(member.agentId, member.name),
      ),
    );
  }

  /**
   * Determine message priority from the sender name.
   */
  private getSenderPriority(from?: string): MessagePriority {
    if (!from) return MessagePriority.PEER;
    // The leader's agentId is stored in teamFile.leadAgentId.
    // Accept both the full agentId and the bare name "leader".
    if (from === this.teamFile.leadAgentId || from.toLowerCase() === 'leader') {
      return MessagePriority.LEADER;
    }
    return MessagePriority.PEER;
  }
}
