/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read and write surface behind the Web Shell agents-and-threads pages.
 *
 * Three properties this layer is responsible for, none of which the client
 * can hold on its own:
 *
 * 1. **The thread's state is decided here.** `resolveThreadStatus` returns the
 *    status *and* the sentence explaining it, and both travel to the client
 *    together. A browser that derived its own status word would give the
 *    product two answers to "why is this blocked", and the one on screen would
 *    win.
 * 2. **Routing is previewed with the real rules.** The composer shows who a
 *    draft will wake before it is sent. That preview runs `parseMentions` and
 *    `decideDispatch` — the same pure functions admission uses — so it is the
 *    true outcome rather than a second implementation that can drift.
 * 3. **Human identity comes from the authenticated surface**, never from the
 *    request body. A post from this route is authored by the person operating
 *    the shell; there is no field they can set to claim otherwise.
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import {
  assignThread,
  createAssignedThread,
  createThread,
  THREAD_PRIORITY_ORDER,
  DEFAULT_THREAD_PRIORITY,
  LOCAL_AGENT_RUNTIME_ID,
  type ThreadPriority,
  decideDispatch,
  finishRunInTransaction,
  generateAgentId,
  generateEventId,
  isValidAgentName,
  listThreads,
  parseMentions,
  postMessage,
  issueAgentHostEnrollment,
  readAgentHosts,
  readWorkspaceAgents,
  readAgentWorkspace,
  readThread,
  releaseAgentHostSession,
  retireWorkspaceAgent,
  isAgentAddressable,
  maxConcurrentRunsFor,
  THREAD_TOOL_NAMES,
  AGENT_TOOL_CLASSIFICATION,
  resolveThreadStatus,
  setWorkspaceAgentEnabled,
  updateWorkspaceAgents,
  withAgentStoreTransaction,
  resolveTargets,
  hasLiveDescendant,
  HUMAN_AUTHOR_ID,
  DEFAULT_THREAD_AUTO_TURN_BUDGET,
  DEFAULT_THREAD_TOKEN_BUDGET,
  type WorkspaceAgent,
  type Thread,
  type ThreadRun,
  deliverNotifications,
  isThreadTerminal,
} from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { AGENT_SESSION_SOURCE_TYPE } from '../../runtime/agent-session-source.js';
import { startAgentHostSessionOwner } from '../workspace-agents/agent-host-session.js';
import type { ChannelDeliveryRequest } from '../../runtime/channel-delivery-ipc.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

export interface RegisterWorkspaceAgentRoutesDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  /**
   * Sends one channel message. Absent when no channel worker is running, in
   * which case notifications stay pending rather than being dropped.
   */
  deliverChannelMessage?: (
    workspaceCwd: string,
    request: ChannelDeliveryRequest,
  ) => Promise<unknown>;
}

const LIVE_RUN_STATUSES = new Set([
  'queued',
  'running',
  'finishing',
  'cancelling',
]);
const ACTIVE_RUN_STATUSES = new Set(['running', 'finishing', 'cancelling']);
const AGENT_HOST_ONLINE_WINDOW_MS = 15_000;

function liveRunCount(thread: Thread): number {
  return thread.runs.filter((run) => LIVE_RUN_STATUSES.has(run.status)).length;
}

function lastActivity(thread: Thread): number {
  const lastPost = thread.messages.at(-1)?.at ?? thread.createdAt;
  const lastRun = thread.runs.reduce(
    (latest, run) => Math.max(latest, run.endedAt ?? run.startedAt ?? 0),
    0,
  );
  return Math.max(lastPost, lastRun);
}

/**
 * Reads the editable half of an agent from a PATCH body.
 *
 * Three states per field, and they are not the same thing. Absent leaves the
 * value alone, so editing one field cannot blank the others. `null` clears the
 * override and returns the agent to what its definition says. A value sets it.
 * Anything else is rejected rather than coerced, because a colour that is not
 * a colour or a concurrency that is not a number would be written to the
 * roster and read back by the dispatcher.
 */
function readAgentConfigPatch(payload: {
  description?: unknown;
  color?: unknown;
  model?: unknown;
  instructions?: unknown;
  agentType?: unknown;
  maxConcurrentRuns?: unknown;
}):
  | { error: string; touched?: undefined; apply?: undefined }
  | {
      error?: undefined;
      touched: boolean;
      apply: (agent: WorkspaceAgent) => WorkspaceAgent;
    } {
  const steps: Array<(agent: WorkspaceAgent) => WorkspaceAgent> = [];

  const text = (
    key: 'description' | 'color' | 'model' | 'instructions' | 'agentType',
    check?: (value: string) => boolean,
  ): string | undefined => {
    const raw = payload[key];
    if (raw === undefined) return undefined;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      steps.push((agent) => {
        const { [key]: _dropped, ...rest } = agent;
        return rest as WorkspaceAgent;
      });
      return undefined;
    }
    if (typeof raw !== 'string') return `${key}_invalid`;
    const value = raw.trim();
    if (check && !check(value)) return `${key}_invalid`;
    steps.push((agent) => ({ ...agent, [key]: value }));
    return undefined;
  };

  for (const error of [
    text('description'),
    text('color', (value) => /^#[0-9a-fA-F]{6}$/.test(value)),
    text('model'),
    text('instructions'),
    text('agentType'),
  ]) {
    if (error) return { error };
  }

  const runs = payload.maxConcurrentRuns;
  if (runs !== undefined) {
    if (runs === null) {
      steps.push((agent) => {
        const { maxConcurrentRuns: _dropped, ...rest } = agent;
        return rest as WorkspaceAgent;
      });
    } else if (
      typeof runs !== 'number' ||
      !Number.isInteger(runs) ||
      runs < 1 ||
      runs > MAX_CONCURRENT_RUNS_CEILING
    ) {
      return { error: 'maxConcurrentRuns_invalid' };
    } else {
      steps.push((agent) => ({ ...agent, maxConcurrentRuns: runs }));
    }
  }

  return {
    touched: steps.length > 0,
    apply: (agent) => steps.reduce((current, step) => step(current), agent),
  };
}

