/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerManagedPackagePreparation } from './managed-package-preparation.js';
import type { ExtensionsController } from './workspace-extensions-controller.js';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('@qwen-code/qwen-code-core/extension/managed-package.js', () => ({
  prepareManagedExtensionPackage: prepare,
  ManagedPackageCompatibilityError: class extends Error {},
}));

let server: Server;
let base: string;
let selected: ExtensionsController;
let originalSource: string;
const directories: string[] = [];
const owner = () =>
  ({
    validateExtensionMutationClient: () => true,
  }) as unknown as ExtensionsController;

beforeEach(async () => {
  selected = owner();
  originalSource = await fs.mkdtemp(
    path.join(os.tmpdir(), 'managed-prepare-test-'),
  );
  directories.push(originalSource);
  await fs.writeFile(
    path.join(originalSource, 'qwen-extension.json'),
    '{"name":"fixture","version":"1"}',
  );
  prepare.mockReset().mockImplementation(async (_source, options) => {
    directories.push(options.destination);
    await fs.writeFile(
      path.join(options.destination, 'package.tar.gz'),
      'archive',
    );
    return {
      packageDigest: 'a'.repeat(64),
      manifest: {},
      sourceRevision: 'original',
    };
  });
  const app = express();
  app.use(express.json());
  registerManagedPackagePreparation(
    app,
    '/workspace/extensions',
    () => selected,
    () => (_req, _res, next) => next(),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test port');
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const publish = () =>
  fetch(`${base}/workspace/extensions/managed-packages/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: originalSource,
      consent: true,
      target: { platform: 'linux', arch: 'x64' },
    }),
  });

it('streams the prepared archive only to its original Workspace controller', async () => {
  const original = selected;
  const response = await publish();
  expect(response.status).toBe(201);
  const result = (await response.json()) as { archiveUrl: string };
  expect(await (await fetch(base + result.archiveUrl)).text()).toBe('archive');
  selected = owner();
  expect((await fetch(base + result.archiveUrl)).status).toBe(404);
  selected = original;
  expect((await fetch(base + result.archiveUrl)).status).toBe(200);
});

it('discards a preparation whose Workspace controller changed before completion', async () => {
  prepare.mockImplementationOnce(async (_source, options) => {
    directories.push(options.destination);
    selected = owner();
    return {
      packageDigest: 'a'.repeat(64),
      manifest: {},
      sourceRevision: 'original',
    };
  });
  const response = await publish();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    code: 'managed_package_target_changed',
  });
  await vi.waitFor(async () => {
    await expect(fs.stat(directories.at(-1)!)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
