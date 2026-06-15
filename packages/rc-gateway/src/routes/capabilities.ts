/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { RC_PROTOCOL_VERSION } from '../mdns/advert.js';
import type { NativeShellsCapability } from '../nativePush/nativeShells.js';

/**
 * GET /rc/capabilities — the gateway's capability surface. The daemon's own
 * `/capabilities` is un-editable under the fork boundary, so the gateway serves
 * its own `remoteControl` block. Always mounted (mDNS reports here even when cost
 * tracking is off); any authenticated token; no secrets.
 *
 * Composes optional sub-blocks from deps:
 *  - `costTracking` — only when a usage store is wired (`add-cost-tracking`).
 *  - `mdns` — `{ advertising, instanceName? }` (`add-mdns-discovery`); the spec's
 *    `version` is sourced from {@link RC_PROTOCOL_VERSION}, the same constant the
 *    mDNS TXT record advertises, so the two never drift.
 */
export function createCapabilityRoute(deps: {
  costTracking?: { currencyLabel: () => string };
  mdnsStatus?: () => { advertising: boolean; instanceName?: string };
  nativeShells?: () => NativeShellsCapability;
}): RequestHandler {
  return (req, res) => {
    if (!req.rcClient) {
      res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
      return;
    }
    const remoteControl: Record<string, unknown> = {
      version: RC_PROTOCOL_VERSION,
    };
    if (deps.costTracking) {
      remoteControl.costTracking = {
        enabled: true,
        currencyLabel: deps.costTracking.currencyLabel(),
        rateTablePath: '~/.qwen/rc/model-rates.yaml',
      };
    }
    if (deps.mdnsStatus) {
      const m = deps.mdnsStatus();
      remoteControl.mdns = m.advertising
        ? { advertising: true, instanceName: m.instanceName }
        : { advertising: false };
    }
    if (deps.nativeShells) {
      remoteControl.nativeShells = deps.nativeShells();
    }
    res.status(200).json({ remoteControl });
  };
}
