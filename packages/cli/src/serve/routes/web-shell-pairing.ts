/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import express, { type Application, type Request } from 'express';
import { bearerAuth } from '../auth.js';
import type { CredentialStore } from '../local-control/credentials.js';
import { listLanCandidates } from '../local-control/lan-interfaces.js';
import { listenerIdentityOf } from '../local-control/listener-identity.js';
import {
  canonicalHost,
  formatHostForAuthority,
  isLoopbackBind,
  isWildcardBind,
} from '../loopback-binds.js';
import { ACCESS_LOG_REJECT_LOCAL } from '../server/access-log.js';
import type { RateLimiterInstance } from '../rate-limit.js';

const PAIRING_TTL_MS = 60_000;

function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function requestUrl(req: Request): URL {
  return new URL(`${req.protocol}://${req.headers.host}`);
}

export function registerWebShellPairingRoutes(
  app: Application,
  credentials: CredentialStore,
  hostname: string,
  rateLimiter?: Pick<RateLimiterInstance, 'middleware' | 'checkRate'>,
): void {
  const invitations = new Map<string, { origin: string; expiresAt: number }>();
  // The loopback half canonicalizes the operator's spelling (`127.1`) the way
  // Node's bind does, so a short-spelled loopback listener keeps the Local
  // Control remediation path instead of minting invitations that only the
  // operator's own machine could redeem. `isLoopbackBind` itself stays
  // spelling-exact: the boot-time token check and the Host allowlist depend
  // on the raw value.
  const available = (req: Request) =>
    !isLoopbackBind(canonicalHost(hostname)) &&
    listenerIdentityOf(req).kind === 'primary' &&
    !credentials.isOpen({ kind: 'primary' });

  app.post(
    '/web-shell/pairing/exchange',
    (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      if (
        rateLimiter &&
        !rateLimiter.checkRate(
          `pairing:preauth:${req.socket.remoteAddress ?? 'unknown'}`,
          'mutation',
        )
      ) {
        res.locals[ACCESS_LOG_REJECT_LOCAL] = true;
        res.status(429).json({
          error: 'Rate limit exceeded',
          code: 'rate_limit_exceeded',
          tier: 'mutation',
        });
        return;
      }
      next();
    },
    (req, res) => {
      const secret =
        req.headers.authorization?.match(/^Bearer ([\w-]{43})$/i)?.[1];
      const key = secret ? digest(secret) : '';
      const invitation = invitations.get(key);
      if (
        !available(req) ||
        !invitation ||
        invitation.expiresAt <= Date.now() ||
        invitation.origin !== requestUrl(req).origin ||
        (req.headers.origin && req.headers.origin !== invitation.origin)
      ) {
        res.locals[ACCESS_LOG_REJECT_LOCAL] = true;
        res.status(401).json({
          error: 'Pairing code expired or already used. Scan a fresh QR code.',
        });
        return;
      }
      const token = randomBytes(32).toString('base64url');
      if (!credentials.addWebShellToken(token)) {
        res.status(409).json({
          error:
            'Paired device limit reached. Restart the daemon to reset pairing.',
        });
        return;
      }
      invitations.delete(key);
      res.json({ token });
    },
  );

  app.post(
    '/web-shell/pairing',
    bearerAuth(credentials),
    ...(rateLimiter ? [rateLimiter.middleware] : []),
    express.json({ limit: '1kb' }),
    async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!available(req)) {
        res.json({ active: false });
        return;
      }
      try {
        const url = requestUrl(req);
        if (isLoopbackBind(url.hostname) || isWildcardBind(url.hostname)) {
          if (isWildcardBind(hostname)) {
            const interfaces = listLanCandidates();
            const address: unknown = req.body?.address;
            const selected =
              address === undefined && interfaces.length === 1
                ? interfaces[0]
                : interfaces.find((candidate) => candidate.address === address);
            if (!selected) {
              res.json({ active: true, interfaces });
              return;
            }
            url.hostname = formatHostForAuthority(selected.address);
          } else {
            url.hostname = formatHostForAuthority(hostname);
          }
        }
        const secret = randomBytes(32).toString('base64url');
        url.hash = `pairing=${secret}`;
        const { default: qrcode } = await import('qrcode-terminal');
        qrcode.setErrorLevel('Q');
        let qrText = '';
        qrcode.generate(url.toString(), { small: true }, (code) => {
          qrText = code.trimEnd();
        });
        const now = Date.now();
        for (const [key, invitation] of invitations) {
          if (invitation.expiresAt <= now) invitations.delete(key);
        }
        if (invitations.size >= 64) {
          invitations.delete(invitations.keys().next().value!);
        }
        const expiresAt = now + PAIRING_TTL_MS;
        invitations.set(digest(secret), { origin: url.origin, expiresAt });
        res.json({
          active: true,
          url: url.toString(),
          qrText,
          expiresInMs: PAIRING_TTL_MS,
          encrypted: url.protocol === 'https:',
        });
      } catch (error) {
        next(error);
      }
    },
  );
}
