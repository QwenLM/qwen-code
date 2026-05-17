/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import {
  APPROVAL_MODES,
  BuiltinAgentRegistry,
  SubagentError,
  SubagentErrorCode,
  SubagentManager,
  type Config,
  type SubagentConfig,
  type SubagentLevel,
} from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { InvalidClientIdError, type HttpAcpBridge } from './httpAcpBridge.js';
import {
  STATUS_SCHEMA_VERSION,
  type ServeAgentLevel,
  type ServeWorkspaceAgentDetail,
  type ServeWorkspaceAgentSummary,
  type ServeWorkspaceAgentsStatus,
} from './status.js';

/**
 * Issue #4175 PR 16: workspace subagent CRUD routes.
 *
 * Wraps `SubagentManager` over five HTTP routes:
 *
 *   GET    /workspace/agents             — list project + user + builtin + extension
 *   POST   /workspace/agents             — create at project or user level (409 on collision)
 *   GET    /workspace/agents/:agentType  — full detail incl. systemPrompt
 *   POST   /workspace/agents/:agentType  — update existing (404 missing, 403 read-only)
 *   DELETE /workspace/agents/:agentType  — delete (idempotent for SDK callers)
 *
 * The daemon doesn't have a full `Config` instance, so we instantiate
 * `SubagentManager` against a CRUD-scoped `Config` stub that
 * implements only `getSdkMode / getProjectRoot / getActiveExtensions`
 * — the methods the manager's CRUD paths actually touch (verified
 * against `subagent-manager.ts:365,932,954,958`). A `Proxy` makes any
 * future use of an unimplemented method throw immediately so a
 * silent dependency creep can't ship as a 500.
 */

export interface WorkspaceAgentsRouteDeps {
  bridge: HttpAcpBridge;
  boundWorkspace: string;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  parseClientId: (req: Request, res: Response) => string | undefined | null;
  safeBody: (req: Request) => Record<string, unknown>;
}

