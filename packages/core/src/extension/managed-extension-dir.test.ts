/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import { assertManagedExtensionStateSeparation } from './managed-extension-dir.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

it('rejects an unavailable filesystem root instead of repeatedly checking its parent', () => {
  const managed = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-root-'));
  const root = path.parse(path.resolve(managed)).root;
  const writable = path.join(root, 'qwen-unavailable-root', 'state');
  const unavailable = new Set([writable, path.dirname(writable), root]);
  const exists = vi.mocked(fs.existsSync);
  const originalExists = exists.getMockImplementation()!;
  let rootChecks = 0;
  let failure: unknown;
  exists.mockImplementation((target) => {
    if (typeof target === 'string' && unavailable.has(target)) {
      if (target === root && ++rootChecks > 1) {
        throw new Error('Repeated the unavailable filesystem root');
      }
      return false;
    }
    return originalExists(target);
  });
  try {
    assertManagedExtensionStateSeparation(managed, [writable]);
  } catch (error) {
    failure = error;
  } finally {
    exists.mockImplementation(originalExists);
    fs.rmSync(managed, { recursive: true, force: true });
  }
  expect(rootChecks).toBe(1);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('Invalid --managed-extensions');
  expect((failure as Error).message).toContain(
    `filesystem root "${root}" is unavailable`,
  );
});

it('rejects case aliases of managed state roots on case-insensitive filesystems', (ctx) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-case-'));
  const managed = path.join(root, 'ManagedPackages');
  const alias = path.join(root, 'managedpackages');
  fs.mkdirSync(managed);
  try {
    if (!fs.existsSync(alias)) {
      ctx.skip();
      return;
    }
    expect(fs.statSync(alias).ino).toBe(fs.statSync(managed).ino);
    expect(() =>
      assertManagedExtensionStateSeparation(managed, [alias]),
    ).toThrow('must not overlap');
    expect(() =>
      assertManagedExtensionStateSeparation(managed, [
        path.join(alias, 'new-state', 'extensions'),
      ]),
    ).toThrow('must not overlap');
    fs.mkdirSync(path.join(managed, 'nested'));
    expect(() =>
      assertManagedExtensionStateSeparation(path.join(alias, 'nested'), [
        managed,
      ]),
    ).toThrow('must not overlap');
    expect(() =>
      assertManagedExtensionStateSeparation(managed, [
        path.join(root, 'unrelated-state'),
      ]),
    ).not.toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('keeps genuinely different case-sensitive directories separate', (ctx) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-case-'));
  const managed = path.join(root, 'ManagedPackages');
  const writable = path.join(root, 'managedpackages');
  fs.mkdirSync(managed);
  try {
    if (fs.existsSync(writable)) {
      ctx.skip();
      return;
    }
    fs.mkdirSync(writable);
    expect(() =>
      assertManagedExtensionStateSeparation(managed, [writable]),
    ).not.toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
