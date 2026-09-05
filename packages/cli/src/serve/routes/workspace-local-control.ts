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
import { isLoopbackBind } from '../loopback-binds.js';
import {
  InvalidLocalControlTargetError,
  type LocalControlService,
  type LocalControlStatus,
} from '../local-control/service.js';
import { requestHasOperatorAuthority } from '../auth.js';
import {
  writeStderrLine,
  writeStdoutLineSafe,
} from '../../utils/stdioHelpers.js';

export interface RegisterWorkspaceLocalControlRoutesDeps {
  service: LocalControlService;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  isDaemonDraining?: () => boolean;
  webShellAvailable?: boolean;
  /** The daemon's primary bind hostname (runtime enable precondition). */
  primaryBindHostname?: string;
  /** Whether tokenless primary-listener requests have operator authority. */
  trustedLoopbackMode?: boolean;
}

async function withUiData(status: LocalControlStatus) {
  let qrText: string | undefined;
  if (status.url) {
    // QR rendering is best-effort and must never fail the request. The pairing
    // URL is caller-influenced (`target` deep-links), so an over-capacity URL
    // can exceed the QR encoder's limit; if that threw, enable/status would 500
    // while the LAN listener is already live and stays live — a wedged card
    // with no way to disable. The Web Shell still shows the raw URL text, so
    // pairing remains possible without the QR block.
    try {
      const { default: qrcode } = (await import('qrcode-terminal')) as {
        default: typeof import('qrcode-terminal');
      };
      qrcode.setErrorLevel('Q');
      qrcode.generate(status.url, { small: true }, (code) => {
        qrText = code.trimEnd();
      });
    } catch {
      qrText = undefined;
    }
  }
  return { ...status, qrText, interfaces: listLanCandidates() };
}

/**
 * `url` carries the pairing token in its fragment and `qrText` encodes it.
 * Return that material only to a request with operator authority: either a
 * listener credential was verified or the request arrived on the trusted
 * primary loopback listener. Everyone else gets a redacted status.
 */
function presentStatus(
  req: Request,
  ui: Awaited<ReturnType<typeof withUiData>>,
  trustedLoopbackMode: boolean,
) {
  if (requestHasOperatorAuthority(req, trustedLoopbackMode)) return ui;
  const { url: _url, qrText: _qrText, ...rest } = ui;
  return { ...rest, urlRedacted: ui.url !== undefined };
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
 * Disabling stays open to every caller admitted by its listener policy,
 * including the trusted primary listener and a paired phone. Revoking your own
 * access is always safe, and a user who realizes they are on an untrusted
 * network needs to cut the connection from the device in their hand, not from
 * the laptop they walked away from.
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
  const trustedLoopbackMode = deps.trustedLoopbackMode === true;
  app.get('/workspace/local-control', async (req, res) => {
    res
      .status(200)
      .json(
        presentStatus(
          req,
          await withUiData(deps.service.status()),
          trustedLoopbackMode,
        ),
      );
  });

  app.post(
    '/workspace/local-control/enable',
    deps.mutate(),
    async (req, res) => {
      if (!requirePrimaryListener(req, res)) return;
      if (deps.webShellAvailable === false) {
        res.status(409).json({
          error: 'Local Control requires the Web Shell.',
          code: 'local_control_web_shell_unavailable',
        });
        return;
      }
      // Same precondition the `--local-control` CLI flag enforces: the LAN
      // listener binds the primary listener's port on the selected LAN
      // address, which a wildcard or LAN primary bind already owns —
      // enabling there would fail with EADDRINUSE and no remediation.
      if (
        deps.primaryBindHostname !== undefined &&
        !isLoopbackBind(deps.primaryBindHostname)
      ) {
        res.status(409).json({
          error:
            'Local Control requires the daemon to be bound to loopback; ' +
            'restart it with --hostname 127.0.0.1.',
          code: 'local_control_non_loopback_bind',
        });
        return;
      }
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
        const ui = await withUiData(
          await deps.service.enable({
            address:
              typeof body.address === 'string' ? body.address : undefined,
            target: typeof body.target === 'string' ? body.target : undefined,
          }),
        );
        if (!requestHasOperatorAuthority(req, trustedLoopbackMode) && ui.url) {
          // The response below has the secret removed; the operator still
          // needs it to pair. The daemon's own terminal is the one channel a
          // local attacker process cannot read over HTTP, so surface the URL
          // there (#9106).
          writeStdoutLineSafe(
            `qwen serve: Local Control pairing URL: ${ui.url}`,
          );
        }
        res.status(200).json(presentStatus(req, ui, trustedLoopbackMode));
      } catch (error) {
        sendEnableError(res, error);
      }
    },
  );

  app.post(
    '/workspace/local-control/disable',
    deps.mutate(),
    async (req, res) => {
      if (listenerIdentityOf(req).kind === 'local-control') {
        queueMicrotask(() => {
          void deps.service.disable().catch((error) => {
            writeStderrLine(
              `qwen serve: Local Control disable failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        });
        res.status(200).json({ active: false });
        return;
      }
      res
        .status(200)
        .json(
          presentStatus(
            req,
            await withUiData(await deps.service.disable()),
            trustedLoopbackMode,
          ),
        );
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
  if (error instanceof InvalidLocalControlTargetError) {
    res.status(400).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({
    error: error instanceof Error ? error.message : String(error),
    code: 'local_control_enable_failed',
  });
}