export function mountWorkspaceAgentsRoutes(
  app: Application,
  deps: WorkspaceAgentsRouteDeps,
): void {
  const manager = createDaemonSubagentManager(deps.boundWorkspace);

  app.get('/workspace/agents', async (_req, res) => {
    try {
      // `force: true` re-walks `.qwen/agents/` on every call so out-of-
      // band edits (a developer editing an agent file in their IDE
      // while the daemon is running) appear immediately. Without it
      // `SubagentManager.listSubagents()` serves a stale cache and
      // diverges from `GET /workspace/agents/:agentType`, which always
      // reads from disk (`loadSubagent → findSubagentByNameAtLevel →
      // listSubagentsAtLevel`). Bringing the LIST route to parity is
      // sub-millisecond for the typical 0-50 agents and matches the
      // detail route's "filesystem is the source of truth" contract.
      const agents = await manager.listSubagents({ force: true });
      const status: ServeWorkspaceAgentsStatus = {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: deps.boundWorkspace,
        agents: agents.map(toSummary),
      };
      res.status(200).json(status);
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /workspace/agents failed: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to list workspace agents',
        code: 'agent_list_failed',
      });
    }
  });

  app.post(
    '/workspace/agents',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const body = deps.safeBody(req);
      const clientIdResult = resolveOriginatorClientId(deps, req, res);
      if (clientIdResult === null) return;
      const originatorClientId = clientIdResult;

      const scope = body['scope'];
      if (scope !== 'workspace' && scope !== 'global') {
        res.status(400).json({
          error: '`scope` must be "workspace" or "global"',
          code: 'invalid_scope',
        });
        return;
      }
      const level: SubagentLevel = scope === 'workspace' ? 'project' : 'user';

      const config = parseAgentConfig(body, level, res);
      if (!config) return;

      // `manager.createSubagent` only checks whether the default
      // `<name>.md` file path is occupied. If a different on-disk
      // file at the same level shares the frontmatter `name`, the
      // duplicate-name collision wouldn't surface as 409. Preflight
      // through `loadSubagent(name, level)` so a same-name shadow at
      // either level returns `agent_already_exists` deterministically.
      const collision = await manager.loadSubagent(config.name, level);
      if (collision) {
        res.status(409).json({
          error: `Subagent "${config.name}" already exists at ${level} level`,
          code: 'agent_already_exists',
          name: config.name,
          level,
        });
        return;
      }

      try {
        await manager.createSubagent(config, { level });
      } catch (err) {
        if (err instanceof SubagentError) {
          if (err.code === SubagentErrorCode.ALREADY_EXISTS) {
            res.status(409).json({
              error: err.message,
              code: 'agent_already_exists',
              name: err.subagentName ?? config.name,
            });
            return;
          }
          if (
            err.code === SubagentErrorCode.VALIDATION_ERROR ||
            err.code === SubagentErrorCode.INVALID_CONFIG ||
            err.code === SubagentErrorCode.INVALID_NAME ||
            err.code === SubagentErrorCode.TOOL_NOT_FOUND
          ) {
            res.status(422).json({
              error: err.message,
              code: 'invalid_config',
              name: err.subagentName ?? config.name,
            });
            return;
          }
          if (err.code === SubagentErrorCode.FILE_ERROR) {
            res.status(500).json({
              error: err.message,
              code: 'file_error',
              name: err.subagentName ?? config.name,
            });
            return;
          }
        }
        writeStderrLine(
          `qwen serve: POST /workspace/agents failed: ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to create workspace agent',
          code: 'agent_create_failed',
        });
        return;
      }

      const created = await manager.loadSubagent(config.name, level);
      if (!created) {
        // Race window: createSubagent already wrote the file to disk,
        // but the subsequent loadSubagent walked the cache and found
        // nothing — typically a cache-refresh ordering bug. The file
        // persists (no rollback) because deleting on a half-failed
        // create would lose work for an agent that's actually fine on
        // disk. Operators MUST be able to correlate the orphan file
        // with the failed POST, so emit a stderr breadcrumb with the
        // path; a fresh `GET /workspace/agents` will surface the
        // agent on next request. PR 24's PermissionMediator can layer
        // a proper rollback policy on top once mutation auditing
        // arrives.
        writeStderrLine(
          `qwen serve: agent_create_reload_failed (name="${config.name}" ` +
            `level=${level}) — file likely persisted on disk; check ` +
            `\`GET /workspace/agents\` for a phantom entry`,
        );
        res.status(500).json({
          error: 'Agent creation succeeded but reload failed',
          code: 'agent_create_reload_failed',
          name: config.name,
          level,
        });
        return;
      }
      deps.bridge.publishWorkspaceEvent({
        type: 'agent_changed',
        data: { change: 'created', name: config.name, level },
        ...(originatorClientId ? { originatorClientId } : {}),
      });
      res.status(201).json({ ok: true, agent: toDetail(created) });
    },
  );

  app.get('/workspace/agents/:agentType', async (req, res) => {
    const agentType = req.params['agentType'];
    if (!agentType) {
      res.status(400).json({
        error: '`agentType` path parameter is required',
        code: 'invalid_agent_type',
      });
      return;
    }
    try {
      const config = await manager.loadSubagent(agentType);
      if (!config) {
        res.status(404).json({
          error: `Subagent "${agentType}" not found`,
          code: 'agent_not_found',
          name: agentType,
        });
        return;
      }
      res.status(200).json(toDetail(config));
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /workspace/agents/${agentType} failed: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to read workspace agent',
        code: 'agent_read_failed',
      });
    }
  });

  app.post(
    '/workspace/agents/:agentType',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const agentType = req.params['agentType'];
      if (!agentType) {
        res.status(400).json({
          error: '`agentType` path parameter is required',
          code: 'invalid_agent_type',
        });
        return;
      }
      const clientIdResult = resolveOriginatorClientId(deps, req, res);
      if (clientIdResult === null) return;
      const originatorClientId = clientIdResult;

      const body = deps.safeBody(req);
      const updates = parseAgentUpdates(body, res);
      if (!updates) return;

      // Fail-closed on `?scope=` malformations. `req.query['scope']`
      // is `undefined` when absent, a `string` when supplied once, an
      // array when repeated (`?scope=workspace&scope=global`), or a
      // ParsedQs object on a nested form. We only accept a single
      // string; anything else returns `invalid_scope` rather than
      // silently treating "?scope=...&scope=..." as if no scope were
      // provided. Matches the fail-closed posture of
      // `parseMaxQueuedQuery` for the SSE route.
      const rawScope = req.query['scope'];
      let scopeQuery: string | undefined;
      if (rawScope === undefined) {
        scopeQuery = undefined;
      } else if (typeof rawScope === 'string') {
        scopeQuery = rawScope;
      } else {
        res.status(400).json({
          error: '`scope` query must be a single "workspace" or "global" value',
          code: 'invalid_scope',
        });
        return;
      }
      let preferredLevel: SubagentLevel | undefined;
      if (scopeQuery !== undefined) {
        if (scopeQuery !== 'workspace' && scopeQuery !== 'global') {
          res.status(400).json({
            error: '`scope` query must be "workspace" or "global"',
            code: 'invalid_scope',
          });
          return;
        }
        preferredLevel = scopeQuery === 'workspace' ? 'project' : 'user';
      }

      const existing = await manager.loadSubagent(agentType, preferredLevel);
      if (!existing) {
        res.status(404).json({
          error: `Subagent "${agentType}" not found`,
          code: 'agent_not_found',
          name: agentType,
        });
        return;
      }
      if (
        existing.isBuiltin ||
        existing.level === 'builtin' ||
        existing.level === 'extension' ||
        existing.level === 'session'
      ) {
        res.status(403).json({
          error: `Cannot update ${existing.level}-level subagent "${agentType}"`,
          code: 'agent_readonly',
          name: existing.name,
          level: existing.level,
        });
        return;
      }

      // Empty / no-op update detection. An empty body or a body whose
      // recognized fields all match `existing` would otherwise rewrite
      // the file (mtime bump) AND fan out an `agent_changed` event for
      // a request that didn't change anything — the same misleading
      // signal the memory route avoids for whitespace-only appends.
      // Reject empty payloads with 400; short-circuit no-op updates
      // with 200 + `changed: false` so adapters can suppress redundant
      // toasts without re-fetching.
      if (Object.keys(updates).length === 0) {
        res.status(400).json({
          error:
            '`POST /workspace/agents/:agentType` requires at least one updatable field in the body',
          code: 'invalid_config',
          name: agentType,
        });
        return;
      }
      if (isNoOpUpdate(existing, updates)) {
        res.status(200).json({
          ok: true,
          agent: toDetail(existing),
          changed: false,
        });
        return;
      }

      try {
        await manager.updateSubagent(agentType, updates, existing.level);
      } catch (err) {
        if (err instanceof SubagentError) {
          if (err.code === SubagentErrorCode.NOT_FOUND) {
            res.status(404).json({
              error: err.message,
              code: 'agent_not_found',
              name: err.subagentName ?? agentType,
            });
            return;
          }
          if (err.code === SubagentErrorCode.INVALID_CONFIG) {
            res.status(403).json({
              error: err.message,
              code: 'agent_readonly',
              name: err.subagentName ?? agentType,
            });
            return;
          }
          if (
            err.code === SubagentErrorCode.VALIDATION_ERROR ||
            err.code === SubagentErrorCode.INVALID_NAME ||
            err.code === SubagentErrorCode.TOOL_NOT_FOUND
          ) {
            res.status(422).json({
              error: err.message,
              code: 'invalid_config',
              name: err.subagentName ?? agentType,
            });
            return;
          }
          if (err.code === SubagentErrorCode.FILE_ERROR) {
            res.status(500).json({
              error: err.message,
              code: 'file_error',
              name: err.subagentName ?? agentType,
            });
            return;
          }
        }
        writeStderrLine(
          `qwen serve: POST /workspace/agents/${agentType} failed: ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to update workspace agent',
          code: 'agent_update_failed',
        });
        return;
      }

      const updated = await manager.loadSubagent(agentType, existing.level);
      if (!updated) {
        // Symmetric to the create-reload-failure branch above. The
        // disk write succeeded but the cache lookup raced; emit a
        // breadcrumb so operators can correlate the orphan in-flight
        // change with the failed POST. The file is in its updated
        // state on disk; subsequent reads will pick it up.
        writeStderrLine(
          `qwen serve: agent_update_reload_failed (name="${agentType}" ` +
            `level=${existing.level}) — disk write completed; check ` +
            `\`GET /workspace/agents/${agentType}\` for the new state`,
        );
        res.status(500).json({
          error: 'Agent update succeeded but reload failed',
          code: 'agent_update_reload_failed',
          name: agentType,
          level: existing.level,
        });
        return;
      }
      const eventLevel: 'project' | 'user' =
        existing.level === 'project' ? 'project' : 'user';
      deps.bridge.publishWorkspaceEvent({
        type: 'agent_changed',
        data: { change: 'updated', name: existing.name, level: eventLevel },
        ...(originatorClientId ? { originatorClientId } : {}),
      });
      res
        .status(200)
        .json({ ok: true, agent: toDetail(updated), changed: true });
    },
  );

  app.delete(
    '/workspace/agents/:agentType',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const agentType = req.params['agentType'];
      if (!agentType) {
        res.status(400).json({
          error: '`agentType` path parameter is required',
          code: 'invalid_agent_type',
        });
        return;
      }
      const clientIdResult = resolveOriginatorClientId(deps, req, res);
      if (clientIdResult === null) return;
      const originatorClientId = clientIdResult;

      // Fail-closed on `?scope=` malformations. `req.query['scope']`
      // is `undefined` when absent, a `string` when supplied once, an
      // array when repeated (`?scope=workspace&scope=global`), or a
      // ParsedQs object on a nested form. We only accept a single
      // string; anything else returns `invalid_scope` rather than
      // silently treating "?scope=...&scope=..." as if no scope were
      // provided. Matches the fail-closed posture of
      // `parseMaxQueuedQuery` for the SSE route.
      const rawScope = req.query['scope'];
      let scopeQuery: string | undefined;
      if (rawScope === undefined) {
        scopeQuery = undefined;
      } else if (typeof rawScope === 'string') {
        scopeQuery = rawScope;
      } else {
        res.status(400).json({
          error: '`scope` query must be a single "workspace" or "global" value',
          code: 'invalid_scope',
        });
        return;
      }
      let scopedLevel: SubagentLevel | undefined;
      if (scopeQuery !== undefined) {
        if (scopeQuery !== 'workspace' && scopeQuery !== 'global') {
          res.status(400).json({
            error: '`scope` query must be "workspace" or "global"',
            code: 'invalid_scope',
          });
          return;
        }
        scopedLevel = scopeQuery === 'workspace' ? 'project' : 'user';
      }

      // Pre-check at every level we're going to try to delete. When
      // `scopedLevel` is given we touch just that level; when omitted,
      // `SubagentManager.deleteSubagent` iterates both `project` and
      // `user`, so we need to look at both to (a) reject built-in /
      // extension shadows and (b) emit one `agent_changed` event per
      // file actually removed.
      const levelsToCheck: SubagentLevel[] = scopedLevel
        ? [scopedLevel]
        : ['project', 'user'];
      const existingAtLevels: SubagentConfig[] = [];
      for (const lvl of levelsToCheck) {
        const found = await manager.loadSubagent(agentType, lvl);
        if (found) existingAtLevels.push(found);
      }
      for (const found of existingAtLevels) {
        if (
          found.isBuiltin ||
          found.level === 'builtin' ||
          found.level === 'extension' ||
          found.level === 'session'
        ) {
          res.status(403).json({
            error: `Cannot delete ${found.level}-level subagent "${agentType}"`,
            code: 'agent_readonly',
            name: found.name,
            level: found.level,
          });
          return;
        }
      }

      try {
        await manager.deleteSubagent(agentType, scopedLevel);
      } catch (err) {
        if (err instanceof SubagentError) {
          if (err.code === SubagentErrorCode.NOT_FOUND) {
            res.status(404).json({
              error: err.message,
              code: 'agent_not_found',
              name: err.subagentName ?? agentType,
            });
            return;
          }
          if (err.code === SubagentErrorCode.INVALID_CONFIG) {
            res.status(403).json({
              error: err.message,
              code: 'agent_readonly',
              name: err.subagentName ?? agentType,
            });
            return;
          }
        }
        writeStderrLine(
          `qwen serve: DELETE /workspace/agents/${agentType} failed: ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to delete workspace agent',
          code: 'agent_delete_failed',
        });
        return;
      }
      // Emit one event per level that was deleted so subscribers using
      // event metadata for toasts/audit/echo-suppression see the
      // complete picture. Without this split, an unscoped DELETE that
      // removed both project AND user shadows would publish only one
      // event with one level — misleading the receiver about which
      // file(s) actually went away.
      if (existingAtLevels.length === 0) {
        // `deleteSubagent` succeeded with no pre-checked level — could
        // happen if a file landed between the loadSubagent check and
        // the unlink. Emit a single best-effort event with the level
        // hint we know.
        const fallbackLevel: 'project' | 'user' =
          scopedLevel === 'user' ? 'user' : 'project';
        deps.bridge.publishWorkspaceEvent({
          type: 'agent_changed',
          data: {
            change: 'deleted',
            name: agentType,
            level: fallbackLevel,
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      } else {
        for (const found of existingAtLevels) {
          const evtLevel: 'project' | 'user' =
            found.level === 'project' ? 'project' : 'user';
          deps.bridge.publishWorkspaceEvent({
            type: 'agent_changed',
            data: {
              change: 'deleted',
              name: found.name,
              level: evtLevel,
            },
            ...(originatorClientId ? { originatorClientId } : {}),
          });
        }
      }
      res.status(204).end();
    },
  );
}

function resolveOriginatorClientId(
  deps: WorkspaceAgentsRouteDeps,
  req: Request,
  res: Response,
): string | undefined | null {
  const clientId = deps.parseClientId(req, res);
  if (clientId === null) return null;
  if (clientId === undefined) return undefined;
  if (!deps.bridge.knownClientIds().has(clientId)) {
    res.status(400).json({
      error: `Client id "${clientId}" is not registered for this workspace`,
      code: 'invalid_client_id',
      clientId,
    });
    return null;
  }
  return clientId;
}

function parseAgentConfig(
  body: Record<string, unknown>,
  level: SubagentLevel,
  res: Response,
): SubagentConfig | undefined {
  const rawName = body['name'];
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    res.status(422).json({
      error: '`name` is required and must be a non-empty string',
      code: 'invalid_config',
    });
    return undefined;
  }
  // Trim leading/trailing whitespace BEFORE storing. Without this, a
  // client posting `{ name: " tester " }` would land a file whose
  // frontmatter `name` field literally contains the spaces; the
  // resolver's case-insensitive cascade still wouldn't match `/agents/
  // tester` because the lookup name and the on-disk name differ.
  // Better to normalize at the boundary than carry untrimmed names
  // through validation + serialization.
  const name = rawName.trim();
  // Reject names that shadow a built-in subagent. Without this check a
  // client could `POST /workspace/agents { name: "general-purpose" }`
  // and write a project-level file at `<workspace>/.qwen/agents/
  // general-purpose.md`. List/load resolve the project entry first
  // (project > builtin), but `SubagentManager.deleteSubagent` rejects
  // by name alone (`subagent-manager.ts:302`) — so DELETE returns 403
  // `agent_readonly` and the file becomes undeleteable through the
  // API. Surface the conflict at create time instead. The check is
  // case-insensitive (`BuiltinAgentRegistry.isBuiltinAgent` lowercases
  // both sides), matching `loadSubagent`'s case-insensitive cascade.
  if (BuiltinAgentRegistry.isBuiltinAgent(name)) {
    res.status(422).json({
      error: `"${name}" shadows a built-in subagent and cannot be used as a project- or user-level agent name. Choose a different name.`,
      code: 'invalid_config',
      name,
    });
    return undefined;
  }
  const description = body['description'];
  if (typeof description !== 'string' || description.trim().length === 0) {
    res.status(422).json({
      error: '`description` is required and must be a non-empty string',
      code: 'invalid_config',
    });
    return undefined;
  }
  const systemPrompt = body['systemPrompt'];
  if (typeof systemPrompt !== 'string' || systemPrompt.length === 0) {
    res.status(422).json({
      error: '`systemPrompt` is required and must be a non-empty string',
      code: 'invalid_config',
    });
    return undefined;
  }
  const tools = parseStringArray(body['tools'], 'tools', res);
  if (tools === null) return undefined;
  const disallowedTools = parseStringArray(
    body['disallowedTools'],
    'disallowedTools',
    res,
  );
  if (disallowedTools === null) return undefined;
  const config: SubagentConfig = {
    name,
    description,
    systemPrompt,
    level,
  };
  if (tools !== undefined) config.tools = tools;
  if (disallowedTools !== undefined) config.disallowedTools = disallowedTools;

  // Optional scalar fields. Present-but-wrong-type fails closed (422)
  // rather than silently dropping the field — `SubagentValidator`
  // doesn't reject these, and `serializeSubagent` only writes recognized
  // values, so without explicit validation a `model: 123` payload would
  // 201 with no `model` field on the file (masking client-serialization
  // bugs).
  if (rejectIfPresentWrongType(body, 'model', 'string', res)) return undefined;
  if (typeof body['model'] === 'string') config.model = body['model'];

  if (rejectIfPresentWrongType(body, 'color', 'string', res)) return undefined;
  if (typeof body['color'] === 'string') config.color = body['color'];

  if (rejectIfPresentWrongType(body, 'approvalMode', 'string', res)) {
    return undefined;
  }
  if (typeof body['approvalMode'] === 'string') {
    if (!APPROVAL_MODES.includes(body['approvalMode'] as never)) {
      res.status(422).json({
        error: `\`approvalMode\` must be one of ${JSON.stringify(APPROVAL_MODES)}`,
        code: 'invalid_config',
      });
      return undefined;
    }
    config.approvalMode = body['approvalMode'];
  }

  if (rejectIfPresentWrongType(body, 'background', 'boolean', res)) {
    return undefined;
  }
  if (typeof body['background'] === 'boolean') {
    config.background = body['background'];
  }

  const runConfig = body['runConfig'];
  if (runConfig !== undefined) {
    const sanitized = sanitizeRunConfig(runConfig, res);
    if (sanitized === null) return undefined;
    config.runConfig = sanitized;
  }
  return config;
}

function parseAgentUpdates(
  body: Record<string, unknown>,
  res: Response,
): Partial<SubagentConfig> | undefined {
  const updates: Partial<SubagentConfig> = {};
  if ('description' in body) {
    if (typeof body['description'] !== 'string') {
      res.status(422).json({
        error: '`description` must be a string when provided',
        code: 'invalid_config',
      });
      return undefined;
    }
    updates.description = body['description'];
  }
  if ('systemPrompt' in body) {
    if (typeof body['systemPrompt'] !== 'string') {
      res.status(422).json({
        error: '`systemPrompt` must be a string when provided',
        code: 'invalid_config',
      });
      return undefined;
    }
    updates.systemPrompt = body['systemPrompt'];
  }
  if ('tools' in body) {
    const tools = parseStringArray(body['tools'], 'tools', res);
    if (tools === null) return undefined;
    if (tools !== undefined) updates.tools = tools;
  }
  if ('disallowedTools' in body) {
    const disallowedTools = parseStringArray(
      body['disallowedTools'],
      'disallowedTools',
      res,
    );
    if (disallowedTools === null) return undefined;
    if (disallowedTools !== undefined) {
      updates.disallowedTools = disallowedTools;
    }
  }
  // Optional scalar fields. Match the create-side fail-closed posture
  // so a typo like `model: 123` returns 422 instead of silently
  // succeeding with no model change.
  if (rejectIfPresentWrongType(body, 'model', 'string', res)) return undefined;
  if (typeof body['model'] === 'string') updates.model = body['model'];

  if (rejectIfPresentWrongType(body, 'color', 'string', res)) return undefined;
  if (typeof body['color'] === 'string') updates.color = body['color'];

  if (rejectIfPresentWrongType(body, 'approvalMode', 'string', res)) {
    return undefined;
  }
  if (typeof body['approvalMode'] === 'string') {
    if (!APPROVAL_MODES.includes(body['approvalMode'] as never)) {
      res.status(422).json({
        error: `\`approvalMode\` must be one of ${JSON.stringify(APPROVAL_MODES)}`,
        code: 'invalid_config',
      });
      return undefined;
    }
    updates.approvalMode = body['approvalMode'];
  }

  if (rejectIfPresentWrongType(body, 'background', 'boolean', res)) {
    return undefined;
  }
  if (typeof body['background'] === 'boolean') {
    updates.background = body['background'];
  }

  if ('runConfig' in body) {
    const sanitized = sanitizeRunConfig(body['runConfig'], res);
    if (sanitized === null) return undefined;
    updates.runConfig = sanitized;
  }
  return updates;
}

function parseStringArray(
  value: unknown,
  field: string,
  res: Response,
): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    res.status(422).json({
      error: `\`${field}\` must be an array of strings when provided`,
      code: 'invalid_config',
    });
    return null;
  }
  return value as string[];
}

