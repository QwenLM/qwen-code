/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import type { Policy } from '../policy/loader.js';
import { POLICY_OPERATIONS } from '../policy/loader.js';
import type { QuotaOracle, ToolCallContext } from '../policy/evaluator.js';
import { explainPolicy } from '../policy/evaluator.js';

/** Live handles the route needs, resolved per request (policy hot-reloads). */
export interface PolicyExplainAccess {
  /** Current (hot-reloaded) policy, or undefined when none is loaded. */
  policy(): Policy | undefined;
  /** Trusted pathGlob anchor — the gateway's own workspace, never body-supplied. */
  projectRoot(): string;
  /** Live quota oracle, or undefined (dry-run: maxPerWindow → prompt). */
  quotaOracle?(): QuotaOracle | undefined;
}

export interface PolicyExplainRouteDeps {
  audit?: AuditRecorder;
}

/** The accepted request body (all fields optional except `tool`). */
export interface PolicyExplainBody {
  tool?: unknown;
  args?: unknown;
  path?: unknown;
  operation?: unknown;
  scope?: unknown;
  tag?: unknown;
}

/** Thrown by {@link buildExplainContext} on an invalid `operation` value. */
export class ExplainBodyError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Map a JSON body to the evaluator's `ToolCallContext`, mirroring the
 * `policy explain` CLI (explain.ts): `path` becomes `paths:[path]` and is
 * merged into `args.path` when absent; `operation` accepts a comma string or
 * an array and each value is validated against read|write|execute. The
 * `projectRoot` is the gateway's own — the body cannot set it.
 */
export function buildExplainContext(
  body: PolicyExplainBody,
  projectRoot: string,
): ToolCallContext {
  const tool = typeof body.tool === 'string' ? body.tool : '';
  let args: unknown = body.args;
  const path = typeof body.path === 'string' ? body.path : undefined;
  if (path !== undefined) {
    if (isPlainObject(args)) {
      if (args['path'] === undefined) args['path'] = path;
    } else if (args === undefined) {
      args = { path };
    }
  }

  let operations: string[] | undefined;
  if (body.operation !== undefined) {
    const items = Array.isArray(body.operation)
      ? body.operation
      : [body.operation];
    if (!items.every((v): v is string => typeof v === 'string')) {
      throw new ExplainBodyError(
        'operation must be a string or an array of strings',
      );
    }
    const raw = items
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    for (const o of raw) {
      if (!(POLICY_OPERATIONS as readonly string[]).includes(o)) {
        throw new ExplainBodyError(
          `invalid operation '${o}'; expected one of ${POLICY_OPERATIONS.join(' | ')}`,
        );
      }
    }
    operations = raw;
  }

  const ctx: ToolCallContext = { tool, projectRoot, cwd: projectRoot };
  if (path !== undefined) ctx.paths = [path];
  if (args !== undefined) ctx.args = args;
  if (operations !== undefined) ctx.operations = operations;
  if (typeof body.scope === 'string') ctx.originScope = body.scope;
  if (typeof body.tag === 'string') ctx.sessionTag = body.tag;
  return ctx;
}

/**
 * `POST /policy/explain` — owner-only (enforced at the mount), read-only
 * dry-run against the live policy. No daemon call, no mutation. The response
 * ({ decision, trace }) reflects the caller's path/args only as closed-enum
 * classification tokens — never as values.
 */
export function createPolicyExplainRoute(
  access: PolicyExplainAccess,
  deps: PolicyExplainRouteDeps = {},
): RequestHandler {
  return (req, res) => {
    try {
      const body = (req.body ?? {}) as PolicyExplainBody;
      if (typeof body.tool !== 'string' || body.tool.length === 0) {
        res.status(400).json({ error: 'Missing tool', code: 'invalid_tool' });
        return;
      }
      let ctx: ToolCallContext;
      try {
        ctx = buildExplainContext(body, access.projectRoot());
      } catch (err) {
        if (err instanceof ExplainBodyError) {
          res
            .status(400)
            .json({ error: err.message, code: 'invalid_operation' });
          return;
        }
        throw err;
      }

      const policy = access.policy();
      if (!policy) {
        res
          .status(503)
          .json({ error: 'No policy loaded', code: 'policy_unavailable' });
        return;
      }

      const exp = explainPolicy(
        policy,
        ctx,
        new Date(),
        access.quotaOracle?.(),
      );

      void deps.audit?.record({
        action: 'policy_explained',
        actorTokenId: req.rcClient?.id,
        subActor: req.rcClient?.subActor,
        detail: {
          tool: ctx.tool,
          decision: exp.decision.action,
          ...(exp.decision.ruleId ? { ruleId: exp.decision.ruleId } : {}),
        },
      });

      res.status(200).json({ decision: exp.decision, trace: exp.trace });
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Policy explain failed',
          code: 'policy_explain_failed',
        });
      }
    }
  };
}
