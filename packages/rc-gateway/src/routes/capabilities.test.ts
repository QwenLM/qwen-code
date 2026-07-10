/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createCapabilityRoute } from './capabilities.js';
import { RC_PROTOCOL_VERSION } from '../mdns/advert.js';

async function mount(
  deps: Parameters<typeof createCapabilityRoute>[0],
  authed = true,
) {
  const app = express();
  app.use((req, _res, next) => {
    if (authed) {
      (req as { rcClient?: unknown }).rcClient = { tokenId: 't' };
    }
    next();
  });
  app.get('/rc/capabilities', createCapabilityRoute(deps));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

describe('GET /rc/capabilities', () => {
  it('401s without an authenticated client', async () => {
    const { base, close } = await mount({}, false);
    try {
      const r = await fetch(`${base}/rc/capabilities`);
      expect(r.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('always reports the protocol version', async () => {
    const { base, close } = await mount({});
    try {
      const r = await fetch(`${base}/rc/capabilities`);
      const body = await r.json();
      expect(body.remoteControl.version).toBe(RC_PROTOCOL_VERSION);
      expect(body.remoteControl.costTracking).toBeUndefined();
      expect(body.remoteControl.mdns).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('always includes the six required remoteControl fields', async () => {
    const { base, close } = await mount({});
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      const rc = body.remoteControl;
      expect(rc.supportedTransports).toEqual(['sse', 'ws']);
      expect(rc.supportedScopes).toEqual(['owner', 'write', 'approve', 'read']);
      expect(rc.pairingEnabled).toBe(true);
      expect(rc.auditEnabled).toBe(true);
      expect(rc.walHorizonSec).toBe(86400);
      expect(rc.walMaxEvents).toBe(10000);
    } finally {
      await close();
    }
  });

  it('includes costTracking only when wired', async () => {
    const { base, close } = await mount({
      costTracking: { currencyLabel: () => 'EUR' },
    });
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      expect(body.remoteControl.costTracking).toMatchObject({
        enabled: true,
        currencyLabel: 'EUR',
      });
    } finally {
      await close();
    }
  });

  it('reflects mDNS advertising state with instanceName', async () => {
    const { base, close } = await mount({
      mdnsStatus: () => ({ advertising: true, instanceName: 'kitchen-app' }),
    });
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      expect(body.remoteControl.mdns).toEqual({
        advertising: true,
        instanceName: 'kitchen-app',
      });
    } finally {
      await close();
    }
  });

  it('includes the nativeShells block when wired', async () => {
    const { base, close } = await mount({
      nativeShells: () => ({
        bridgeVersion: 1,
        apnsEnabled: false,
        supportedPlatforms: ['android-twa', 'ios-wkwebview'],
        minShellVersion: { android: '1.0.0', ios: '1.0.0' },
      }),
    });
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      expect(body.remoteControl.nativeShells).toMatchObject({
        bridgeVersion: 1,
        apnsEnabled: false,
        supportedPlatforms: ['android-twa', 'ios-wkwebview'],
      });
    } finally {
      await close();
    }
  });

  it('omits instanceName when not advertising', async () => {
    const { base, close } = await mount({
      mdnsStatus: () => ({ advertising: false }),
    });
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      expect(body.remoteControl.mdns).toEqual({ advertising: false });
      expect(body.remoteControl.mdns.instanceName).toBeUndefined();
    } finally {
      await close();
    }
  });
});