/**
 * Returns `true` and sends a 422 when `body[key]` is present but the
 * wrong scalar type. The caller then returns `undefined` to short-
 * circuit the route. `false` covers both "absent" and "right type" so
 * the caller proceeds. Used to give scalar fields the same fail-closed
 * posture as `parseStringArray` / `sanitizeRunConfig`.
 */
function rejectIfPresentWrongType(
  body: Record<string, unknown>,
  key: string,
  expected: 'string' | 'boolean',
  res: Response,
): boolean {
  if (!(key in body)) return false;
  if (typeof body[key] === expected) return false;
  res.status(422).json({
    error: `\`${key}\` must be a ${expected} when provided`,
    code: 'invalid_config',
  });
  return true;
}

/**
 * Detect a no-op update — every supplied field already matches the
 * existing agent's value. Without this check an empty (or
 * value-unchanged) PATCH still rewrites the file, bumps mtime, and
 * fans out a misleading `agent_changed` event. The recognized-field
 * comparison covers what `parseAgentUpdates` produces; unknown keys
 * are dropped upstream so we don't need to handle them here.
 */
function isNoOpUpdate(
  existing: SubagentConfig,
  updates: Partial<SubagentConfig>,
): boolean {
  if (
    updates.description !== undefined &&
    updates.description !== existing.description
  ) {
    return false;
  }
  if (
    updates.systemPrompt !== undefined &&
    updates.systemPrompt !== existing.systemPrompt
  ) {
    return false;
  }
  if (
    updates.tools !== undefined &&
    !shallowArrayEqual(updates.tools, existing.tools)
  ) {
    return false;
  }
  if (
    updates.disallowedTools !== undefined &&
    !shallowArrayEqual(updates.disallowedTools, existing.disallowedTools)
  ) {
    return false;
  }
  if (updates.model !== undefined && updates.model !== existing.model) {
    return false;
  }
  if (updates.color !== undefined && updates.color !== existing.color) {
    return false;
  }
  if (
    updates.approvalMode !== undefined &&
    updates.approvalMode !== existing.approvalMode
  ) {
    return false;
  }
  if (
    updates.background !== undefined &&
    updates.background !== existing.background
  ) {
    return false;
  }
  if (updates.runConfig !== undefined) {
    const e = existing.runConfig ?? {};
    const u = updates.runConfig;
    if (
      u['max_time_minutes'] !== e['max_time_minutes'] ||
      u['max_turns'] !== e['max_turns']
    ) {
      return false;
    }
  }
  return true;
}

function shallowArrayEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Sanitize `runConfig` to only the documented fields. Without this
 * filter `SubagentManager.serializeSubagent` writes whatever object the
 * client sent into the agent's frontmatter, including unknown or
 * YAML-sensitive keys that downstream parsers may choke on. Returning
 * a fresh whitelist-shaped object also makes the wire contract
 * self-documenting at the route boundary.
 *
 * - `undefined` is impossible here (caller checks `'runConfig' in body`).
 * - `null` (sent) → 422 invalid_config (the route handler converts
 *   the null sentinel to a short-circuit).
 * - Right-shape object → returns a new object with only `max_time_minutes`
 *   and `max_turns` if they validate as finite positive numbers.
 */
function sanitizeRunConfig(
  raw: unknown,
  res: Response,
): SubagentConfig['runConfig'] | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    res.status(422).json({
      error: '`runConfig` must be an object when provided',
      code: 'invalid_config',
    });
    return null;
  }
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if ('max_time_minutes' in input) {
    const v = input['max_time_minutes'];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      res.status(422).json({
        error:
          '`runConfig.max_time_minutes` must be a positive finite number when provided',
        code: 'invalid_config',
      });
      return null;
    }
    out['max_time_minutes'] = v;
  }
  if ('max_turns' in input) {
    const v = input['max_turns'];
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      v <= 0 ||
      !Number.isInteger(v)
    ) {
      res.status(422).json({
        error: '`runConfig.max_turns` must be a positive integer when provided',
        code: 'invalid_config',
      });
      return null;
    }
    out['max_turns'] = v;
  }
  return out as SubagentConfig['runConfig'];
}

