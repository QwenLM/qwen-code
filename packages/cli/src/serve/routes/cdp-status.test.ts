/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type {
  CdpBridgeEndpoint,
  CdpTunnelRegistry,
} from '../cdp-tunnel/cdp-tunnel-registry.js';
import { registerCdpStatusRoute } from './cdp-status.js';

const bridge = (multiClient: boolean): CdpBridgeEndpoint => ({
  connectionId: 'bridge-1',
  multiClient,
  send: () => {},
});

function appFor(
  registry: Pick<CdpTunnelRegistry, 'getActive' | 'linkCount'> | undefined,
  token?: string,
) {
  const app = express();
  registerCdpStatusRoute(app, {
    registry: registry as CdpTunnelRegistry | undefined,
    token,
  });
  return app;
}

describe('registerCdpStatusRoute', () => {
  it('reports unusable when the tunnel or bridge is absent', async () => {
    await expect(
      request(appFor(undefined)).get('/cdp/status'),
    ).resolves.toMatchObject({
      body: {
        enabled: false,
        bridgeConnected: false,
        multiClient: false,
        linkCount: 0,
        usable: false,
      },
    });

    await expect(
      request(
        appFor({
          getActive: () => undefined,
          linkCount: () => 0,
        }),
      ).get('/cdp/status'),
    ).resolves.toMatchObject({
      body: {
        enabled: true,
        bridgeConnected: false,
        multiClient: false,
        linkCount: 0,
        usable: false,
      },
    });
  });

  it('requires a multi-client bridge without bearer auth', async () => {
    const registry = {
      getActive: () => bridge(true),
      linkCount: () => 2,
    };

    await expect(
      request(appFor(registry)).get('/cdp/status'),
    ).resolves.toMatchObject({
      body: {
        enabled: true,
        bridgeConnected: true,
        multiClient: true,
        linkCount: 2,
        usable: true,
      },
    });

    await expect(
      request(appFor(registry, 'token')).get('/cdp/status'),
    ).resolves.toMatchObject({
      body: { usable: false },
    });
    await expect(
      request(
        appFor({
          getActive: () => bridge(false),
          linkCount: () => 1,
        }),
      ).get('/cdp/status'),
    ).resolves.toMatchObject({
      body: { multiClient: false, usable: false },
    });
  });
});
