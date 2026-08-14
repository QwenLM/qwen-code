/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createFsBrowseRoute } from './fsBrowse.js';

let gateway: Server | undefined;
let tmp: string | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  gateway = undefined;
  if (tmp) {
    await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

async function mountGateway(
  opts?: Parameters<typeof createFsBrowseRoute>[0],
): Promise<string> {
  const app = express();
  app.get('/rc/fs', createFsBrowseRoute(opts));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('GET /rc/fs', () => {
  it('lists subdirectories of a path with a parent link', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'qwen-fsbrowse-'));
    await mkdir(join(tmp, 'a'));
    await mkdir(join(tmp, 'b'));
    await writeFile(join(tmp, 'f.txt'), 'hi');

    const url = await mountGateway();
    const res = await fetch(`${url}/rc/fs?path=${encodeURIComponent(tmp)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      parent: string | null;
      entries: Array<{ name: string; isDir: boolean }>;
    };
    expect(body.path).toBe(tmp);
    expect(body.parent).toBe(dirname(tmp));
    expect(body.entries.map((e) => e.name).sort()).toEqual(['a', 'b']);
    expect(body.entries.every((e) => e.isDir)).toBe(true);
  });

  it('404s a file path', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'qwen-fsbrowse-'));
    const filePath = join(tmp, 'f.txt');
    await writeFile(filePath, 'hi');

    const url = await mountGateway();
    const res = await fetch(
      `${url}/rc/fs?path=${encodeURIComponent(filePath)}`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('not_a_directory');
  });

  it('400s a relative path', async () => {
    const url = await mountGateway();
    const res = await fetch(
      `${url}/rc/fs?path=${encodeURIComponent('relative/path')}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_path');
  });

  it('uses opts.defaultPath when path is absent', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'qwen-fsbrowse-'));
    await mkdir(join(tmp, 'a'));

    const url = await mountGateway({ defaultPath: tmp });
    const res = await fetch(`${url}/rc/fs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe(tmp);
  });

  it('returns parent: null for the filesystem root', async () => {
    const url = await mountGateway();
    const res = await fetch(`${url}/rc/fs?path=${encodeURIComponent('/')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { parent: string | null };
    expect(body.parent).toBeNull();
  });

  it('resolves a trailing-slash path to its canonical form (no trailing slash)', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'qwen-fsbrowse-'));
    await mkdir(join(tmp, 'a'));

    const url = await mountGateway();
    const res = await fetch(
      `${url}/rc/fs?path=${encodeURIComponent(`${tmp}/`)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      parent: string | null;
    };
    expect(body.path).toBe(tmp); // trailing slash stripped -- canonical
    expect(body.parent).toBe(dirname(tmp));
  });

  it('404s a path that does not exist', async () => {
    const url = await mountGateway();
    const res = await fetch(
      `${url}/rc/fs?path=${encodeURIComponent('/does/not/exist/at/all')}`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('not_a_directory');
  });
});
