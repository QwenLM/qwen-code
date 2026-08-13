/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response, RequestHandler } from 'express';
import {
  AmbiguousLanInterfaceError,
  listLanCandidates,
  NoLanInterfaceError,
  UnknownLanInterfaceError,
} from '../local-control/lan-interfaces.js';
import { listenerIdentityOf } from '../local-control/listener-identity.js';
import type { LocalControlService } from '../local-control/service.js';

export interface RegisterWorkspaceLocalControlRoutesDeps {
  service: LocalControlService;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => unknown;
  isDaemonDraining?: () => boolean;
}

/**
 * Enabling is restricted to the primary (loopback) listener.
 *
 * The asymmetry is the point. A page already reached over the LAN must not be
 * able to widen LAN access — otherwise a paired phone, or anything that got
 * hold of the pairing token, could re-enable Local Control after the operator
 * turned it off, or move it onto a different interface. Only someone at the
 * machine can grant.
 *
 * Disabling stays open to every authenticated caller, including the phone.
 * Revoking your own access is always safe, and a user who realizes they are on
 * an untrusted network needs to cut the connection from the device in their
 * hand, not from the laptop they walked away from.
 */
function requirePrimaryListener(req: Request, res: Response): boolean {
  if (listenerIdentityOf(req).kind === 'primary') return true;
  res.status(403).json({
    error:
      'Local Control can only be enabled from the machine running the daemon.',
    code: 'local_control_remote_enable_denied',
  });
  return false;
}

export function registerWorkspaceLocalControlRoutes(
  app: Application,
  deps: RegisterWorkspaceLocalControlRoutesDeps,
): void {
  app.get('/workspace/local-control', (_req, res) => {
    res.status(200).json({
      ...deps.service.status(),
      // Always listed, active or not: the Web Shell needs the candidate set to
      // render the interface picker before the first enable, which is exactly
      // when the host may have several.
      interfaces: listLanCandidates(),
    });
  });

  app.post(
    '/workspace/local-control/enable',
    deps.mutate({ strict: true }),
    async (req, res) => {
      if (!requirePrimaryListener(req, res)) return;
      if (deps.isDaemonDraining?.()) {
        res.status(503).json({
          error: 'Daemon is shutting down.',
          code: 'daemon_draining',
        });
        return;
      }
      const body = (deps.safeBody(req) ?? {}) as {
        address?: unknown;
        target?: unknown;
      };
      try {
        res.status(200).json(
          await deps.service.enable({
            address:
              typeof body.address === 'string' ? body.address : undefined,
            target: typeof body.target === 'string' ? body.target : undefined,
          }),
        );
      } catch (error) {
        sendEnableError(res, error);
      }
    },
  );

  app.post(
    '/workspace/local-control/disable',
    deps.mutate({ strict: true }),
    async (_req, res) => {
      res.status(200).json(await deps.service.disable());
    },
  );
}

function sendEnableError(res: Response, error: unknown): void {
  // 409 rather than 400: the request was well-formed and the operator did
  // nothing wrong — the host simply has more than one answer. The candidate
  // list comes back with it so the client can ask and retry with `address`
  // instead of round-tripping through GET.
  if (error instanceof AmbiguousLanInterfaceError) {
    res.status(409).json({
      error: error.message,
      code: error.code,
      interfaces: error.candidates,
    });
    return;
  }
  if (error instanceof NoLanInterfaceError) {
    res.status(409).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof UnknownLanInterfaceError) {
    res.status(409).json({
      error: error.message,
      code: error.code,
      interfaces: listLanCandidates(),
    });
    return;
  }
  res.status(500).json({
    error: error instanceof Error ? error.message : String(error),
    code: 'local_control_enable_failed',
  });
}
