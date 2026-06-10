/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';
import { SESSION_READ, WRITE, APPROVE, type RcScope } from '../scopes.js';
import type { CommandLoader, CommandScope } from '../commands/loader.js';
import { substitute } from '../commands/parse.js';

/** Map a command's declared scope to the gateway RcScope used for gating. */
export function mapDeclaredScope(scope: CommandScope): RcScope {
  switch (scope) {
    case 'read':
      return SESSION_READ;
    case 'write':
      return WRITE;
    case 'approve':
      return APPROVE;
    default:
      return WRITE;
  }
}

/**
 * GET /rc/commands — list declared command metadata. Commands above the
 * caller's scope are listed (not hidden) with `invocableByYou:false` so a
 * palette can gray them out. `invocableByYou` mirrors the invoke gate exactly:
 * caller has WRITE ∧ caller has mapped(declared scope) ∧ command has no tool.
 */
export function createListCommandsRoute(loader: CommandLoader): RequestHandler {
  return async (req, res) => {
    const cmds = await loader.load();
    const s = req.rcClient?.scopes ?? [];
    const commands = cmds.map((c) => ({
      name: c.name,
      description: c.description,
      scope: c.scope,
      tool: c.tool ?? null,
      sessionScope: c.sessionScope,
      args: c.args ?? null,
      source: c.source,
      invocableByYou:
        s.includes(WRITE) && s.includes(mapDeclaredScope(c.scope)) && !c.tool,
    }));
    res.status(200).json({ v: 1, commands });
  };
}

/**
 * POST /rc/session/:id/command/:name — resolve a command's body template and
 * post it as a normal session prompt via `daemon.prompt()`. Mounted behind the
 * session pipeline (requireScope(WRITE) → recordActivity → enforceSessionLock).
 */
export function createInvokeCommandRoute(
  daemon: DaemonClient,
  loader: CommandLoader,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const cmds = await loader.load();
    const cmd = cmds.find((c) => c.name === req.params.name);
    if (!cmd) {
      res
        .status(404)
        .json({ error: 'Unknown command', code: 'unknown_command' });
      return;
    }
    if (cmd.tool) {
      res.status(400).json({
        error: 'Direct tool invocation is not supported',
        code: 'direct_tool_unsupported',
      });
      return;
    }

    const s = req.rcClient?.scopes ?? [];
    const required = mapDeclaredScope(cmd.scope);
    if (!s.includes(required)) {
      void audit?.record({
        action: 'scope_denied',
        actorTokenId: req.rcClient?.id,
        detail: { required },
      });
      res
        .status(403)
        .json({ error: 'Insufficient scope', code: 'insufficient_scope' });
      return;
    }

    const body = (req.body ?? {}) as {
      args?: unknown;
      named?: unknown;
      fileContext?: unknown;
    };
    const args: string[] = Array.isArray(body.args)
      ? body.args.map((a) => String(a))
      : typeof body.args === 'string'
        ? body.args.split(/\s+/).filter((a) => a.length > 0)
        : [];
    const named: Record<string, string> = {};
    if (
      body.named &&
      typeof body.named === 'object' &&
      !Array.isArray(body.named)
    ) {
      for (const [k, v] of Object.entries(
        body.named as Record<string, unknown>,
      )) {
        named[k] = String(v);
      }
    }
    const fileContext =
      typeof body.fileContext === 'string' ? body.fileContext : undefined;
    const argc = args.length;

    // Validate declared positional args: fill defaults, collect missing-required.
    // A value is "present" when args[i] is a non-empty string.
    const resolvedArgs = [...args];
    const missing: string[] = [];
    if (cmd.args) {
      cmd.args.forEach((decl, i) => {
        if (typeof resolvedArgs[i] === 'string' && resolvedArgs[i] !== '') {
          return;
        }
        if (decl.default !== undefined) {
          resolvedArgs[i] = decl.default;
        } else if (decl.required) {
          missing.push(decl.name);
        }
      });
    }
    if (missing.length > 0) {
      void audit?.record({
        action: 'slash_command_arg_missing',
        actorTokenId: req.rcClient?.id,
        target: req.params.id,
        detail: { name: cmd.name, missing },
      });
      res.status(400).json({
        error: `Missing required argument(s): ${missing.join(', ')}`,
        code: 'missing_required_args',
      });
      return;
    }

    const text = substitute(cmd.body, {
      args: resolvedArgs,
      named,
      file: fileContext,
    });

    // Abort the (long-lived) daemon turn if the client disconnects. Listen on
    // the response, not the request — identical to the prompt route.
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    let result;
    try {
      result = await daemon.prompt(
        req.params.id,
        { prompt: [{ type: 'text', text }] },
        controller.signal,
      );
    } catch {
      if (controller.signal.aborted) return;
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    if (controller.signal.aborted) return;

    void audit?.record({
      action: 'slash_command_invoked',
      actorTokenId: req.rcClient?.id,
      target: req.params.id,
      detail: { name: cmd.name, stopReason: result.stopReason, argc },
    });

    res.status(200).json({ stopReason: result.stopReason });
  };
}
