/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
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
import { isServeDebugMode } from './debug-mode.js';
import {
  InvalidClientIdError,
  type AcpSessionBridge,
} from './acp-session-bridge.js';

/**
 * Pattern for the route-layer `:agentType` URL parameter. Matches the
 * `SubagentValidator.validateName` regex (`^[\p{L}\p{N}_-]+$`) so a
 * malformed path component (containing slashes, dots, control chars,
 * leading hyphen) is rejected at the boundary instead of trickling
 * through `findSubagentByNameAtLevel`'s readdir scan. Defense in
 * depth — `findSubagentByNameAtLevel` already prevents path traversal
 * via filename matching, but failing fast at the route layer keeps
 * surprising inputs out of downstream code paths.
 */
const AGENT_TYPE_PATTERN = /^[\p{L}\p{N}_-]+$/u;

/**
 * Cap on the route-layer name validator. SubagentValidator caps
 * payload-side names at 50 chars; the route check uses 64 to leave a
 * little headroom for legacy on-disk agents created with a longer
 * name (resolved via case-insensitive cascade) that a client tries
 * to GET / DELETE through the URL.
 */
const AGENT_TYPE_MAX_LENGTH = 64;

/**
 * Minimum agent-name length. Matches `SubagentValidator.validateName`
 * (which requires `trimmedName.length >= 2`). Keeping the same lower
 * bound at the route layer surfaces the constraint as a 422 instead
 * of letting core throw `VALIDATION_ERROR` (which the route also
 * 422s, but with a less specific message).
 */
const AGENT_TYPE_MIN_LENGTH = 2;

/**
 * Per-field size caps for create + update payloads. The Express body
 * parser caps the whole request at 10 MB but no per-field guard
 * existed, so a single payload could land a multi-megabyte
 * `systemPrompt` on disk and balloon every `GET /workspace/agents`
 * snapshot in memory. 256 KB is far above any realistic
 * user-authored prompt while keeping list-response cost bounded.
 */
const MAX_DESCRIPTION_BYTES = 256 * 1024;
const MAX_SYSTEM_PROMPT_BYTES = 256 * 1024;
const MAX_TOOLS_ENTRIES = 256;
const MAX_TOOL_ID_LENGTH = 256;
import {
  STATUS_SCHEMA_VERSION,
  type ServeWorkspaceAgentDetail,
  type ServeWorkspaceAgentSummary,
  type ServeWorkspaceAgentsStatus,
} from './status.js';

