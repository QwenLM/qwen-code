/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { versionCheckMiddleware } from './versionCheck.js';
import { RC_PROTOCOL_VERSION } from '../mdns/advert.js';

async function mountWithVersionCheck() {
  const app = express();
  app.use(versionCheckMiddleware);
  app.get('/test', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

describe('versionCheckMiddleware', () => {
  it('passes through when X-RC-Version header is absent', async () => {
    const { base, close } = await mountWithVersionCheck();
    try {
      const r = await fetch(`${base}/test`);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(true);
    } finally {
      await close();
    }
  });

  it('passes through when X-RC-Version matches PROTOCOL_VERSION', async () => {
    const { base, close } = await mountWithVersionCheck();
    try {
      const r = await fetch(`${base}/test`, {
        headers: { 'X-RC-Version': String(RC_PROTOCOL_VERSION) },
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(true);
    } finally {
      await close();
    }
  });

  it('returns 426 with upgrade_required when X-RC-Version does not match', async () => {
    const { base, close } = await mountWithVersionCheck();
    try {
      const r = await fetch(`${base}/test`, {
        headers: { 'X-RC-Version': String(RC_PROTOCOL_VERSION + 1) },
      });
      expect(r.status).toBe(426);
      const body = await r.json();
      expect(body.error).toBe('upgrade_required');
      expect(body.supportedVersions).toEqual([RC_PROTOCOL_VERSION]);
    } finally {
      await close();
    }
  });

  it('returns 426 for a completely unknown version string', async () => {
    const { base, close } = await mountWithVersionCheck();
    try {
      const r = await fetch(`${base}/test`, {
        headers: { 'X-RC-Version': '999' },
      });
      expect(r.status).toBe(426);
      const body = await r.json();
      expect(body.error).toBe('upgrade_required');
      expect(body.supportedVersions).toEqual([RC_PROTOCOL_VERSION]);
    } finally {
      await close();
    }
  });
});
