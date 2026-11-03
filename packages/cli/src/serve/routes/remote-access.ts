/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler } from 'express';
import { requestHasOperatorAuthority } from '../auth.js';
import { isLoopbackAddress, isLoopbackBind } from '../loopback-binds.js';
import { listenerIdentityOf } from '../local-control/listener-identity.js';
import {
  RemoteAccessError,
  type RemoteAccessService,
} from '../remote-access.js';

export function registerRemoteAccessRoutes(
  app: Application,
  deps: {
    service: RemoteAccessService;
    primaryHostname: string;
    trustedLoopbackMode: boolean;
    mutate: (options?: { strict?: boolean }) => RequestHandler;
    isDraining?: () => boolean;
  },
) {
  const externallyConfigured = !isLoopbackBind(deps.primaryHostname);
  const canManage = (req: Request) =>
    !externallyConfigured &&
    listenerIdentityOf(req).kind === 'primary' &&
    Boolean(
      req.socket.remoteAddress && isLoopbackAddress(req.socket.remoteAddress),
    ) &&
    requestHasOperatorAuthority(req, deps.trustedLoopbackMode);

  // This is process-global administration, never selected-workspace state.
  app.get('/remote-access', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!canManage(req)) {
      res.json({
        active: deps.service.status().active,
        canManage: false,
        externallyConfigured,
      });
      return;
    }
    res.json({
      ...deps.service.status(),
      canManage: true,
      externallyConfigured,
    });
  });

  for (const action of [
    'enable',
    'disable',
    'reveal',
    'reset-token',
    'origins',
  ] as const) {
    app.post(
      `/remote-access/${action}`,
      deps.mutate({ strict: true }),
      async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!canManage(req)) {
          res.status(403).json({
            code: 'local_operator_required',
            error:
              'Manage remote access from this daemon’s authorized local settings.',
          });
          return;
        }
        if (deps.isDraining?.()) {
          res.status(503).json({
            code: 'daemon_draining',
            error: 'The daemon is shutting down.',
          });
          return;
        }
        const body: unknown = req.body;
        const input =
          typeof body === 'object' && body !== null && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : {};
        try {
          if (
            (input['address'] !== undefined &&
              typeof input['address'] !== 'string') ||
            (input['port'] !== undefined &&
              typeof input['port'] !== 'number') ||
            (input['origins'] !== undefined &&
              (!Array.isArray(input['origins']) ||
                !input['origins'].every(
                  (entry: unknown) => typeof entry === 'string',
                )))
          ) {
            throw new RemoteAccessError(
              'invalid_options',
              'Invalid remote access options.',
            );
          }
          const options = input as {
            address?: string;
            port?: number;
            origins?: string[];
          };
          const status =
            action === 'enable'
              ? await deps.service.enable(options)
              : action === 'disable'
                ? await deps.service.disable()
                : action === 'reset-token'
                  ? await deps.service.resetToken()
                  : action === 'origins'
                    ? await deps.service.updateOrigins(options.origins ?? [])
                    : deps.service.reveal();
          res.json({ ...status, canManage: true, externallyConfigured });
        } catch (error) {
          res.status(error instanceof RemoteAccessError ? 409 : 500).json({
            code:
              error instanceof RemoteAccessError
                ? error.code
                : 'remote_access_failed',
            error:
              error instanceof Error
                ? error.message
                : 'Remote access operation failed.',
          });
        }
      },
    );
  }
}