/**
 * Workspace subagent CRUD routes.
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
  bridge: AcpSessionBridge;
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
      //
      // No TTL cache or `fs.watch`-based invalidation here despite the
      // 4-level walk per request. Reasoning:
      //   - 4 levels × <50 agents on local SSD = sub-ms IO, well below
      //     the per-request budget for any client UI.
      //   - A short-TTL cache would re-introduce the exact stale-list
      //     bug that was previously fixed (a recently-edited file invisible
      //     until the TTL elapses); invalidation logic adds state to
      //     the route handler that the audit / policy / mediator layer
      //     is the proper home for.
      //   - `fs.watch` is platform-fragile (recursive watch broken on
      //     some macOS Node versions, inotify limits on Linux) and the
      //     daemon's per-request semantics make watchers harder to
      //     reason about than a fresh disk read.
      //   - Burst protection lives at `--max-connections` (256) +
      //     bearer auth on non-loopback, not at the route layer.
      // Revisit if profiling shows the LIST route is on the hot path.
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
            // `SubagentError(FILE_ERROR)` wraps Node fs error
            // messages like `"ENOENT: no such file or directory, open
            // '/Users/<x>/.qwen/agents/foo.md'"` — leaking the
            // operator's absolute filesystem layout through an
            // authenticated route response. Gate the message behind
            // `QWEN_SERVE_DEBUG` so default production responses
            // carry only the generic envelope; operators triaging
            // locally enable the toggle to get the path back.
            // Mirrors the workspaceMemory route's `file_error`
            // disclosure posture.
            const debug = isServeDebugMode();
            res.status(500).json({
              error: debug
                ? err.message
                : 'Failed to write workspace agent file',
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
        // agent on next request. PermissionMediator can layer
        // a proper rollback policy on top once mutation auditing
        // arrives.
        writeStderrLine(
          `qwen serve: agent_create_reload_failed (name=${safeLogValue(config.name)} ` +
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

  app.post(
    '/workspace/agents/generate',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const body = deps.safeBody(req);
      const clientIdResult = resolveOriginatorClientId(deps, req, res);
      if (clientIdResult === null) return;
      const originatorClientId = clientIdResult;
      const description = body['description'];
      if (typeof description !== 'string' || description.trim().length === 0) {
        res.status(400).json({
          error: '`description` must be a non-empty string',
          code: 'invalid_description',
        });
        return;
      }
      if (Buffer.byteLength(description, 'utf8') > 4096) {
        res.status(400).json({
          error: '`description` exceeds the 4096-byte limit',
          code: 'invalid_description',
        });
        return;
      }
      try {
        const generated = await deps.bridge.generateWorkspaceAgent(
          description.trim(),
          originatorClientId,
        );
        res.status(200).json(generated);
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /workspace/agents/generate failed: ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to generate workspace agent',
          code: 'agent_generate_failed',
        });
      }
    },
  );

  app.get('/workspace/agents/:agentType', async (req, res) => {
    const agentType = validateAgentType(req, res);
    if (agentType === null) return;
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
        `qwen serve: GET /workspace/agents/${safeLogValue(agentType)} failed: ${
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
      const agentType = validateAgentType(req, res);
      if (agentType === null) return;
      const clientIdResult = resolveOriginatorClientId(deps, req, res);
      if (clientIdResult === null) return;
      const originatorClientId = clientIdResult;

      const body = deps.safeBody(req);
      const updates = parseAgentUpdates(body, res);
      if (!updates) return;

      const preferredLevel = parseScopeQuery(req, res);
      if (preferredLevel === null) return;

      const existing = await manager.loadSubagent(agentType, preferredLevel);
      if (!existing) {
        res.status(404).json({
          error: `Subagent "${agentType}" not found`,
          code: 'agent_not_found',
          name: agentType,
        });
        return;
      }
      if (assertMutableLevel(existing, agentType, res)) {
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
            // Same path-disclosure gating as the create-path
            // FILE_ERROR handler above. Default response is the
            // generic envelope; `QWEN_SERVE_DEBUG` re-enables the
            // raw `err.message` for local triage.
            const debug = isServeDebugMode();
            res.status(500).json({
              error: debug
                ? err.message
                : 'Failed to write workspace agent file',
              code: 'file_error',
              name: err.subagentName ?? agentType,
            });
            return;
          }
        }
        writeStderrLine(
          `qwen serve: POST /workspace/agents/${safeLogValue(agentType)} failed: ${
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
          `qwen serve: agent_update_reload_failed (name=${safeLogValue(agentType)} ` +
            `level=${existing.level}) — disk write completed; check ` +
            `\`GET /workspace/agents/${safeLogValue(agentType)}\` for the new state`,
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
      const agentType = validateAgentType(req, res);
      if (agentType === null) return;
      const clientIdResult = resolveOriginatorClientId(deps, req, res);
      if (clientIdResult === null) return;
      const originatorClientId = clientIdResult;

      const scopedLevel = parseScopeQuery(req, res);
      if (scopedLevel === null) return;

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
        if (assertMutableLevel(found, agentType, res)) return;
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
          `qwen serve: DELETE /workspace/agents/${safeLogValue(agentType)} failed: ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to delete workspace agent',
          code: 'agent_delete_failed',
        });
        return;
      }

      // `SubagentManager.deleteSubagent` swallows per-level
      // `fs.unlink()` failures and
      // returns success as long as ANY level was removed. Trusting
      // that signal would let us publish `agent_changed`/`deleted`
      // for a file still on disk (EACCES / EBUSY / EPERM) — the
      // client UI would drop a still-active definition from cache.
      // Verify each pre-checked level's file is actually gone via
      // `fs.access`; only fan out the event for confirmed removals.
      // If at least one level still has its file, return 500 with
      // the residual list so callers can act.
      const removed: SubagentConfig[] = [];
      const remaining: SubagentConfig[] = [];
      for (const found of existingAtLevels) {
        if (!found.filePath) {
          // Synthetic / no-file entries (impossible at project /
          // user levels, defensive guard) treat as "no verification
          // possible" → assume removed to match legacy behavior.
          removed.push(found);
          continue;
        }
        try {
          await fs.access(found.filePath);
          // Still present → unlink failed silently.
          remaining.push(found);
        } catch {
          // Any access error (typically ENOENT) means the file is
          // gone — count as successfully removed.
          removed.push(found);
        }
      }

      if (remaining.length > 0) {
        writeStderrLine(
          `qwen serve: DELETE /workspace/agents/${safeLogValue(agentType)} partial — ` +
            `removed=${removed.map((r) => r.level).join(',') || 'none'} ` +
            `remaining=${remaining
              .map((r) => `${r.level}:${r.filePath}`)
              .join(',')}`,
        );
        // Still publish events for files we DID remove so subscribers
        // get partial-success signals — but emit them BEFORE the 500
        // so a client reading the response can correlate.
        for (const found of removed) {
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
        res.status(500).json({
          error:
            `Failed to delete every level of subagent "${agentType}" — ` +
            `${remaining.length} level(s) still have their file on disk`,
          code: 'agent_delete_partial',
          name: agentType,
          removedLevels: removed.map((r) => r.level),
          remainingLevels: remaining.map((r) => r.level),
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
        for (const found of removed) {
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

/**
 * Wrap a string value for safe interpolation into stderr log lines.
 * `JSON.stringify` escapes control characters (`\n`, `\r`, etc.) and
 * wraps the result in quotes so any injection attempt surfaces as
 * visible-as-quoted-noise rather than a forged log line. Mirrors
 * `safeLogValue` in `server.ts` (kept private there); we copy the
 * 82-byte truncation budget so attacker-controlled long names can't
 * blow up the operator's log shipper. Defense-in-depth — the
 * route's `validateAgentType` regex already rejects names with
 * control chars, but escaping also covers `agentType` derived from
 * sources we don't fully control (legacy on-disk shadows, future
 * routes adding new fields).
 */
