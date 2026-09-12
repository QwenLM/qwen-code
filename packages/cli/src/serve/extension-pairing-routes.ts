/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, {
  type Application,
  type Request,
  type Response,
} from 'express';
import { detectFromLoopback } from './server/request-helpers.js';
import type { ExtensionPairingManager } from './extension-pairing.js';

export const EXTENSION_PAIRING_PATH = '/extension/pairing';
export const EXTENSION_PAIRING_CONFIRM_PATH = '/extension/pairing/confirm';
export const EXTENSION_PAIRING_VERIFY_PATH = '/extension/pairing/verify';

function requireLoopback(req: Request, res: Response): boolean {
  if (detectFromLoopback(req)) return true;
  res.status(403).json({ error: 'extension_pairing_requires_loopback' });
  return false;
}

export function installExtensionPairingRoutes(
  app: Application,
  extensionPairingManager: ExtensionPairingManager,
): void {
  app.get(EXTENSION_PAIRING_PATH, (req: Request, res: Response): void => {
    if (!requireLoopback(req, res)) return;
    res.status(200).json(extensionPairingManager.getStatus());
  });

  app.post(
    EXTENSION_PAIRING_CONFIRM_PATH,
    express.json({ limit: '1kb' }),
    (req: Request, res: Response): void => {
      if (!requireLoopback(req, res)) return;
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const result = extensionPairingManager.confirm({
        pairingNonce:
          typeof body['pairingNonce'] === 'string' ? body['pairingNonce'] : '',
        challenge:
          typeof body['challenge'] === 'string' ? body['challenge'] : '',
        clientProof:
          typeof body['clientProof'] === 'string' ? body['clientProof'] : '',
      });
      if (!result.ok) {
        res.status(401).json({ error: result.error });
        return;
      }
      res.status(200).json({
        credentialId: result.credentialId,
        proof: result.proof,
      });
    },
  );

  app.post(
    EXTENSION_PAIRING_VERIFY_PATH,
    express.json({ limit: '1kb' }),
    (req: Request, res: Response): void => {
      if (!requireLoopback(req, res)) return;
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const proof = extensionPairingManager.createVerificationProof(
        typeof body['credentialId'] === 'string'
          ? body['credentialId']
          : undefined,
        typeof body['challenge'] === 'string' ? body['challenge'] : undefined,
      );
      if (!proof) {
        res.status(401).json({ paired: false });
        return;
      }
      res.status(200).json({ paired: true, proof });
    },
  );
}
