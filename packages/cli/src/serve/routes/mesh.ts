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

import { open } from 'node:fs/promises';

import type {
  Application,
  Request,
  RequestHandler,
  Response,
} from 'express';
import {
  assignThread,
  createAssignedThread,
  createThread,
  decideDispatch,
  finishRun,
  generateAgentId,
  generateEventId,
  listThreads,
  parseMentions,
  postMessage,
  readMeshAgents,
  readThread,
  removeMeshAgent,
  resolveThreadStatus,
  setMeshAgentEnabled,
  updateMeshAgents,
  updateThread,
  resolveTargets,
  hasLiveDescendant,
  HUMAN_AUTHOR_ID,
  DEFAULT_THREAD_AUTO_TURN_BUDGET,
  DEFAULT_THREAD_TOKEN_BUDGET,
  Storage,
  getAgentJsonlPath,
  meshBackgroundAgentId,
  type MeshAgent,
  type Thread,
  type ThreadRun,
} from '@qwen-code/qwen-code-core';
import { startMeshHostSessionOwner } from '../mesh/mesh-host-session.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

export interface RegisterMeshRoutesDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
}

const LIVE_RUN_STATUSES = new Set([
  'queued',
  'running',
  'finishing',
  'cancelling',
]);
const ACTIVE_RUN_STATUSES = new Set(['running', 'finishing', 'cancelling']);

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

function agentName(agents: readonly MeshAgent[], agentId: string): string {
  return agents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

function runView(thread: Thread, run: ThreadRun, agents: readonly MeshAgent[]) {
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
    hasTranscriptSlice:
      run.transcriptStartOffset !== undefined &&
      run.transcriptEndOffset !== undefined &&
      run.sessionId !== undefined,
  };
}

async function readTranscriptSlice(
  path: string,
  startOffset: number,
  endOffset: number,
): Promise<string> {
  const length = endOffset - startOffset;
  const buffer = Buffer.alloc(length);
  const handle = await open(path, 'r');
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, startOffset);
    if (bytesRead !== length) {
      throw new Error(
        `Transcript ended at ${startOffset + bytesRead}; expected ${endOffset}.`,
      );
    }
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
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