function safeLogValue(raw: unknown): string {
  return JSON.stringify(String(raw)).slice(0, 82);
}

/**
 * Pull `:agentType` off the request and reject malformed values at
 * the route boundary. Returns the validated string, or `null` AFTER
 * sending its own 400 — caller must short-circuit on `null`.
 */
function validateAgentType(req: Request, res: Response): string | null {
  const raw = req.params['agentType'];
  if (!raw || raw.length === 0) {
    res.status(400).json({
      error: '`agentType` path parameter is required',
      code: 'invalid_agent_type',
    });
    return null;
  }
  if (raw.length > AGENT_TYPE_MAX_LENGTH || !AGENT_TYPE_PATTERN.test(raw)) {
    res.status(400).json({
      error:
        '`agentType` must contain only letters, numbers, hyphens, or underscores (max 64 chars)',
      code: 'invalid_agent_type',
      agentType: raw,
    });
    return null;
  }
  return raw;
}

/**
 * Read the `?scope=` query, fail-closed on repeated/non-string
 * values, and translate `workspace`/`global` into the
 * `SubagentLevel` the manager expects. Returns:
 *   - `undefined` when `scope` is absent (caller falls back to default
 *     resolution / both levels);
 *   - the resolved `SubagentLevel` when valid;
 *   - `null` when the query was malformed AND the response was
 *     already sent — caller must short-circuit.
 *
 * Centralizes the duplicated parser block from the POST update +
 * DELETE handlers so a future scope addition (e.g. `extension`)
 * stays in one place.
 */
