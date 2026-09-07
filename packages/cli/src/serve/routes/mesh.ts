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

import type { Application, Request, Response } from 'express';
import {
  createThread,
  decideDispatch,
  generateAgentId,
  listThreads,
  parseMentions,
  postMessage,
  readMeshAgents,
  readThread,
  resolveThreadStatus,
  updateMeshAgents,
  updateThread,
  resolveTargets,
  hasLiveDescendant,
  HUMAN_AUTHOR_ID,
  DEFAULT_THREAD_AUTO_TURN_BUDGET,
  DEFAULT_THREAD_TOKEN_BUDGET,
  type MeshAgent,
  type Thread,
  type ThreadRun,
} from '@qwen-code/qwen-code-core';

export interface RegisterMeshRoutesDeps {
  /** Project root whose runtime dir holds this workspace's threads. */
  boundWorkspace: string;
  isWorkspaceTrusted?: () => boolean;
}

const LIVE_RUN_STATUSES = new Set([
  'queued',
  'running',
  'finishing',
  'cancelling',
]);

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
      run.transcriptStartOffset !== undefined && run.sessionId !== undefined,
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

export function registerMeshRoutes(
  app: Application,
  deps: RegisterMeshRoutesDeps,
): void {
  const root = deps.boundWorkspace;

  const guard = (res: Response): boolean => {
    if (deps.isWorkspaceTrusted?.() === false) {
      res.status(403).json({ error: 'workspace_untrusted' });
      return false;
    }
    return true;
  };

  const fail = (res: Response, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  };

  app.get('/mesh/agents', async (_req: Request, res: Response) => {
    if (!guard(res)) return;
    try {
      const [agents, { threads }] = await Promise.all([
        readMeshAgents(root),
        listThreads(root),
      ]);
      res.json({
        agents: agents.map((agent) => {
          const live = threads.find((thread) =>
            thread.runs.some(
              (run) =>
                run.agentId === agent.id && LIVE_RUN_STATUSES.has(run.status),
            ),
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
            ...(live ? { workingOn: { id: live.id, title: live.title } } : {}),
            waiting,
          };
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/mesh/threads', async (_req: Request, res: Response) => {
    if (!guard(res)) return;
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

  app.get('/mesh/threads/:id', async (req: Request, res: Response) => {
    if (!guard(res)) return;
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
        status: resolution.status,
        reason: resolution.reason,
        posts: thread.messages.map((message) => ({
          id: message.id,
          sequence: message.sequence,
          authorKind: message.authorKind,
          authorName: message.authorNameSnapshot,
          text: message.text,
          at: message.at,
        })),
        runs: thread.runs.map((run) => runView(thread, run, agents)),
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

  /**
   * What a draft reply would do, without doing it.
   *
   * Runs the admission rules against the draft so the composer can show the
   * true outcome. Nothing is written and no budget is spent: a preview that
   * charged a turn would make looking at the consequences cost the same as
   * accepting them.
   */
  app.post('/mesh/threads/:id/preview', async (req: Request, res: Response) => {
    if (!guard(res)) return;
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
   * Assignment is the trigger, so the assignee is applied at creation and a
   * first post books the work through ordinary admission rather than through
   * a side channel that could bypass budgets or the queue limit.
   */
  app.post('/mesh/threads', async (req: Request, res: Response) => {
    if (!guard(res)) return;
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
            (agent) => agent.name.toLowerCase() === assigneeName.toLowerCase(),
          )
        : undefined;
      if (assigneeName && !assignee) {
        res.status(400).json({ error: 'assignee_unknown' });
        return;
      }
      const thread = await createThread(root, {
        title,
        ...(typeof payload.body === 'string' ? { body: payload.body } : {}),
        ...(assignee ? { assigneeAgentId: assignee.id } : {}),
      });
      let booked = 0;
      if (assignee && typeof payload.body === 'string' && payload.body.trim()) {
        const posted = await postMessage(root, thread.id, {
          from: HUMAN_AUTHOR_ID,
          text: payload.body,
        });
        booked = posted.dispatched.length;
      }
      res.json({ id: thread.id, booked });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/mesh/agents', async (req: Request, res: Response) => {
    if (!guard(res)) return;
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

  /**
   * Marks a thread done, refusing while a descendant is still open.
   *
   * v1 never cascades: closing a parent silently would end work a person never
   * looked at. The refusal names the descendants so the reader can go finish
   * them rather than guessing which one is holding this open.
   */
  app.post('/mesh/threads/:id/done', async (req: Request, res: Response) => {
    if (!guard(res)) return;
    try {
      const threadId = String(req.params['id']);
      const { threads } = await listThreads(root);
      const target = threads.find((thread) => thread.id === threadId);
      if (!target) {
        res.status(404).json({ error: 'thread_not_found' });
        return;
      }
      const openDescendants = threads.filter(
        (thread) =>
          thread.id !== threadId &&
          thread.parentThreadId === threadId &&
          thread.status !== 'done',
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
      const updated = await updateThread(root, threadId, (thread) => ({
        ...thread,
        status: 'done',
        runs: thread.runs.map((run) =>
          run.status === 'queued'
            ? { ...run, status: 'cancelled' as const, endedAt: Date.now() }
            : run,
        ),
      }));
      res.json({ id: updated.id, status: updated.status });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/mesh/threads/:id/posts', async (req: Request, res: Response) => {
    if (!guard(res)) return;
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
      });
    } catch (error) {
      fail(res, error);
    }
  });
}