/**
 * The most threads one agent may be set to work at once.
 *
 * A ceiling on the setting, not on the machine: every concurrent run is a
 * prompt in flight against the same session, and a number typed with an extra
 * digit would book work nobody can read the results of.
 */
const MAX_CONCURRENT_RUNS_CEILING = 8;

/**
 * The tools an agent may actually call, derived from the same table the guard
 * refuses from. Derived rather than listed so the two cannot drift: a tool
 * reclassified in core changes what this reports on the next build.
 */
const AGENT_ALLOWED_TOOL_NAMES = Object.entries(AGENT_TOOL_CLASSIFICATION)
  .filter(([, classification]) => classification === 'allow')
  .map(([name]) => name)
  .sort();

/** Why a run exists, in the words a reader asks the question in. */
function triggerText(thread: Thread, run: ThreadRun): string {
  const first = thread.messages.find((message) =>
    run.triggerMessageIds.includes(message.id),
  );
  if (!first) return 'started by the dispatcher';
  if (first.triggerKind === 'assignment') return 'assigned to this thread';
  if (first.triggerKind === 'child_report') return 'a sub-thread reported back';
  if (first.authorKind === 'human') {
    return first.mentions.length > 0 ? 'mentioned by you' : 'assigned by you';
  }
  return `mentioned by ${first.authorNameSnapshot}`;
}

