/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The workspace agent roster behind the Web Shell agents pages: agents CRUD,
 * Agent Host enrollment and removal, and A2A shares.
 *
 * Agents answer @-mentions inside chat sessions through the session-agents
 * orchestrator (`routes/session-agents.ts`); this layer only reads its live
 * runs to report status and to refuse roster changes that would strand one.
 */

import { randomBytes } from 'node:crypto';
import type { Application, Request, RequestHandler, Response } from 'express';
import type {
  WorkspaceAgent,
  WorkspaceAgentExecution,
} from '@qwen-code/qwen-code-core';
import {
  HOST_PROTOCOL_VERSION,
  type SessionAgentProgram,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import { updateWorkspaceAgentsWithSquads } from '@qwen-code/qwen-code-core/agents/session-agents/squad-store.js';
import {
  generateAgentId,
  isValidAgentName,
  issueAgentHostEnrollment,
  isValidId,
  readAgentHosts,
  readWorkspaceAgents,
  removeAgentHost,
  retireWorkspaceAgent,
  isAgentAddressable,
  isAgentLocal,
  maxConcurrentRunsFor,
  updateWorkspaceAgent,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import {
  LOCAL_AGENT_RUNTIME_ID,
  AGENT_PROGRAM_LABELS,
  hostAvailablePrograms,
  type AgentHostView,
  isAgentProgram,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/types.js';
import {
  issueA2AGrant,
  listA2AGrants,
  revokeA2AGrant,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/a2a-grants.js';
import { AGENT_SESSION_SOURCE_TYPE } from '../../runtime/agent-session-source.js';
import {
  getSessionAgentOrchestrator,
  type SessionAgentLiveRunSummary,
} from '../session-agents/orchestrator.js';
import { probeAgentPrograms } from '../session-agents/program-probe.js';
import { availablePrograms } from '../agent-host-programs.js';
import { registerAgentHostRemoteConnectRoute } from './agent-host-connection.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

export interface RegisterWorkspaceAgentRoutesDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  /**
   * Per-workspace opt-in check, resolved from the same settings merge a
   * hosted session sees (workspace scope wins), with the env var as the
   * operator's process-wide override. Consulted per request, never
   * snapshotted, so a workspace can flip the feature off without a daemon
   * restart.
   */
  isAgentCollaborationEnabledFor: (workspaceCwd: string) => boolean;
}

/** A runtime counts as online while its last heartbeat is this recent. */
const AGENT_HOST_ONLINE_WINDOW_MS = 15_000;

/** Executing (not queued) session-agent run statuses. */
const EXECUTING_RUN_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'awaiting_approval',
]);

function sessionHostPrograms(host: AgentHostView): SessionAgentProgram[] {
  return host.protocol === HOST_PROTOCOL_VERSION
    ? hostAvailablePrograms(host)
    : [];
}

/** The programs this machine can run agents with, as ids. */
async function localPrograms(): Promise<SessionAgentProgram[]> {
  return availablePrograms(await probeAgentPrograms());
}

/** This workspace's live session-agent runs; none without an orchestrator. */
async function liveRunsOf(
  runtime: WorkspaceRuntime,
): Promise<SessionAgentLiveRunSummary[]> {
  const orchestrator = getSessionAgentOrchestrator(runtime.workspaceCwd);
  return orchestrator ? orchestrator.liveRuns() : [];
}

async function hasLiveRuns(
  runtime: WorkspaceRuntime,
  agentId: string,
): Promise<boolean> {
  return (await liveRunsOf(runtime)).some((run) => run.agentId === agentId);
}

/**
 * Reads the editable half of an agent from a PATCH body.
 *
 * Three states per field, and they are not the same thing. Absent leaves the
 * value alone, so editing one field cannot blank the others. `null` clears the
 * override and returns the agent to what its definition says. A value sets it.
 * Anything else is rejected rather than coerced, because a colour that is not
 * a colour or a concurrency that is not a number would be written to the
 * roster and read back by the orchestrator.
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

function readAgentExecution(
  value: unknown,
): WorkspaceAgentExecution | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) return 'invalid';
  const input = value as Record<string, unknown>;
  const provider = input['provider'];
  if (input['mode'] === 'local') {
    if (provider !== undefined && !isAgentProgram(provider)) return 'invalid';
    return { mode: 'local', ...(provider ? { provider } : {}) };
  }
  const hostIds = input['hostIds'];
  if (
    input['mode'] !== 'managed-host' ||
    !Array.isArray(hostIds) ||
    hostIds.length === 0 ||
    !hostIds.every(
      (hostId) => typeof hostId === 'string' && hostId.length > 0,
    ) ||
    (provider !== undefined && !isAgentProgram(provider))
  ) {
    return 'invalid';
  }
  return {
    mode: 'managed-host',
    hostIds: [...new Set(hostIds)],
    ...(provider ? { provider } : {}),
  };
}

/**
 * The most runs one agent may be set to execute at once.
 *
 * A ceiling on the setting, not on the machine: every concurrent run is a
 * prompt in flight against the same session, and a number typed with an extra
 * digit would book work nobody can read the results of.
 */
const MAX_CONCURRENT_RUNS_CEILING = 8;

export function registerWorkspaceAgentRoutes(
  app: Application,
  deps: RegisterWorkspaceAgentRoutesDeps,
): void {
  // /agents/:agentType already belongs to reusable agent definitions.
  const prefix = '/workspaces/:workspace/agent';

  const runtimeFor = (
    req: Request,
    res: Response,
  ): WorkspaceRuntime | undefined => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime) return;
    if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
    // The opt-in is per workspace: a workspace whose settings never enabled
    // collaboration answers exactly like an unmounted route, so clients read
    // "absent" the same way on either side of the flag.
    if (!deps.isAgentCollaborationEnabledFor(runtime.workspaceCwd)) {
      res.status(404).json({ error: 'agent_collaboration_disabled' });
      return undefined;
    }
    return runtime;
  };

  // `hosts/service` and `hosts/connect` (being joined as a runtime) are
  // mounted by server.ts regardless of the opt-in; only the coordinator-side
  // pull stays behind it.
  registerAgentHostRemoteConnectRoute(app, prefix, runtimeFor, deps.mutate);

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

  app.get(`${prefix}/agents`, async (req: Request, res: Response) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    const root = runtime.workspaceCwd;
    try {
      const [agents, hosts, liveRuns, programs] = await Promise.all([
        readWorkspaceAgents(root),
        readAgentHosts(root),
        liveRunsOf(runtime),
        localPrograms(),
      ]);
      const sessions = runtime.bridge.listWorkspaceSessions(root);
      const agentSessions = sessions.filter(
        (candidate) => candidate.sourceType === AGENT_SESSION_SOURCE_TYPE,
      );
      const runsOf = (agentIds: ReadonlySet<string>, hostId?: string) => {
        const runs = liveRuns.filter(
          (run) =>
            agentIds.has(run.agentId) &&
            (hostId === undefined ? !run.hostId : run.hostId === hostId),
        );
        return {
          runningTaskCount: runs.filter((run) =>
            EXECUTING_RUN_STATUSES.has(run.status),
          ).length,
          // A queued run has no runtime yet; it counts where the agent lives.
          queuedTaskCount: liveRuns.filter(
            (run) => agentIds.has(run.agentId) && run.status === 'queued',
          ).length,
        };
      };
      const localAgentIds = new Set(
        agents
          .filter(
            (agent) => agent.retiredAt === undefined && isAgentLocal(agent),
          )
          .map((agent) => agent.id),
      );
      const localRuntime = {
        id: LOCAL_AGENT_RUNTIME_ID,
        kind: 'local' as const,
        label: 'Local daemon',
        provider: programs
          .map((program) => AGENT_PROGRAM_LABELS[program])
          .join(', '),
        programs,
        status: 'online' as const,
        workspaceId: runtime.workspaceId,
        workspaceCwd: root,
        agentCount: localAgentIds.size,
        sessionCount: agentSessions.length,
        ...runsOf(localAgentIds),
      };
      const now = Date.now();
      const hostRuntimes = hosts.map((host) => {
        const agentIds = new Set(
          agents
            .filter(
              (agent) =>
                agent.retiredAt === undefined &&
                agent.execution?.mode === 'managed-host' &&
                agent.execution.hostIds.includes(host.id),
            )
            .map((agent) => agent.id),
        );
        return {
          id: host.id,
          kind: 'external' as const,
          label: host.name,
          provider: host.providers.join(', '),
          programs: sessionHostPrograms(host),
          status:
            host.protocol === HOST_PROTOCOL_VERSION &&
            host.lastSeenAt !== undefined &&
            now - host.lastSeenAt <= AGENT_HOST_ONLINE_WINDOW_MS
              ? ('online' as const)
              : ('offline' as const),
          workspaceId: runtime.workspaceId,
          workspaceCwd: host.workspaceCwd,
          ...(host.lastSeenAt !== undefined
            ? { lastSeenAt: host.lastSeenAt }
            : {}),
          agentCount: agentIds.size,
          sessionCount: 0,
          ...runsOf(agentIds, host.id),
        };
      });
      res.json({
        agents: agents.map((agent) => {
          const runs = liveRuns.filter((run) => run.agentId === agent.id);
          const executing = runs.find((run) =>
            EXECUTING_RUN_STATUSES.has(run.status),
          );
          const waiting = runs.filter((run) => run.status === 'queued').length;
          const sessionsForAgent = agentSessions.filter(
            (candidate) => candidate.sourceId === agent.id,
          );
          const execution = agent.execution ?? { mode: 'local' as const };
          const availableHost =
            execution.mode === 'managed-host'
              ? hostRuntimes.find(
                  (host) =>
                    execution.hostIds.includes(host.id) &&
                    host.status === 'online' &&
                    (!execution.provider ||
                      host.programs.includes(execution.provider)),
                )
              : undefined;
          const selectedHostId =
            executing?.hostId ??
            availableHost?.id ??
            (execution.mode === 'managed-host'
              ? execution.hostIds[0]
              : undefined);
          const selectedHost = hostRuntimes.find(
            (host) => host.id === selectedHostId,
          );
          const runtimeAvailable =
            execution.mode === 'local'
              ? !execution.provider || programs.includes(execution.provider)
              : availableHost !== undefined;
          const status =
            agent.retiredAt !== undefined ||
            agent.enabled === false ||
            !runtimeAvailable
              ? 'offline'
              : executing ||
                  sessionsForAgent.some((entry) => entry.hasActivePrompt)
                ? 'working'
                : sessionsForAgent.some((entry) => entry.hasTurnError)
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
            execution,
            enabled: agent.enabled !== false,
            status,
            runtime:
              execution.mode === 'local'
                ? localRuntime
                : (selectedHost ?? {
                    id: selectedHostId ?? 'managed-host',
                    kind: 'external' as const,
                    label: 'Managed Host',
                    provider: 'Unregistered',
                    status: 'offline' as const,
                  }),
            // A retired agent is listed, not hidden. Its messages are still in
            // the chat sessions, and a reader who meets its name needs
            // somewhere to look it up. `enabled` stays a separate answer: a
            // retired agent is not merely paused.
            ...(agent.retiredAt !== undefined
              ? { retiredAt: agent.retiredAt }
              : {}),
            waiting,
          };
        }),
        runtime: localRuntime,
        runtimes: [localRuntime, ...hostRuntimes],
      });
    } catch (error) {
      fail(res, error);
    }
  });

  const enrollMutation = deps.mutate();
  const replaceMutation = deps.mutate({ strict: true });
  app.post(
    `${prefix}/hosts/enrollment`,
    (req, res, next) =>
      (req.body?.supersedesHostId !== undefined
        ? replaceMutation
        : enrollMutation)(req, res, next),
    async (req: Request, res: Response) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const supersedesHostId: unknown = req.body?.supersedesHostId;
      if (
        supersedesHostId !== undefined &&
        (typeof supersedesHostId !== 'string' || !isValidId(supersedesHostId))
      ) {
        res
          .status(400)
          .json({ error: 'Invalid Agent Host replacement target.' });
        return;
      }
      try {
        res.status(201).json({
          ...(await issueAgentHostEnrollment(
            runtime.workspaceCwd,
            supersedesHostId,
          )),
          workspaceId: runtime.workspaceId,
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  // Removing a Host is also how its credential is revoked: a lost machine or
  // a leaked host file stops authenticating on the next request.
  app.delete(
    `${prefix}/hosts/:hostId`,
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      try {
        const result = await removeAgentHost(
          runtime.workspaceCwd,
          String(req.params['hostId']),
        );
        if (!result.removed) {
          res.status(404).json({ error: 'host_not_found' });
          return;
        }
        // Its runs, and queued runs nothing can start any more, end now
        // rather than wait for a lease that a revoked Host cannot renew.
        // The removal has already committed: a cleanup failure is logged and
        // must not turn this answer into a 5xx, which the caller would read
        // as "the Host is still enrolled", leaving the stranded runs live
        // with no signal.
        await getSessionAgentOrchestrator(runtime.workspaceCwd)
          ?.endRunsForRemovedHost(
            String(req.params['hostId']),
            result.agentsMadeLocal,
          )
          .catch((error) => {
            writeStderrLine(
              `qwen serve: ending the runs of removed Host ${String(req.params['hostId'])} failed: ` +
                (error instanceof Error ? error.message : String(error)),
            );
          });
        res.json({ agentsMadeLocal: result.agentsMadeLocal });
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
          execution?: unknown;
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
        const execution = readAgentExecution(payload.execution);
        if (execution === 'invalid') {
          res.status(400).json({ error: 'execution_invalid' });
          return;
        }
        if (
          execution?.mode === 'local' &&
          execution.provider !== undefined &&
          !(await localPrograms()).includes(execution.provider)
        ) {
          res.status(400).json({ error: 'program_unavailable' });
          return;
        }
        if (execution?.mode === 'managed-host') {
          if (
            (typeof payload.agentType === 'string' &&
              payload.agentType.trim()) ||
            (typeof payload.model === 'string' && payload.model.trim())
          ) {
            res.status(400).json({ error: 'managed_host_persona_unsupported' });
            return;
          }
          const placed = (await readAgentHosts(root)).filter((host) =>
            execution.hostIds.includes(host.id),
          );
          if (placed.length !== execution.hostIds.length) {
            res.status(400).json({ error: 'agent_host_not_found' });
            return;
          }
          if (
            !placed.some((host) => {
              const programs = sessionHostPrograms(host);
              return execution.provider === undefined
                ? programs.length > 0
                : programs.includes(execution.provider);
            })
          ) {
            res.status(400).json({ error: 'program_unavailable' });
            return;
          }
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
        let squadClash = false;
        // Agents and squads share one @-name space; the squads are read under
        // the same lock as this roster write, so neither can take the name in
        // between.
        await updateWorkspaceAgentsWithSquads(root, (agents, squads) => {
          if (
            squads.some(
              (squad) => squad.name.toLowerCase() === name.toLowerCase(),
            )
          ) {
            squadClash = true;
            return agents;
          }
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
            createdAt: Date.now(),
            ...(execution ? { execution } : {}),
          });
          return [...agents, created];
        });
        if (squadClash) {
          res
            .status(409)
            .json({ error: `A squad named "${name}" already exists.` });
          return;
        }
        if (duplicate) {
          res.status(409).json({
            error: duplicateRetired
              ? `A retired agent is named "${name}". Retired names stay taken so its old posts still read as its own.`
              : `An agent named "${name}" already exists.`,
          });
          return;
        }
        res.json({ id: created?.id });
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
        // An agent cannot be retired out from under a run in flight.
        // TODO(multi-agent): check-then-retire is not atomic with the
        // orchestrator; a mention landing in between still starts a run.
        if (await hasLiveRuns(runtime, agentId)) {
          res.status(409).json({ error: 'agent_has_live_work' });
          return;
        }
        const result = await retireWorkspaceAgent(
          runtime.workspaceCwd,
          agentId,
        );
        if (result === 'not_found') {
          res.status(404).json({ error: 'agent_not_found' });
          return;
        }
        // A retired agent's hidden sessions are closed: nothing resumes them.
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
        res.json({
          id: agentId,
          // The identity is gone from the roster's point of view and its
          // messages are still readable. `deleted` stays for callers that read
          // it, and says what actually happened alongside it.
          deleted: true,
          retired: true,
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  /**
   * Shares: A2A grants for one agent, so a caller outside this workspace can
   * message it. Each share is its own caller id, so revoking one leaves the
   * others working; the secret is returned once and only its hash is kept.
   */
  const SHARE_TTL_MS = 7 * 24 * 60 * 60_000;
  const knownAgent = async (runtime: WorkspaceRuntime, agentId: string) =>
    (await readWorkspaceAgents(runtime.workspaceCwd)).some(
      (agent) => agent.id === agentId && isAgentAddressable(agent),
    );

  app.get(`${prefix}/agents/:id/shares`, async (req, res) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    const agentId = String(req.params['id']);
    try {
      const now = Date.now();
      const shares = (await listA2AGrants(runtime.workspaceCwd))
        .filter(
          (grant) =>
            grant.agentId === agentId &&
            (grant.expiresAt === undefined || grant.expiresAt > now),
        )
        .map(({ callerId, createdAt, expiresAt }) => ({
          callerId,
          createdAt,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        }));
      res.json({ shares });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post(
    `${prefix}/agents/:id/shares`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const agentId = String(req.params['id']);
      try {
        if (!(await knownAgent(runtime, agentId))) {
          res.status(404).json({ error: 'agent_not_found' });
          return;
        }
        const callerId = `share_${randomBytes(6).toString('hex')}`;
        const expiresAt = Date.now() + SHARE_TTL_MS;
        const { secret } = await issueA2AGrant(runtime.workspaceCwd, {
          callerId,
          agentId,
          expiresAt,
        });
        res.status(201).json({
          endpoint: `${req.protocol}://${req.get('host') ?? '127.0.0.1'}/a2a/v1`,
          workspaceId: runtime.workspaceId,
          callerId,
          agentId,
          secret,
          expiresAt,
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.delete(
    `${prefix}/agents/:id/shares/:callerId`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      try {
        const removed = await revokeA2AGrant(runtime.workspaceCwd, {
          agentId: String(req.params['id']),
          callerId: String(req.params['callerId']),
        });
        if (!removed) {
          res.status(404).json({ error: 'share_not_found' });
          return;
        }
        res.json({ revoked: true });
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
        execution?: unknown;
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
      const execution = readAgentExecution(payload.execution);
      if (execution === 'invalid') {
        res.status(400).json({ error: 'execution_invalid' });
        return;
      }
      if (enabled === undefined && !config.touched && execution === undefined) {
        res.status(400).json({ error: 'nothing_to_update' });
        return;
      }
      const applyConfig = config.apply;
      if (!applyConfig) {
        res.status(500).json({ error: 'config_patch_unavailable' });
        return;
      }
      try {
        const agentId = String(req.params['id']);
        // Moving an agent under a live run would leave that run on a runtime
        // the agent no longer names.
        if (execution !== undefined && (await hasLiveRuns(runtime, agentId))) {
          res.status(409).json({ error: 'agent_has_live_work' });
          return;
        }
        if (
          execution?.mode === 'local' &&
          execution.provider !== undefined &&
          !(await localPrograms()).includes(execution.provider)
        ) {
          res.status(400).json({ error: 'program_unavailable' });
          return;
        }
        if (execution?.mode === 'managed-host') {
          const hosts = await readAgentHosts(runtime.workspaceCwd);
          const placed = hosts.filter((host) =>
            execution.hostIds.includes(host.id),
          );
          if (placed.length !== execution.hostIds.length) {
            res.status(400).json({ error: 'agent_host_not_found' });
            return;
          }
          if (
            !placed.some((host) => {
              const programs = sessionHostPrograms(host);
              return execution.provider === undefined
                ? programs.length > 0
                : programs.includes(execution.provider);
            })
          ) {
            res.status(400).json({ error: 'program_unavailable' });
            return;
          }
        }
        const result = await updateWorkspaceAgent(
          runtime.workspaceCwd,
          agentId,
          {
            ...(config.touched ? { applyConfig } : {}),
            ...(execution !== undefined ? { execution } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
          },
        );
        if (result !== 'updated') {
          const [status, error] =
            result === 'not_found'
              ? ([404, 'agent_not_found'] as const)
              : result === 'retired'
                ? ([409, 'agent_retired'] as const)
                : result === 'host_not_found'
                  ? ([400, 'agent_host_not_found'] as const)
                  : result === 'program_unavailable'
                    ? ([400, 'program_unavailable'] as const)
                    : ([400, 'managed_host_persona_unsupported'] as const);
          res.status(status).json({ error });
          return;
        }
        res.json({
          id: agentId,
          ...(enabled !== undefined ? { enabled } : {}),
          updated: true,
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );
}