function toSummary(config: SubagentConfig): ServeWorkspaceAgentSummary {
  const summary: ServeWorkspaceAgentSummary = {
    kind: 'agent',
    name: config.name,
    description: config.description,
    level: toServeLevel(config.level),
    isBuiltin: config.isBuiltin === true || config.level === 'builtin',
    hasTools: Array.isArray(config.tools) && config.tools.length > 0,
  };
  if (config.model) summary.model = config.model;
  if (config.color) summary.color = config.color;
  if (config.background !== undefined) summary.background = config.background;
  if (config.approvalMode) summary.approvalMode = config.approvalMode;
  if (config.extensionName) summary.extensionName = config.extensionName;
  if (config.filePath) summary.filePath = config.filePath;
  return summary;
}

function toDetail(config: SubagentConfig): ServeWorkspaceAgentDetail {
  const detail: ServeWorkspaceAgentDetail = {
    ...toSummary(config),
    systemPrompt: config.systemPrompt,
  };
  if (config.tools) detail.tools = [...config.tools];
  if (config.disallowedTools) {
    detail.disallowedTools = [...config.disallowedTools];
  }
  if (config.runConfig) {
    detail.runConfig = {
      ...config.runConfig,
    } as ServeWorkspaceAgentDetail['runConfig'];
  }
  return detail;
}