function agentName(agents: readonly WorkspaceAgent[], agentId: string): string {
  return agents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

function runView(
  thread: Thread,
  run: ThreadRun,
  agents: readonly WorkspaceAgent[],
) {
  const agent = agents.find((candidate) => candidate.id === run.agentId);
  return {
    id: run.id,
    agentId: run.agentId,
    agentName: agent?.name ?? run.agentId,
    ...(agent?.color ? { agentColor: agent.color } : {}),
    status: run.status,
    ...(run.closeKind ? { closeKind: run.closeKind } : {}),
    closeAcknowledged: run.closeAcknowledgedAtSequence !== undefined,
    ...(run.failureStage ? { failureStage: run.failureStage } : {}),
    ...(run.error ? { error: run.error } : {}),
    trigger: triggerText(thread, run),
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    // The task-scoped session this run's turn was taken in.
    ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
  };
}

/**
 * Resolves a thread's status here rather than trusting the stored value.
 *
 * The stored status is written by whichever path last touched the thread; the
 * resolver is the definition. Recomputing on read means a thread whose child
 * finished while the daemon was down still reads correctly the first time
 * someone opens it.
 */
function resolve(thread: Thread, threads: readonly Thread[]) {
  return resolveThreadStatus({
    thread,
    hasLiveChildDependency: hasLiveDescendant(threads, thread.id),
  });
}

export function registerWorkspaceAgentRoutes(
  app: Application,
  deps: RegisterWorkspaceAgentRoutesDeps,
): void {
  // /agents/:agentType already belongs to reusable agent definitions.
  const prefix = '/workspaces/:workspace/agent';
  const owners = new Map<
    string,
    {
      bridge: WorkspaceRuntime['bridge'];
      generationGuard: WorkspaceRuntime['generationGuard'];
      owner: ReturnType<typeof startAgentHostSessionOwner>;
    }
  >();

  const runtimeFor = (
    req: Request,
    res: Response,
  ): WorkspaceRuntime | undefined => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
    return runtime;
  };

  const dispatch = async (runtime: WorkspaceRuntime): Promise<void> => {
    runtime.generationGuard?.assertOpen();
    let current = owners.get(runtime.workspaceCwd);
    if (
      !current ||
      current.bridge !== runtime.bridge ||
      current.generationGuard !== runtime.generationGuard
    ) {
      current?.owner.stop();
      const owner = startAgentHostSessionOwner({
        bridge: runtime.bridge,
        workspaceCwd: runtime.workspaceCwd,
        ...(runtime.generationGuard
          ? { generationGuard: runtime.generationGuard }
          : {}),
      });
      current = {
        bridge: runtime.bridge,
        generationGuard: runtime.generationGuard,
        owner,
      };
      owners.set(runtime.workspaceCwd, current);
    }
    await current.owner.dispatch();
  };

  /**
   * A writer killed while holding the workspace lock wedges writes until the
   * lock goes stale — measured at about ten seconds, since the retry window is
   * well under a second and the staleness window is ten. Nothing is lost and
   * it clears itself, so this is a wait, not a fault: it answers 503 with a
   * Retry-After a caller can act on rather than a 500 quoting a lock file at
   * someone who never asked about one.
   */
  const fail = (res: Response, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/lock file is already being held/i.test(message)) {
      res
        .set('Retry-After', '11')
        .status(503)
        .json({ error: 'workspace_busy' });
      return;
    }
    res.status(500).json({ error: message });
  };

  /**
   * Sends whatever the last dispatch queued.
   *
   * Runs after dispatch rather than inside it because the channel worker lives
   * in this process while the dispatch loop runs in the host session. A send
   * that fails leaves its event pending with its attempt counted, so the next
   * mutation retries it; the thread state it announces is durable either way.
   */
  const flushNotifications = async (
    runtime: WorkspaceRuntime,
  ): Promise<void> => {
    if (!deps.deliverChannelMessage) return;
    const send = deps.deliverChannelMessage;
    try {
      await deliverNotifications(runtime.workspaceCwd, async (input) => {
        await send(runtime.workspaceCwd, {
          deliveryId: input.deliveryId,
          channelName: input.target.channelName,
          target: input.target.target,
          text: input.text,
        });
      });
    } catch {
      // The events stay pending and the next mutation retries them. A
      // notification failure must not fail the request that produced it: the
      // work itself already landed.
    }
  };

  const startBookedRuns = async (
    runtime: WorkspaceRuntime,
  ): Promise<string | undefined> => {
    try {
      await dispatch(runtime);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      await flushNotifications(runtime);
    }
    // Explicit: a dispatch that threw returns its message above, and one that
    // did not has no error to report. Falling off the end would say the same
    // thing while `noImplicitReturns` refuses it.
    return undefined;
  };

  let recovering = false;
  let recoveryStopped = false;
  const recover = async (): Promise<void> => {
    if (recovering || recoveryStopped) return;
    recovering = true;
    try {
      for (const runtime of deps.workspaceRegistry.list()) {
        if (recoveryStopped) return;
        if (!runtime.trusted || runtime.generationGuard?.closed) continue;
        try {
          const [agents, { threads }] = await Promise.all([
            readWorkspaceAgents(runtime.workspaceCwd),
            listThreads(runtime.workspaceCwd),
          ]);
          const hasRoster = agents.some(
            (agent) => agent.retiredAt === undefined,
          );
          const hasWork = threads.some(
            (thread) =>
              thread.runs.some((run) => LIVE_RUN_STATUSES.has(run.status)) ||
              thread.outbox.some((event) => event.status === 'pending'),
          );
          if (!hasRoster && !hasWork) continue;
          const owner = owners.get(runtime.workspaceCwd);
          if (
            !hasWork &&
            owner?.bridge === runtime.bridge &&
            owner.generationGuard === runtime.generationGuard
          ) {
            continue;
          }
          if (recoveryStopped) return;
          const error = await startBookedRuns(runtime);
          if (error)
            writeStderrLine(
              `qwen serve: workspace agent recovery failed: ${error}`,
            );
        } catch (error) {
          writeStderrLine(
            `qwen serve: workspace agent recovery failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      recovering = false;
    }
  };
  // Runtimes may become ready after routes are registered, or after replacement.
  const recoveryTimer = setInterval(() => void recover(), 5_000);
  recoveryTimer.unref?.();
  void recover();
  app.locals['stopWorkspaceAgentRecovery'] = () => {
    recoveryStopped = true;
    clearInterval(recoveryTimer);
    for (const { owner } of owners.values()) owner.stop();
  };

  app.get(`${prefix}/agents`, async (req: Request, res: Response) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    const root = runtime.workspaceCwd;
    try {
      const [agents, { threads }, workspace, hosts] = await Promise.all([
        readWorkspaceAgents(root),
        listThreads(root),
        readAgentWorkspace(root),
        readAgentHosts(root),
      ]);
      const sessions = runtime.bridge.listWorkspaceSessions(root);
      const agentSessions = sessions.filter(
        (candidate) => candidate.sourceType === AGENT_SESSION_SOURCE_TYPE,
      );
      const lastSeenAt = workspace.hostSessionId
        ? runtime.bridge.getHeartbeatState(workspace.hostSessionId)
            ?.sessionLastSeenAt
        : undefined;
      const localRuntime = {
        id: LOCAL_AGENT_RUNTIME_ID,
        kind: 'local' as const,
        label: 'Local daemon',
        provider: 'Qwen Code ACP',
        status: 'online' as const,
        workspaceId: runtime.workspaceId,
        workspaceCwd: root,
        ...(workspace.hostSessionId
          ? { hostSessionId: workspace.hostSessionId }
          : {}),
        ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
        agentCount: agents.filter((agent) => agent.retiredAt === undefined)
          .length,
        sessionCount: agentSessions.length,
        runningTaskCount: threads.filter((thread) =>
          thread.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)),
        ).length,
        queuedTaskCount: threads.reduce(
          (count, thread) =>
            count + thread.runs.filter((run) => run.status === 'queued').length,
          0,
        ),
      };
      const now = Date.now();
      const hostRuntimes = hosts.map((host) => ({
        id: host.id,
        kind: 'external' as const,
        label: host.name,
        provider: host.providers.join(', '),
        status:
          host.lastSeenAt !== undefined &&
          now - host.lastSeenAt <= AGENT_HOST_ONLINE_WINDOW_MS
            ? ('online' as const)
            : ('offline' as const),
        workspaceId: runtime.workspaceId,
        workspaceCwd: host.workspaceCwd,
        ...(host.lastSeenAt !== undefined
          ? { lastSeenAt: host.lastSeenAt }
          : {}),
        agentCount: 0,
        sessionCount: 0,
        runningTaskCount: 0,
        queuedTaskCount: 0,
      }));
      res.json({
        agents: agents.map((agent) => {
          const active = threads.find((thread) =>
            thread.runs.some(
              (run) =>
                run.agentId === agent.id && ACTIVE_RUN_STATUSES.has(run.status),
            ),
          );
          const activeRun = active?.runs.find(
            (run) =>
              run.agentId === agent.id && ACTIVE_RUN_STATUSES.has(run.status),
          );
          const waiting = threads.reduce(
            (count, thread) =>
              count +
              thread.runs.filter(
                (run) => run.agentId === agent.id && run.status === 'queued',
              ).length,
            0,
          );
          const sessionsForAgent = agentSessions.filter(
            (candidate) => candidate.sourceId === agent.id,
          );
          const runtimeId = agent.runtimeId ?? LOCAL_AGENT_RUNTIME_ID;
          const runtimeAvailable = runtimeId === LOCAL_AGENT_RUNTIME_ID;
          const blocked = threads.some(
            (thread) =>
              resolve(thread, threads).status === 'blocked' &&
              thread.runs.some(
                (run) =>
                  run.agentId === agent.id &&
                  run.closeKind === 'blocked' &&
                  run.closeAcknowledgedAtSequence === undefined,
              ),
          );
          const failed = threads.some((thread) =>
            thread.runs.some(
              (run) =>
                run.agentId === agent.id &&
                run.status === 'failed' &&
                run.closeAcknowledgedAtSequence === undefined,
            ),
          );
          const status =
            agent.retiredAt !== undefined ||
            agent.enabled === false ||
            !runtimeAvailable
              ? 'offline'
              : active ||
                  sessionsForAgent.some((entry) => entry.hasActivePrompt)
                ? 'working'
                : blocked
                  ? 'blocked'
                  : failed ||
                      sessionsForAgent.some((entry) => entry.hasTurnError)
                    ? 'error'
                    : 'idle';
          return {
            id: agent.id,
            name: agent.name,
            ...(agent.description ? { description: agent.description } : {}),
            ...(agent.color ? { color: agent.color } : {}),
            ...(agent.agentType ? { agentType: agent.agentType } : {}),
            ...(agent.model ? { model: agent.model } : {}),
            ...(agent.instructions ? { instructions: agent.instructions } : {}),
            maxConcurrentRuns: maxConcurrentRunsFor(agent),
            enabled: agent.enabled !== false,
            status,
            runtime: runtimeAvailable
              ? localRuntime
              : {
                  id: runtimeId,
                  kind: 'external' as const,
                  label: runtimeId,
                  provider: 'Unregistered',
                  status: 'offline' as const,
                },
            // A retired agent is listed, not hidden. Its posts are still on
            // the threads, and a reader who meets its name needs somewhere to
            // look it up. `enabled` stays a separate answer: a retired agent
            // is not merely paused, and the two are not interchangeable.
            ...(agent.retiredAt !== undefined
              ? { retiredAt: agent.retiredAt }
              : {}),
            ...(active && activeRun
              ? {
                  workingOn: {
                    id: active.id,
                    title: active.title,
                    state:
                      activeRun.status === 'cancelling'
                        ? 'stopping'
                        : activeRun.status === 'finishing'
                          ? 'finishing'
                          : 'working',
                  },
                }
              : {}),
            waiting,
          };
        }),
        runtime: localRuntime,
        runtimes: [localRuntime, ...hostRuntimes],
        // What every agent may do, sent once rather than per agent because it
        // is a property of the subsystem and not of an identity. Shown so the
        // boundary is something a person can read before trusting an agent
        // with work, instead of something they discover from a refusal.
        capabilities: {
          readOnly: true,
          allowed: AGENT_ALLOWED_TOOL_NAMES,
          threadTools: [...THREAD_TOOL_NAMES],
        },
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post(
    `${prefix}/hosts/enrollment`,
    deps.mutate(),
    async (req: Request, res: Response) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      try {
        res.status(201).json({
          ...(await issueAgentHostEnrollment(runtime.workspaceCwd)),
          workspaceId: runtime.workspaceId,
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.get(`${prefix}/threads`, async (req: Request, res: Response) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    const root = runtime.workspaceCwd;
    try {
      const [{ threads, unreadable }, agents] = await Promise.all([
        listThreads(root),
        readWorkspaceAgents(root),
      ]);
      res.json({
        threads: threads.map((thread) => {
          const resolution = resolve(thread, threads);
          return {
            id: thread.id,
            title: thread.title,
            status: resolution.status,
            reason: resolution.reason,
            updatedAt: lastActivity(thread),
            liveRunCount: liveRunCount(thread),
            ...(thread.assigneeAgentId
              ? { assigneeName: agentName(agents, thread.assigneeAgentId) }
              : {}),
            ...(thread.parentThreadId
              ? { parentThreadId: thread.parentThreadId }
              : {}),
          };
        }),
        // A thread whose file cannot be read is reported, not omitted: an
        // empty page and a page whose reads all failed look identical
        // otherwise.
        unreadable,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${prefix}/threads/:id`, async (req: Request, res: Response) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    const root = runtime.workspaceCwd;
    try {
      const [thread, agents, { threads }] = await Promise.all([
        readThread(root, String(req.params['id'])),
        readWorkspaceAgents(root),
        listThreads(root),
      ]);
      if (!thread) {
        res.status(404).json({ error: 'thread_not_found' });
        return;
      }
      const resolution = resolve(thread, threads);
      const parent = thread.parentThreadId
        ? threads.find((candidate) => candidate.id === thread.parentThreadId)
        : undefined;
      const treeTokens = threads
        .filter((candidate) => candidate.rootThreadId === thread.rootThreadId)
        .reduce(
          (total, candidate) =>
            total +
            candidate.runs.reduce(
              (runTotal, run) =>
                runTotal +
                run.usageByRound.reduce((sum, usage) => sum + usage.tokens, 0),
              0,
            ),
          0,
        );
      res.json({
        id: thread.id,
        title: thread.title,
        body: thread.body,
        ...(thread.acceptanceCriteria
          ? { acceptanceCriteria: thread.acceptanceCriteria }
          : {}),
        priority: thread.priority ?? DEFAULT_THREAD_PRIORITY,
        ...(thread.parentThreadId
          ? {
              parent: {
                id: thread.parentThreadId,
                title: parent?.title ?? 'Parent task',
              },
            }
          : {}),
        ...(thread.assigneeAgentId
          ? { assigneeName: agentName(agents, thread.assigneeAgentId) }
          : {}),
        status: resolution.status,
        reason: resolution.reason,
        posts: thread.messages.map((message) => ({
          id: message.id,
          sequence: message.sequence,
          authorKind: message.authorKind,
          authorName: message.authorNameSnapshot,
          authorDeleted:
            message.authorKind === 'agent' &&
            !agents.some((agent) => agent.id === message.from),
          text: message.text,
          at: message.at,
          outcomes: message.outcomes.map((outcome) => ({
            ...outcome,
            agentName:
              outcome.targetAgentName ??
              (outcome.targetAgentId
                ? agentName(agents, outcome.targetAgentId)
                : undefined),
          })),
        })),
        runs: thread.runs.map((run) => runView(thread, run, agents)),
        children: threads
          .filter((candidate) => candidate.parentThreadId === thread.id)
          .map((candidate) => {
            const childResolution = resolve(candidate, threads);
            return {
              id: candidate.id,
              title: candidate.title,
              status: childResolution.status,
              reason: childResolution.reason,
            };
          }),
        budget: {
          turnsUsed: thread.autoTurnsUsed,
          turnLimit: DEFAULT_THREAD_AUTO_TURN_BUDGET,
          tokensUsed: treeTokens,
          tokenLimit: DEFAULT_THREAD_TOKEN_BUDGET,
        },
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post(`${prefix}/threads/preview`, async (req, res) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    try {
      const assigneeName = String(
        (req.body as { assignee?: unknown } | undefined)?.assignee ?? '',
      )
        .replace(/^@/, '')
        .trim();
      if (!assigneeName) {
        res.json({
          targets: [
            {
              agentName: 'nobody',
              willWake: false,
              reason: 'no_target',
              unknown: false,
            },
          ],
        });
        return;
      }
      const [agents, { threads }] = await Promise.all([
        readWorkspaceAgents(runtime.workspaceCwd),
        listThreads(runtime.workspaceCwd),
      ]);
      const target = agents.find(
        (agent) => agent.name.toLowerCase() === assigneeName.toLowerCase(),
      );
      const now = Date.now();
      const thread: Thread = {
        schemaVersion: 1,
        id: 'preview',
        title: 'preview',
        body: '',
        status: 'open',
        ...(target ? { assigneeAgentId: target.id } : {}),
        createdAt: now,
        createdBy: HUMAN_AUTHOR_ID,
        rootThreadId: 'preview',
        messages: [],
        runs: [],
        nextMessageSequence: 1,
        deliveryByAgent: {},
        outbox: [],
        autoTurnsUsed: 0,
        tokensUsed: 0,
      };
      const decision = decideDispatch({
        thread,
        message: {
          id: 'preview',
          sequence: 1,
          authorKind: 'human',
          from: HUMAN_AUTHOR_ID,
          authorNameSnapshot: HUMAN_AUTHOR_ID,
          triggerKind: 'assignment',
          text: `Assigned to @${assigneeName}.`,
          mentions: target ? [target.id] : [],
          outcomes: [],
          at: now,
        },
        target,
        budget: { autoTurnsUsed: 0, tokensUsed: 0 },
        agentQueuedElsewhere: target
          ? threads.reduce(
              (count, candidate) =>
                count +
                candidate.runs.filter(
                  (run) => run.agentId === target.id && run.status === 'queued',
                ).length,
              0,
            )
          : 0,
      });
      res.json({
        targets: [
          {
            agentName: target?.name ?? assigneeName,
            willWake: decision.kind !== 'skip',
            kind: decision.kind,
            ...(decision.kind === 'coalesce' ? { into: decision.into } : {}),
            ...(decision.kind === 'skip' ? { reason: decision.reason } : {}),
            unknown: !target,
          },
        ],
      });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * What a draft reply would do, without doing it.
   *
   * Runs the admission rules against the draft so the composer can show the
   * true outcome. Nothing is written and no budget is spent: a preview that
   * charged a turn would make looking at the consequences cost the same as
   * accepting them.
   */
  app.post(`${prefix}/threads/:id/preview`, async (req, res) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    const root = runtime.workspaceCwd;
    try {
      const thread = await readThread(root, String(req.params['id']));
      if (!thread) {
        res.status(404).json({ error: 'thread_not_found' });
        return;
      }
      const text = String(
        (req.body as { text?: unknown } | undefined)?.text ?? '',
      );
      const agents = await readWorkspaceAgents(root);
      const { threads } = await listThreads(root);
      const parsed = parseMentions(text, agents);
      const hasExplicitMention =
        parsed.ids.length > 0 || parsed.unknown.length > 0;
      const draft = {
        id: 'preview',
        sequence: thread.nextMessageSequence,
        authorKind: 'human' as const,
        from: HUMAN_AUTHOR_ID,
        authorNameSnapshot: HUMAN_AUTHOR_ID,
        text,
        mentions: parsed.ids,
        outcomes: [],
        at: Date.now(),
      };
      const treeTokens = threads
        .filter((candidate) => candidate.rootThreadId === thread.rootThreadId)
        .reduce(
          (total, candidate) =>
            total +
            candidate.runs.reduce(
              (runTotal, run) =>
                runTotal +
                run.usageByRound.reduce((sum, usage) => sum + usage.tokens, 0),
              0,
            ),
          0,
        );
      const targets = [
        // An unknown mention is a target with a fate, not a silent omission.
        ...parsed.unknown.map((name) => ({
          agentName: name,
          willWake: false,
          reason: 'agent_unknown',
          unknown: true,
        })),
        ...resolveTargets(thread, draft, hasExplicitMention).map((agentId) => {
          const target = agents.find((candidate) => candidate.id === agentId);
          const queuedElsewhere = threads.reduce(
            (count, candidate) =>
              candidate.id === thread.id
                ? count
                : count +
                  candidate.runs.filter(
                    (run) => run.agentId === agentId && run.status === 'queued',
                  ).length,
            0,
          );
          const decision = decideDispatch({
            thread,
            message: draft,
            target,
            // A human post resets this thread's turn count, so the preview
            // must gate on 0 rather than on what agents have spent.
            budget: { autoTurnsUsed: 0, tokensUsed: treeTokens },
            agentQueuedElsewhere: queuedElsewhere,
          });
          return {
            agentName: target?.name ?? agentId,
            willWake: decision.kind !== 'skip',
            kind: decision.kind,
            ...(decision.kind === 'coalesce' ? { into: decision.into } : {}),
            ...(decision.kind === 'skip' ? { reason: decision.reason } : {}),
          };
        }),
      ];
      if (targets.length === 0) {
        targets.push({
          agentName: 'nobody',
          willWake: false,
          reason: 'no_target',
          unknown: false,
        });
      }
      res.json({ targets });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Creates a thread, and starts it when it names an assignee.
   *
   * Assignment is a structured first post through ordinary admission, so it
   * cannot bypass budgets or the queue limit.
   */
  app.post(
    `${prefix}/threads`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const root = runtime.workspaceCwd;
      try {
        const payload = (req.body ?? {}) as {
          title?: unknown;
          body?: unknown;
          acceptanceCriteria?: unknown;
          priority?: unknown;
          assignee?: unknown;
        };
        const title = String(payload.title ?? '').trim();
        if (!title) {
          res.status(400).json({ error: 'title_required' });
          return;
        }
        const agents = await readWorkspaceAgents(root);
        const assigneeName =
          typeof payload.assignee === 'string'
            ? payload.assignee.replace(/^@/, '')
            : '';
        const assignee = assigneeName
          ? agents.find(
              (agent) =>
                agent.name.toLowerCase() === assigneeName.toLowerCase(),
            )
          : undefined;
        if (assigneeName && !assignee) {
          res.status(400).json({ error: 'assignee_unknown' });
          return;
        }
        const body =
          typeof payload.body === 'string' ? payload.body : undefined;
        const acceptanceCriteria =
          typeof payload.acceptanceCriteria === 'string'
            ? payload.acceptanceCriteria
            : undefined;
        // An unrecognised priority is rejected rather than coerced: silently
        // reading "critical" as normal would file work at an order nobody
        // chose, and the caller would never learn its word meant nothing.
        const priority = payload.priority;
        if (
          priority !== undefined &&
          !THREAD_PRIORITY_ORDER.includes(priority as ThreadPriority)
        ) {
          res.status(400).json({ error: 'priority_unknown' });
          return;
        }
        const extra = {
          ...(body !== undefined ? { body } : {}),
          ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
          ...(priority !== undefined
            ? { priority: priority as ThreadPriority }
            : {}),
        };
        const created = assignee
          ? await createAssignedThread(root, {
              title,
              ...extra,
              assignee,
            })
          : {
              thread: await createThread(root, {
                title,
                ...extra,
              }),
            };
        const thread = created.thread;
        const booked =
          'assignment' in created
            ? created.assignment.outcomes.filter(
                (outcome) => outcome.decision.kind !== 'skip',
              ).length
            : 0;
        const dispatchError =
          booked > 0 ? await startBookedRuns(runtime) : undefined;
        res.json({
          id: thread.id,
          booked,
          ...(dispatchError ? { dispatchError } : {}),
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.patch(
    `${prefix}/threads/:id`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const rawAssignee = (req.body as { assignee?: unknown } | undefined)
        ?.assignee;
      if (rawAssignee !== null && typeof rawAssignee !== 'string') {
        res.status(400).json({ error: 'assignee_invalid' });
        return;
      }
      const assigneeName =
        typeof rawAssignee === 'string'
          ? rawAssignee.replace(/^@/, '').trim()
          : undefined;
      try {
        const result = await assignThread(
          runtime.workspaceCwd,
          String(req.params['id']),
          assigneeName,
        );
        // Narrowed by excluding the success kind rather than by ruling out
        // each failure in turn: the failures share one variant whose `kind` is
        // a union of literals, and TypeScript does not drop such a variant
        // even once every literal has been excluded. Same statuses, same
        // bodies; only the shape of the check changed.
        if (result.kind !== 'updated') {
          const [status, error] =
            result.kind === 'thread_not_found'
              ? ([404, 'thread_not_found'] as const)
              : result.kind === 'thread_done'
                ? ([409, 'thread_done'] as const)
                : result.kind === 'agent_unknown'
                  ? ([400, 'assignee_unknown'] as const)
                  : result.kind === 'agent_retired'
                    ? ([409, 'assignee_retired'] as const)
                    : ([409, 'assignee_disabled'] as const);
          res.status(status).json({ error });
          return;
        }
        const booked =
          result.assignment?.outcomes.filter(
            (outcome) => outcome.decision.kind !== 'skip',
          ).length ?? 0;
        const dispatchError =
          booked > 0 ? await startBookedRuns(runtime) : undefined;
        res.json({
          id: result.thread.id,
          assignee: assigneeName ?? null,
          booked,
          ...(dispatchError ? { dispatchError } : {}),
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.post(
    `${prefix}/agents`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const root = runtime.workspaceCwd;
      try {
        const payload = (req.body ?? {}) as {
          name?: unknown;
          description?: unknown;
          agentType?: unknown;
          color?: unknown;
          model?: unknown;
          instructions?: unknown;
          maxConcurrentRuns?: unknown;
        };
        const name = String(payload.name ?? '').trim();
        if (!name) {
          res.status(400).json({ error: 'name_required' });
          return;
        }
        if (!isValidAgentName(name)) {
          res.status(400).json({
            error:
              'Agent names must start with a letter or number and contain at most 48 letters, numbers, underscores, or hyphens.',
          });
          return;
        }
        const config = readAgentConfigPatch(payload);
        if (config.error) {
          res.status(400).json({ error: config.error });
          return;
        }
        // Narrowed on `apply` rather than on `error`: the success branch types
        // `error` as an optional undefined, which never discriminated the
        // union, so the guard above reads well and proves nothing to the
        // compiler. This one both proves it and survives into the callback.
        const applyConfig = config.apply;
        if (!applyConfig) {
          res.status(500).json({ error: 'config_patch_unavailable' });
          return;
        }
        let created: WorkspaceAgent | undefined;
        let duplicate = false;
        // A retired agent still holds its name. Saying so is the difference
        // between a person renaming and a person hunting for an agent that is
        // not in the list.
        let duplicateRetired = false;
        await updateWorkspaceAgents(root, (agents) => {
          const clash = agents.find(
            (agent) => agent.name.toLowerCase() === name.toLowerCase(),
          );
          if (clash) {
            duplicate = true;
            duplicateRetired = clash.retiredAt !== undefined;
            return agents;
          }
          created = applyConfig({
            id: generateAgentId(),
            name,
            runtimeId: LOCAL_AGENT_RUNTIME_ID,
            createdAt: Date.now(),
          });
          return [...agents, created];
        });
        if (duplicate) {
          res.status(409).json({
            error: duplicateRetired
              ? `A retired agent is named "${name}". Retired names stay taken so its old posts still read as its own.`
              : `An agent named "${name}" already exists.`,
          });
          return;
        }
        const dispatchError = await startBookedRuns(runtime);
        res.json({
          id: created?.id,
          ...(dispatchError ? { dispatchError } : {}),
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.delete(
    `${prefix}/agents/:id`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const agentId = String(req.params['id']);
      try {
        const result = await retireWorkspaceAgent(
          runtime.workspaceCwd,
          agentId,
        );
        if (result === 'not_found') {
          res.status(404).json({ error: 'agent_not_found' });
          return;
        }
        if (result === 'has_live_work') {
          res.status(409).json({ error: 'agent_has_live_work' });
          return;
        }
        await Promise.all(
          runtime.bridge
            .listWorkspaceSessions(runtime.workspaceCwd)
            .filter(
              (session) =>
                session.sourceType === AGENT_SESSION_SOURCE_TYPE &&
                session.sourceId === agentId,
            )
            .map((session) =>
              runtime.bridge.closeSession(session.sessionId).catch(() => {}),
            ),
        );
        // Retiring keeps the roster entry, so "is anyone left" is a question
        // about who can still take work, not about how many rows exist.
        const remainingAgents = (
          await readWorkspaceAgents(runtime.workspaceCwd)
        ).filter(isAgentAddressable);
        const dispatchError =
          remainingAgents.length > 0
            ? await startBookedRuns(runtime)
            : undefined;
        if (remainingAgents.length === 0) {
          owners.get(runtime.workspaceCwd)?.owner.stop();
          owners.delete(runtime.workspaceCwd);
          const workspace = await readAgentWorkspace(runtime.workspaceCwd);
          if (workspace.hostSessionId) {
            await releaseAgentHostSession(
              runtime.workspaceCwd,
              workspace.hostSessionId,
            );
            await runtime.bridge
              .closeSession(workspace.hostSessionId)
              .catch(() => {});
          }
        }
        res.json({
          id: agentId,
          // The identity is gone from the roster's point of view and its posts
          // are still readable. `deleted` stays for callers that read it, and
          // says what actually happened alongside it.
          deleted: true,
          retired: true,
          ...(dispatchError ? { dispatchError } : {}),
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.patch(
    `${prefix}/agents/:id`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const payload = (req.body ?? {}) as {
        enabled?: unknown;
        description?: unknown;
        color?: unknown;
        model?: unknown;
        instructions?: unknown;
        agentType?: unknown;
        maxConcurrentRuns?: unknown;
      };
      const enabled = payload.enabled;
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled_invalid' });
        return;
      }
      // Every configurable field is optional and a missing one is left alone,
      // so a form that edits one thing cannot blank the rest. Clearing is
      // still possible, and says so: an explicit null removes the override.
      const config = readAgentConfigPatch(payload);
      if (config.error) {
        res.status(400).json({ error: config.error });
        return;
      }
      if (enabled === undefined && !config.touched) {
        res.status(400).json({ error: 'nothing_to_update' });
        return;
      }
      try {
        const agentId = String(req.params['id']);
        let missing = false;
        let retired = false;
        if (config.touched) {
          await updateWorkspaceAgents(runtime.workspaceCwd, (agents) => {
            const existing = agents.find((agent) => agent.id === agentId);
            if (!existing) {
              missing = true;
              return agents;
            }
            // A retired identity is a record, not a thing to keep tuning.
            if (existing.retiredAt !== undefined) {
              retired = true;
              return agents;
            }
            return agents.map((agent) =>
              agent.id === agentId ? config.apply(agent) : agent,
            );
          });
          if (missing) {
            res.status(404).json({ error: 'agent_not_found' });
            return;
          }
          if (retired) {
            res.status(409).json({ error: 'agent_retired' });
            return;
          }
        }
        if (enabled !== undefined) {
          const result = await setWorkspaceAgentEnabled(
            runtime.workspaceCwd,
            agentId,
            enabled,
          );
          if (result === 'not_found') {
            res.status(404).json({ error: 'agent_not_found' });
            return;
          }
          if (result === 'has_live_work') {
            res.status(409).json({ error: 'agent_has_live_work' });
            return;
          }
          if (result === 'retired') {
            res.status(409).json({ error: 'agent_retired' });
            return;
          }
        }
        const dispatchError = await startBookedRuns(runtime);
        res.json({
          id: agentId,
          ...(enabled !== undefined ? { enabled } : {}),
          updated: true,
          ...(dispatchError ? { dispatchError } : {}),
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.post(
    `${prefix}/threads/:id/runs/:runId/cancel`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const threadId = String(req.params['id']);
      const runId = String(req.params['runId']);
      try {
        const requested = await withAgentStoreTransaction(
          runtime.workspaceCwd,
          async (transaction) => {
            const thread = await transaction.readThread(threadId);
            const run = thread?.runs.find(
              (candidate) => candidate.id === runId,
            );
            if (!thread || !run) return 'run_not_found' as const;
            if (run.status === 'queued') {
              await finishRunInTransaction(transaction, {
                threadId,
                runId,
                outcome: {
                  status: 'cancelled',
                  attempt: run.attempts,
                },
              });
              return 'cancelled' as const;
            }
            if (run.status === 'cancelling') return 'cancelling' as const;
            if (run.status !== 'running' && run.status !== 'finishing') {
              return 'run_not_cancellable' as const;
            }
            await transaction.writeThread({
              ...thread,
              runs: thread.runs.map((candidate) =>
                candidate.id === runId
                  ? { ...candidate, status: 'cancelling' as const }
                  : candidate,
              ),
            });
            return 'cancelling' as const;
          },
        );
        if (requested === 'run_not_found') {
          res.status(404).json({ error: 'run_not_found' });
          return;
        }
        if (requested === 'run_not_cancellable') {
          res.status(409).json({ error: 'run_not_cancellable' });
          return;
        }
        const dispatchError = await startBookedRuns(runtime);
        const settled = await readThread(runtime.workspaceCwd, threadId);
        const status = settled?.runs.find(
          (candidate) => candidate.id === runId,
        )?.status;
        res.json({
          runId,
          cancelled: status === 'cancelling' || status === 'cancelled',
          status: status ?? requested,
          ...(dispatchError ? { dispatchError } : {}),
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  /**
   * Marks a thread done, refusing while a descendant is still open.
   *
   * v1 never cascades: closing a parent silently would end work a person never
   * looked at. The refusal names the descendants so the reader can go finish
   * them rather than guessing which one is holding this open.
   */
  app.post(
    `${prefix}/threads/:id/done`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const root = runtime.workspaceCwd;
      try {
        const threadId = String(req.params['id']);
        const result = await withAgentStoreTransaction(
          root,
          async (transaction) => {
            const { threads, unreadable } = await transaction.listThreads();
            if (unreadable.length > 0) {
              throw new Error(
                `Cannot close a thread while records are unreadable: ${unreadable.join(', ')}.`,
              );
            }
            const target = threads.find((thread) => thread.id === threadId);
            if (!target) return { kind: 'thread_not_found' as const };
            const byId = new Map(threads.map((thread) => [thread.id, thread]));
            const isDescendant = (candidate: Thread) => {
              const seen = new Set<string>();
              let parentId = candidate.parentThreadId;
              while (parentId && !seen.has(parentId)) {
                if (parentId === threadId) return true;
                seen.add(parentId);
                parentId = byId.get(parentId)?.parentThreadId;
              }
              return false;
            };
            const openDescendants = threads.filter(
              (thread) => thread.status !== 'done' && isDescendant(thread),
            );
            if (openDescendants.length > 0) {
              return {
                kind: 'descendants_not_done' as const,
                descendants: openDescendants.map((thread) => ({
                  id: thread.id,
                  title: thread.title,
                })),
              };
            }
            const now = Date.now();
            const parent = target.parentThreadId
              ? byId.get(target.parentThreadId)
              : undefined;
            const parentNeedsDoneReport =
              parent !== undefined &&
              parent.status !== 'in_review' &&
              !isThreadTerminal(parent.status);
            const updated = await transaction.writeThread({
              ...target,
              status: 'done',
              runs: target.runs.map((run) =>
                run.status === 'queued'
                  ? { ...run, status: 'cancelled' as const, endedAt: now }
                  : run.status === 'running' || run.status === 'finishing'
                    ? { ...run, status: 'cancelling' as const }
                    : run,
              ),
              outbox:
                parentNeedsDoneReport &&
                target.parentThreadId &&
                !target.outbox.some(
                  (event) => event.payload['event'] === 'child_done',
                )
                  ? [
                      ...target.outbox,
                      {
                        id: generateEventId(),
                        kind: 'parent_report' as const,
                        payload: {
                          event: 'child_done',
                          threadId: target.id,
                          parentThreadId: target.parentThreadId,
                        },
                        status: 'pending' as const,
                        attempts: 0,
                        createdAt: now,
                      },
                    ]
                  : target.outbox,
            });
            return { kind: 'updated' as const, thread: updated };
          },
        );
        if (result.kind === 'thread_not_found') {
          res.status(404).json({ error: 'thread_not_found' });
          return;
        }
        if (result.kind === 'descendants_not_done') {
          res.status(409).json({
            error: 'descendants_not_done',
            descendants: result.descendants,
          });
          return;
        }
        const dispatchError = await startBookedRuns(runtime);
        res.json({
          id: result.thread.id,
          status: result.thread.status,
          ...(dispatchError ? { dispatchError } : {}),
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.post(
    `${prefix}/threads/:id/posts`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const root = runtime.workspaceCwd;
      try {
        const text = String(
          (req.body as { text?: unknown } | undefined)?.text ?? '',
        ).trim();
        if (!text) {
          res.status(400).json({ error: 'text_required' });
          return;
        }
        // Authorship comes from the authenticated surface. There is no field a
        // caller can set to post as an agent.
        const result = await postMessage(root, String(req.params['id']), {
          from: HUMAN_AUTHOR_ID,
          text,
        });
        const dispatchError = result.outcomes.some(
          (outcome) => outcome.decision.kind !== 'skip',
        )
          ? await startBookedRuns(runtime)
          : undefined;
        res.json({
          messageId: result.message.id,
          sequence: result.message.sequence,
          outcomes: result.outcomes.map((outcome) => ({
            agentName: outcome.agentName ?? outcome.agentId,
            kind: outcome.decision.kind,
            ...(outcome.decision.kind === 'skip'
              ? { reason: outcome.decision.reason }
              : {}),
          })),
          unknownMentions: result.unknownMentions,
          ...(dispatchError ? { dispatchError } : {}),
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );
}