export function registerMeshRoutes(
  app: Application,
  deps: RegisterMeshRoutesDeps,
): void {
  const prefix = '/workspaces/:workspace/mesh';
  const owners = new Map<
    string,
    {
      bridge: WorkspaceRuntime['bridge'];
      owner: ReturnType<typeof startMeshHostSessionOwner>;
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
    let current = owners.get(runtime.workspaceCwd);
    if (!current || current.bridge !== runtime.bridge) {
      current?.owner.stop();
      const owner = startMeshHostSessionOwner({
        bridge: runtime.bridge,
        workspaceCwd: runtime.workspaceCwd,
      });
      current = { bridge: runtime.bridge, owner };
      owners.set(runtime.workspaceCwd, current);
    }
    await current.owner.dispatch();
  };

  const fail = (res: Response, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  };

  const startBookedRuns = async (
    runtime: WorkspaceRuntime,
  ): Promise<string | undefined> => {
    try {
      await dispatch(runtime);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  for (const runtime of deps.workspaceRegistry.list()) {
    if (!runtime.trusted) continue;
    void Promise.all([
      readMeshAgents(runtime.workspaceCwd),
      listThreads(runtime.workspaceCwd),
    ])
      .then(([agents, { threads }]) => {
        if (
          agents.length > 0 ||
          threads.some(
            (thread) =>
              liveRunCount(thread) > 0 ||
              thread.outbox.some((event) => event.status === 'pending'),
          )
        ) {
          return dispatch(runtime);
        }
      })
      .catch(() => {});
  }

  app.get(`${prefix}/agents`, async (req: Request, res: Response) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    const root = runtime.workspaceCwd;
    try {
      const [agents, { threads }] = await Promise.all([
        readMeshAgents(root),
        listThreads(root),
      ]);
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
          return {
            id: agent.id,
            name: agent.name,
            ...(agent.description ? { description: agent.description } : {}),
            ...(agent.color ? { color: agent.color } : {}),
            enabled: agent.enabled !== false,
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
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${prefix}/threads`, async (req: Request, res: Response) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    const root = runtime.workspaceCwd;
    try {
      const [{ threads, unreadable }, agents] = await Promise.all([
        listThreads(root),
        readMeshAgents(root),
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
        readMeshAgents(root),
        listThreads(root),
      ]);
      if (!thread) {
        res.status(404).json({ error: 'thread_not_found' });
        return;
      }
      const resolution = resolve(thread, threads);
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

  app.get(
    `${prefix}/threads/:id/runs/:runId/transcript`,
    async (req: Request, res: Response) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      try {
        const thread = await readThread(
          runtime.workspaceCwd,
          String(req.params['id']),
        );
        const run = thread?.runs.find(
          (candidate) => candidate.id === String(req.params['runId']),
        );
        if (!thread || !run) {
          res.status(404).json({ error: 'run_not_found' });
          return;
        }
        const { sessionId, transcriptStartOffset, transcriptEndOffset } = run;
        if (
          !sessionId ||
          transcriptStartOffset === undefined ||
          transcriptEndOffset === undefined ||
          transcriptEndOffset < transcriptStartOffset
        ) {
          res.status(409).json({ error: 'transcript_slice_unavailable' });
          return;
        }
        const projectDir = new Storage(
          runtime.workspaceCwd,
          runtime.sessionRuntimeBaseDir,
        ).getProjectDir();
        const path = getAgentJsonlPath(
          projectDir,
          sessionId,
          meshBackgroundAgentId({ id: run.agentId }),
        );
        res.json({
          runId: run.id,
          agentName: agentName(
            await readMeshAgents(runtime.workspaceCwd),
            run.agentId,
          ),
          startOffset: transcriptStartOffset,
          endOffset: transcriptEndOffset,
          content: await readTranscriptSlice(
            path,
            transcriptStartOffset,
            transcriptEndOffset,
          ),
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

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
      const agents = await readMeshAgents(root);
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
          assignee?: unknown;
        };
        const title = String(payload.title ?? '').trim();
        if (!title) {
          res.status(400).json({ error: 'title_required' });
          return;
        }
        const agents = await readMeshAgents(root);
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
        const created = assignee
          ? await createAssignedThread(root, {
              title,
              ...(body !== undefined ? { body } : {}),
              assignee,
            })
          : {
              thread: await createThread(root, {
                title,
                ...(body !== undefined ? { body } : {}),
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
        if (result.kind === 'thread_not_found') {
          res.status(404).json({ error: 'thread_not_found' });
          return;
        }
        if (result.kind === 'thread_done') {
          res.status(409).json({ error: 'thread_done' });
          return;
        }
        if (result.kind === 'agent_unknown') {
          res.status(400).json({ error: 'assignee_unknown' });
          return;
        }
        if (result.kind === 'agent_disabled') {
          res.status(409).json({ error: 'assignee_disabled' });
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

  app.post(`${prefix}/agents`, deps.mutate({ strict: true }), async (req, res) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    const root = runtime.workspaceCwd;
    try {
      const payload = (req.body ?? {}) as {
        name?: unknown;
        description?: unknown;
        agentType?: unknown;
        color?: unknown;
      };
      const name = String(payload.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'name_required' });
        return;
      }
      let created: MeshAgent | undefined;
      await updateMeshAgents(root, (agents) => {
        if (
          agents.some(
            (agent) => agent.name.toLowerCase() === name.toLowerCase(),
          )
        ) {
          // Names are the mention vocabulary, so two that differ only by case
          // would make routing a coin flip.
          throw new Error(`An agent named "${name}" already exists.`);
        }
        created = {
          id: generateAgentId(),
          name,
          createdAt: Date.now(),
          ...(typeof payload.description === 'string'
            ? { description: payload.description }
            : {}),
          ...(typeof payload.agentType === 'string'
            ? { agentType: payload.agentType }
            : {}),
          ...(typeof payload.color === 'string'
            ? { color: payload.color }
            : {}),
        };
        return [...agents, created];
      });
      res.json({ id: created?.id });
    } catch (error) {
      fail(res, error);
    }
  });

  app.delete(
    `${prefix}/agents/:id`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const agentId = String(req.params['id']);
      try {
        const result = await removeMeshAgent(runtime.workspaceCwd, agentId);
        if (result === 'not_found') {
          res.status(404).json({ error: 'agent_not_found' });
          return;
        }
        if (result === 'has_live_work') {
          res.status(409).json({ error: 'agent_has_live_work' });
          return;
        }
        res.json({ id: agentId, deleted: true });
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
      const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled_required' });
        return;
      }
      try {
        const agentId = String(req.params['id']);
        const result = await setMeshAgentEnabled(
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
        const dispatchError = enabled
          ? await startBookedRuns(runtime)
          : undefined;
        res.json({
          id: agentId,
          enabled,
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
        const thread = await readThread(runtime.workspaceCwd, threadId);
        const run = thread?.runs.find((candidate) => candidate.id === runId);
        if (!thread || !run) {
          res.status(404).json({ error: 'run_not_found' });
          return;
        }
        if (run.status === 'queued') {
          await finishRun(runtime.workspaceCwd, threadId, runId, {
            status: 'cancelled',
            attempt: run.attempts,
          });
          const dispatchError = await startBookedRuns(runtime);
          res.json({
            runId,
            cancelled: true,
            status: 'cancelled',
            ...(dispatchError ? { dispatchError } : {}),
          });
          return;
        }
        if (run.status === 'cancelling') {
          const dispatchError = await startBookedRuns(runtime);
          res.json({
            runId,
            cancelled: true,
            status: 'cancelling',
            ...(dispatchError ? { dispatchError } : {}),
          });
          return;
        }
        if (run.status !== 'running' && run.status !== 'finishing') {
          res.status(409).json({ error: 'run_not_cancellable' });
          return;
        }
        await updateThread(runtime.workspaceCwd, threadId, (current) => ({
          ...current,
          runs: current.runs.map((candidate) =>
            candidate.id === runId &&
            (candidate.status === 'running' ||
              candidate.status === 'finishing')
              ? { ...candidate, status: 'cancelling' as const }
              : candidate,
          ),
        }));
        const dispatchError = await startBookedRuns(runtime);
        const settled = await readThread(runtime.workspaceCwd, threadId);
        const status = settled?.runs.find(
          (candidate) => candidate.id === runId,
        )?.status;
        res.json({
          runId,
          cancelled: status === 'cancelling' || status === 'cancelled',
          status: status ?? run.status,
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
        const { threads } = await listThreads(root);
        const target = threads.find((thread) => thread.id === threadId);
        if (!target) {
          res.status(404).json({ error: 'thread_not_found' });
          return;
        }
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
          res.status(409).json({
            error: 'descendants_not_done',
            descendants: openDescendants.map((thread) => ({
              id: thread.id,
              title: thread.title,
            })),
          });
          return;
        }
        const now = Date.now();
        const updated = await updateThread(root, threadId, (thread) => ({
          ...thread,
          status: 'done',
          runs: thread.runs.map((run) =>
            run.status === 'queued'
              ? { ...run, status: 'cancelled' as const, endedAt: now }
              : run.status === 'running' || run.status === 'finishing'
                ? { ...run, status: 'cancelling' as const }
                : run,
          ),
          outbox:
            thread.parentThreadId &&
            !thread.outbox.some(
              (event) =>
                event.payload['event'] === 'child_done' &&
                event.status === 'pending',
            )
              ? [
                  ...thread.outbox,
                  {
                    id: generateEventId(),
                    kind: 'parent_report' as const,
                    payload: {
                      event: 'child_done',
                      threadId: thread.id,
                      parentThreadId: thread.parentThreadId,
                    },
                    status: 'pending' as const,
                    attempts: 0,
                    createdAt: now,
                  },
                ]
              : thread.outbox,
        }));
        const dispatchError = await startBookedRuns(runtime);
        res.json({
          id: updated.id,
          status: updated.status,
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
        const dispatchError =
          result.outcomes.some((outcome) => outcome.decision.kind !== 'skip')
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