function toServeLevel(level: SubagentLevel): ServeAgentLevel {
  return level;
}

/**
 * Build a CRUD-scoped `SubagentManager` for the daemon. The
 * underlying manager only touches three `Config` methods on its
 * read/write paths (`getSdkMode`, `getProjectRoot`,
 * `getActiveExtensions`); a `Proxy` makes any future expansion of
 * that surface throw immediately rather than silently produce
 * incorrect data.
 */
export function createDaemonSubagentManager(
  boundWorkspace: string,
): SubagentManager {
  const stub = {
    getSdkMode: () => false,
    getProjectRoot: () => boundWorkspace,
    getActiveExtensions: () => [],
  } as unknown as Record<string | symbol, unknown>;
  const guarded = new Proxy(stub, {
    get(target, prop) {
      if (prop in target) {
        return (target as Record<string | symbol, unknown>)[prop];
      }
      // `then` is queried by Promise resolution machinery on object
      // returns; returning undefined keeps async paths happy without
      // implementing every Config method.
      if (prop === 'then') return undefined;
      throw new Error(
        `qwen serve workspace agents: SubagentManager touched Config.` +
          `${String(prop)} which the daemon stub does not implement. ` +
          `Add it to createDaemonSubagentManager and audit safety.`,
      );
    },
    // Mirror the `get` trap. Without a `has` trap, a SubagentManager
    // path that does `if ('someMethod' in this.config)` would consult
    // `Reflect.has(target, prop)` directly and silently return false
    // for unimplemented methods — bypassing the throw the `get` trap
    // is supposed to surface. With the trap, an `in` check on an
    // unknown method throws the same way a property access would, so
    // both code paths behave consistently.
    has(target, prop) {
      if (prop in target) return true;
      // Allow `'then' in obj` so the runtime's thenable-detection
      // continues to behave correctly.
      if (prop === 'then') return false;
      throw new Error(
        `qwen serve workspace agents: SubagentManager probed Config.` +
          `${String(prop)} via 'in' check; the daemon stub does not ` +
          `implement it. Add it to createDaemonSubagentManager and ` +
          `audit safety.`,
      );
    },
  }) as unknown as Config;
  return new SubagentManager(guarded);
}

// Re-export the bridge error type used by route helpers so test files
// can import it from a single module without reaching into
// httpAcpBridge directly.
export { InvalidClientIdError };
