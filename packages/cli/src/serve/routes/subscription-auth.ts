/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Application, RequestHandler } from 'express';
import { QwenSubscriptionSession } from '@qwen-code/qwen-code-core/qwen/subscription-session.js';
import {
  SubscriptionOAuthError,
  subscriptionError,
  type SubscriptionUserInfo,
} from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import {
  getQwenOAuthConfig,
  getQwenSubscriptionPlansUrl,
} from '@qwen-code/qwen-code-core/qwen/oauth-config.js';
import type { DaemonSubscriptionFlow } from '@qwen-code/sdk/daemon';

const PUBLIC_ERRORS = new Set([
  'access_denied',
  'expired_token',
  'invalid_grant',
  'invalid_token',
  'session_changed',
  'invalid_client',
  'invalid_scope',
  'invalid_request',
  'unsupported_grant_type',
  'invalid_response',
  'rate_limited',
  'network_error',
  'request_timeout',
  'credentials_error',
  'server_error',
  'temporarily_unavailable',
]);
function errorCode(error: unknown): string {
  return error instanceof SubscriptionOAuthError &&
    PUBLIC_ERRORS.has(error.code)
    ? error.code
    : 'authentication_failed';
}
function errorDetails(error: unknown) {
  return error instanceof SubscriptionOAuthError
    ? {
        ...(error.stage ? { errorStage: error.stage } : {}),
        ...(error.status ? { errorStatus: error.status } : {}),
        ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
      }
    : {};
}
function publicUser(info: SubscriptionUserInfo): SubscriptionUserInfo {
  return {
    sub: info.sub,
    name: info.name,
    email: info.email,
    member_type: info.member_type,
  };
}

// Process-global account credentials belong to the daemon's QWEN_HOME, never a workspace runtime.
export function registerSubscriptionAuthRoutes(
  app: Application,
  mutate: (opts?: { strict?: boolean }) => RequestHandler,
): () => void {
  const enabled = process.env['DEV'] === 'true';
  const { webOrigin } = getQwenOAuthConfig();
  const plansUrl = enabled ? getQwenSubscriptionPlansUrl() : undefined;
  const flows = new Map<
    string,
    {
      view: DaemonSubscriptionFlow;
      controller: AbortController;
      timer: NodeJS.Timeout | undefined;
    }
  >();
  const queries = new Set<AbortController>();
  let disposed = false;
  let signingOut = false;
  const allowed: RequestHandler = (_req, res, next) => {
    if (!enabled || disposed) {
      res.status(404).json({ code: 'subscription_unavailable' });
      return;
    }
    next();
  };
  const cancel = (id: string) => {
    const flow = flows.get(id);
    if (!flow) return;
    flow.controller.abort();
    clearTimeout(flow.timer);
    flows.delete(id);
  };

  app.get('/auth/subscription', (_req, res) => {
    res.json({
      enabled: enabled && !disposed,
      ...(plansUrl ? { plansUrl } : {}),
    });
  });
  app.post(
    '/auth/subscription/flows',
    mutate({ strict: true }),
    allowed,
    (_req, res) => {
      if (signingOut) {
        res.status(409).json({ code: 'session_changed' });
        return;
      }
      if (flows.size >= 8) {
        res.status(429).json({ code: 'too_many_flows' });
        return;
      }
      const id = randomUUID();
      const controller = new AbortController();
      const flow = {
        view: { id, status: 'waiting' } as DaemonSubscriptionFlow,
        controller,
        timer: undefined as NodeJS.Timeout | undefined,
      };
      flows.set(id, flow);
      res.status(201).json(flow.view);
      const finish = (view: DaemonSubscriptionFlow) => {
        clearTimeout(flow.timer);
        flow.view = view;
        flow.timer = setTimeout(() => cancel(id), 60_000);
        flow.timer.unref();
      };
      const run = async () => {
        const session = new QwenSubscriptionSession();
        const user =
          (await session.getUserInfo(controller.signal)) ??
          (await session.signIn((device) => {
            controller.signal.throwIfAborted();
            const url = new URL('/authorize', webOrigin);
            url.searchParams.set('user_code', device.user_code);
            url.searchParams.set('client', 'qwen-code');
            const authorizationUrl = url.toString();
            flow.view = { id, status: 'waiting', authorizationUrl };
          }, controller.signal));
        controller.signal.throwIfAborted();
        finish({ id, status: 'ready', userInfo: publicUser(user) });
      };
      void run().catch((error: unknown) => {
        if (!controller.signal.aborted)
          finish({
            id,
            status: 'error',
            errorCode: errorCode(error),
            ...errorDetails(error),
          });
      });
    },
  );
  app.get('/auth/subscription/flows/:id', allowed, (req, res) => {
    const flow = flows.get(req.params['id'] ?? '');
    if (!flow) {
      res.status(404).json({ code: 'flow_not_found' });
      return;
    }
    res.json(flow.view);
  });
  app.delete(
    '/auth/subscription/flows/:id',
    mutate({ strict: true }),
    allowed,
    (req, res) => {
      cancel(req.params['id'] ?? '');
      res.status(204).end();
    },
  );
  app.post(
    '/auth/subscription/userinfo',
    mutate({ strict: true }),
    allowed,
    async (_req, res) => {
      if (signingOut) {
        res.status(409).json({ code: 'session_changed' });
        return;
      }
      const controller = new AbortController();
      queries.add(controller);
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', disconnect);
      try {
        const info = await new QwenSubscriptionSession().getUserInfo(
          controller.signal,
        );
        controller.signal.throwIfAborted();
        res.json(info ? publicUser(info) : null);
      } catch (error) {
        if (!res.destroyed) {
          res.status(controller.signal.aborted ? 409 : 502).json({
            code: controller.signal.aborted
              ? 'session_changed'
              : errorCode(error),
            ...errorDetails(error),
          });
        }
      } finally {
        queries.delete(controller);
        res.off('close', disconnect);
      }
    },
  );
  app.post(
    '/auth/subscription/revoke',
    mutate({ strict: true }),
    allowed,
    async (_req, res) => {
      if (signingOut) {
        res.status(409).json({ code: 'session_changed' });
        return;
      }
      signingOut = true;
      for (const id of flows.keys()) cancel(id);
      for (const query of queries) query.abort();
      try {
        await new QwenSubscriptionSession().signOut();
        res.status(204).end();
      } catch (error) {
        const failure = subscriptionError(error, 'cleanup');
        res
          .status(502)
          .json({ code: errorCode(failure), ...errorDetails(failure) });
      } finally {
        signingOut = false;
      }
    },
  );
  return () => {
    disposed = true;
    for (const id of flows.keys()) cancel(id);
    for (const query of queries) query.abort();
  };
}
