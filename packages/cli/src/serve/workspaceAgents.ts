/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import {
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

      const scopeQuery =
        typeof req.query['scope'] === 'string' ? req.query['scope'] : undefined;
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
      res.status(200).json({ ok: true, agent: toDetail(updated) });
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

      const scopeQuery =
        typeof req.query['scope'] === 'string' ? req.query['scope'] : undefined;
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

      // Pre-check the kind of agent so we can return 403 for read-only
      // entries (built-in / extension) instead of letting deleteSubagent
      // throw INVALID_CONFIG and conflating it with validation failures.
      const existing = await manager.loadSubagent(agentType, scopedLevel);
      if (existing) {
        if (
          existing.isBuiltin ||
          existing.level === 'builtin' ||
          existing.level === 'extension' ||
          existing.level === 'session'
        ) {
          res.status(403).json({
            error: `Cannot delete ${existing.level}-level subagent "${agentType}"`,
            code: 'agent_readonly',
            name: existing.name,
            level: existing.level,
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
      const eventLevel: 'project' | 'user' =
        existing && existing.level === 'project' ? 'project' : 'user';
      deps.bridge.publishWorkspaceEvent({
        type: 'agent_changed',
        data: {
          change: 'deleted',
          name: existing?.name ?? agentType,
          level: eventLevel,
        },
        ...(originatorClientId ? { originatorClientId } : {}),
      });
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
  const name = body['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    res.status(422).json({
      error: '`name` is required and must be a non-empty string',
      code: 'invalid_config',
    });
    return undefined;
  }
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
  if (typeof body['model'] === 'string') config.model = body['model'];
  if (typeof body['color'] === 'string') config.color = body['color'];
  if (typeof body['approvalMode'] === 'string') {
    config.approvalMode = body['approvalMode'];
  }
  if (typeof body['background'] === 'boolean') {
    config.background = body['background'];
  }
  const runConfig = body['runConfig'];
  if (runConfig !== undefined) {
    if (
      typeof runConfig !== 'object' ||
      runConfig === null ||
      Array.isArray(runConfig)
    ) {
      res.status(422).json({
        error: '`runConfig` must be an object when provided',
        code: 'invalid_config',
      });
      return undefined;
    }
    config.runConfig = runConfig as SubagentConfig['runConfig'];
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
  if ('model' in body && typeof body['model'] === 'string') {
    updates.model = body['model'];
  }
  if ('color' in body && typeof body['color'] === 'string') {
    updates.color = body['color'];
  }
  if ('approvalMode' in body && typeof body['approvalMode'] === 'string') {
    updates.approvalMode = body['approvalMode'];
  }
  if ('background' in body && typeof body['background'] === 'boolean') {
    updates.background = body['background'];
  }
  if ('runConfig' in body) {
    const runConfig = body['runConfig'];
    if (
      typeof runConfig !== 'object' ||
      runConfig === null ||
      Array.isArray(runConfig)
    ) {
      res.status(422).json({
        error: '`runConfig` must be an object when provided',
        code: 'invalid_config',
      });
      return undefined;
    }
    updates.runConfig = runConfig as SubagentConfig['runConfig'];
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
  }) as unknown as Config;
  return new SubagentManager(guarded);
}

// Re-export the bridge error type used by route helpers so test files
// can import it from a single module without reaching into
// httpAcpBridge directly.
export { InvalidClientIdError };
