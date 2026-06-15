/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  buildClientsManifest,
  createClientsManifestRoute,
} from './clientsManifest.js';

const TOML = `
[[daemon]]
name = "workstation-1"
url  = "https://qwen.local:4170"
tokenStorageKey = "qwen-rc:qwen.local:4170:token"
default = true

[[daemon]]
name = "side-project"
url  = "https://qwen.local:4171"
tokenStorageKey = "qwen-rc:qwen.local:4171:token"
`;

describe('buildClientsManifest', () => {
  it('remaps [[daemon]] to a daemons array verbatim with generatedAt', () => {
    const r = buildClientsManifest(TOML, '2026-06-14T00:00:00.000Z');
    expect(r.warning).toBeUndefined();
    expect(r.generatedAt).toBe('2026-06-14T00:00:00.000Z');
    expect(r.daemons).toHaveLength(2);
    expect(r.daemons[0]).toEqual({
      name: 'workstation-1',
      url: 'https://qwen.local:4170',
      tokenStorageKey: 'qwen-rc:qwen.local:4170:token',
      default: true,
    });
    // the second entry has no `default` key — NOT synthesized
    expect('default' in (r.daemons[1] as object)).toBe(false);
  });

  it('returns a warning (status-200 shape) when the file is missing', () => {
    const r = buildClientsManifest(null, '2026-06-14T00:00:00.000Z');
    expect(r).toMatchObject({ daemons: [] });
    expect(r.warning).toMatch(/not found/i);
    expect(r.generatedAt).toBeUndefined();
  });

  it('returns a warning on invalid TOML (never throws)', () => {
    const r = buildClientsManifest('not = = valid', 'now');
    expect(r.daemons).toEqual([]);
    expect(r.warning).toMatch(/invalid/i);
  });

  it('treats an empty-but-valid file as zero daemons, no warning', () => {
    const r = buildClientsManifest('', '2026-06-14T00:00:00.000Z');
    expect(r).toEqual({ daemons: [], generatedAt: '2026-06-14T00:00:00.000Z' });
  });
});

describe('createClientsManifestRoute', () => {
  async function mount(deps: Parameters<typeof createClientsManifestRoute>[0]) {
    const app = express();
    app.use((req, _res, next) => {
      (req as { rcClient?: unknown }).rcClient = { id: 't', scopes: ['owner'] };
      next();
    });
    app.get('/ui/clients-manifest.json', createClientsManifestRoute(deps));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    return {
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise((r) => server.close(r)),
    };
  }

  it('serves the parsed manifest as JSON', async () => {
    const { base, close } = await mount({
      readToml: async () => TOML,
      now: () => Date.parse('2026-06-14T00:00:00.000Z'),
    });
    try {
      const body = await (
        await fetch(`${base}/ui/clients-manifest.json`)
      ).json();
      expect(body.daemons).toHaveLength(2);
      expect(body.generatedAt).toBe('2026-06-14T00:00:00.000Z');
    } finally {
      await close();
    }
  });

  it('caches for the TTL (readToml called once across rapid hits)', async () => {
    let reads = 0;
    let clock = 1_000_000;
    const { base, close } = await mount({
      readToml: async () => {
        reads++;
        return TOML;
      },
      now: () => clock,
      ttlMs: 60_000,
    });
    try {
      await fetch(`${base}/ui/clients-manifest.json`);
      clock += 30_000; // within TTL
      await fetch(`${base}/ui/clients-manifest.json`);
      expect(reads).toBe(1);
      clock += 31_000; // now past TTL
      await fetch(`${base}/ui/clients-manifest.json`);
      expect(reads).toBe(2);
    } finally {
      await close();
    }
  });

  it('returns 200 with a warning when readToml throws unexpectedly', async () => {
    const { base, close } = await mount({
      readToml: async () => {
        throw new Error('EACCES');
      },
      now: () => 1,
    });
    try {
      const r = await fetch(`${base}/ui/clients-manifest.json`);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ daemons: [] });
      expect(body.warning).toBeTruthy();
    } finally {
      await close();
    }
  });
});