function parseScopeQuery(
  req: Request,
  res: Response,
): SubagentLevel | undefined | null {
  const raw = req.query['scope'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    res.status(400).json({
      error: '`scope` query must be a single "workspace" or "global" value',
      code: 'invalid_scope',
    });
    return null;
  }
  if (raw !== 'workspace' && raw !== 'global') {
    res.status(400).json({
      error: '`scope` query must be "workspace" or "global"',
      code: 'invalid_scope',
    });
    return null;
  }
  return raw === 'workspace' ? 'project' : 'user';
}

/**
 * Reject mutation attempts targeting a read-only agent
 * (built-in / extension / session). Returns `true` after sending
 * the 403 — caller must short-circuit on `true`. Returns `false`
 * when the entry is mutable (`project` / `user`).
 *
 * Centralizes the duplicated guard from the POST update + DELETE
 * handlers; a future PR adding a new mutation route just calls this
 * helper instead of re-implementing the predicate.
 */
function assertMutableLevel(
  found: SubagentConfig,
  agentType: string,
  res: Response,
): boolean {
  if (
    found.isBuiltin ||
    found.level === 'builtin' ||
    found.level === 'extension' ||
    found.level === 'session'
  ) {
    res.status(403).json({
      error: `Cannot modify ${found.level}-level subagent "${agentType}"`,
      code: 'agent_readonly',
      name: found.name,
      level: found.level,
    });
    return true;
  }
  return false;
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
  // Apply the same regex + length contract `validateAgentType` uses
  // for `:agentType` URL parameters. Without this, a client could
  // `POST /workspace/agents` with `name: "my/agent"` or
  // `name: "a".repeat(100)` — names that the route's regex would
  // reject if echoed back through GET / DELETE, plus the core's
  // `SubagentValidator` would reject with a different error shape.
  // Failing at the body-validation boundary keeps the round-trip
  // (POST → GET → DELETE) coherent under one error shape.
  if (
    name.length < AGENT_TYPE_MIN_LENGTH ||
    name.length > AGENT_TYPE_MAX_LENGTH ||
    !AGENT_TYPE_PATTERN.test(name)
  ) {
    res.status(422).json({
      error: `\`name\` must be ${AGENT_TYPE_MIN_LENGTH}-${AGENT_TYPE_MAX_LENGTH} characters of letters, numbers, hyphens, or underscores`,
      code: 'invalid_config',
      name,
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
  if (Buffer.byteLength(description, 'utf8') > MAX_DESCRIPTION_BYTES) {
    res.status(422).json({
      error: `\`description\` exceeds the ${MAX_DESCRIPTION_BYTES}-byte limit`,
      code: 'invalid_config',
    });
    return undefined;
  }
  const systemPrompt = body['systemPrompt'];
  if (typeof systemPrompt !== 'string' || systemPrompt.trim().length === 0) {
    // Reject whitespace-only systemPrompts to match the description
    // field's `trim().length === 0` rule. A pure-whitespace prompt
    // would land on disk as effectively empty (the YAML serializer
    // collapses blank lines), and the agent can't operate without
    // instructions, so a 422 at the boundary is friendlier than a
    // mysterious downstream "agent does nothing" failure.
    res.status(422).json({
      error:
        '`systemPrompt` is required and must be a non-empty string (whitespace only is rejected)',
      code: 'invalid_config',
    });
    return undefined;
  }
  if (Buffer.byteLength(systemPrompt, 'utf8') > MAX_SYSTEM_PROMPT_BYTES) {
    res.status(422).json({
      error: `\`systemPrompt\` exceeds the ${MAX_SYSTEM_PROMPT_BYTES}-byte limit`,
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
    const value = body['description'];
    // Match the create-side rule: `description` is required and
    // non-empty after trim. The previous update path silently
    // accepted `"   "` and let `mergeConfigurations` write a blank
    // description to the file — divergent from create which would
    // 422 the same payload.
    if (typeof value !== 'string' || value.trim().length === 0) {
      res.status(422).json({
        error:
          '`description` must be a non-empty string (whitespace only is rejected) when provided',
        code: 'invalid_config',
      });
      return undefined;
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_DESCRIPTION_BYTES) {
      res.status(422).json({
        error: `\`description\` exceeds the ${MAX_DESCRIPTION_BYTES}-byte limit`,
        code: 'invalid_config',
      });
      return undefined;
    }
    updates.description = value;
  }
  if ('systemPrompt' in body) {
    const value = body['systemPrompt'];
    if (typeof value !== 'string' || value.trim().length === 0) {
      // Mirror create's `systemPrompt.trim().length === 0` check.
      // A whitespace-only prompt is effectively empty after YAML
      // serialization and the agent can't operate without
      // instructions, so reject at the boundary.
      res.status(422).json({
        error:
          '`systemPrompt` must be a non-empty string (whitespace only is rejected) when provided',
        code: 'invalid_config',
      });
      return undefined;
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_SYSTEM_PROMPT_BYTES) {
      res.status(422).json({
        error: `\`systemPrompt\` exceeds the ${MAX_SYSTEM_PROMPT_BYTES}-byte limit`,
        code: 'invalid_config',
      });
      return undefined;
    }
    updates.systemPrompt = value;
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
  if (value.length > MAX_TOOLS_ENTRIES) {
    res.status(422).json({
      error: `\`${field}\` exceeds the ${MAX_TOOLS_ENTRIES}-entry limit`,
      code: 'invalid_config',
    });
    return null;
  }
  if ((value as string[]).some((v) => v.length > MAX_TOOL_ID_LENGTH)) {
    res.status(422).json({
      error: `\`${field}\` entries must be at most ${MAX_TOOL_ID_LENGTH} characters`,
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
    // `SubagentManager.mergeConfigurations` MERGES `updates.runConfig`
    // with `existing.runConfig` (existing keys preserved when not in
    // updates), so the no-op check must compare only the keys the
    // caller actually intends to change. Comparing every known field
    // against `existing` would treat any partial update as non-no-op
    // because absent keys would be `undefined` while existing has a
    // value — a false positive that would re-emit `agent_changed`
    // for a request that didn't actually mutate anything.
    const e = existing.runConfig ?? {};
    const u = updates.runConfig;
    if ('max_time_minutes' in u) {
      if (u['max_time_minutes'] !== e['max_time_minutes']) return false;
    }
    if ('max_turns' in u) {
      if (u['max_turns'] !== e['max_turns']) return false;
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

export function toSummary(config: SubagentConfig): ServeWorkspaceAgentSummary {
  const summary: ServeWorkspaceAgentSummary = {
    kind: 'agent',
    name: config.name,
    description: config.description,
    level: config.level,
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

export function toDetail(config: SubagentConfig): ServeWorkspaceAgentDetail {
  const detail: ServeWorkspaceAgentDetail = {
    ...toSummary(config),
    systemPrompt: config.systemPrompt,
  };
  if (config.tools) detail.tools = [...config.tools];
  if (config.disallowedTools) {
    detail.disallowedTools = [...config.disallowedTools];
  }
  if (config.runConfig) {
    // Explicit field pick rather than spread-with-cast. If
    // `SubagentConfig.runConfig` gains new fields in core, the
    // spread-then-cast pattern would silently leak them through the
    // HTTP response without a compile error. Picking `max_time_minutes`
    // and `max_turns` by name forces a deliberate schema bump if a
    // future core field needs to surface on the daemon route.
    const runConfig: ServeWorkspaceAgentDetail['runConfig'] = {};
    if (typeof config.runConfig.max_time_minutes === 'number') {
      runConfig.max_time_minutes = config.runConfig.max_time_minutes;
    }
    if (typeof config.runConfig.max_turns === 'number') {
      runConfig.max_turns = config.runConfig.max_turns;
    }
    detail.runConfig = runConfig;
  }
  return detail;
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
// acp-session-bridge directly.
export { InvalidClientIdError };
