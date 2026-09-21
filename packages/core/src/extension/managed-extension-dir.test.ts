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
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

it('rejects an unavailable filesystem root instead of repeatedly checking its parent', () => {
  const managed = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-root-'));
  const root = path.parse(path.resolve(managed)).root;
  const writable = path.join(root, 'qwen-unavailable-root', 'state');
  const unavailable = new Set([writable, path.dirname(writable), root]);
  const lstat = vi.mocked(fs.lstatSync);
  const originalLstat = lstat.getMockImplementation()!;
  let rootChecks = 0;
  let failure: unknown;
  lstat.mockImplementation((target, options) => {
    if (typeof target === 'string' && unavailable.has(target)) {
      if (target === root && ++rootChecks > 1) {
        throw new Error('Repeated the unavailable filesystem root');
      }
      const error: NodeJS.ErrnoException = new Error(
        `ENOENT: no such file or directory, lstat '${target}'`,
      );
      error.code = 'ENOENT';
      throw error;
    }
    return originalLstat(target, options);
  });
  try {
    assertManagedExtensionStateSeparation(managed, [writable]);
  } catch (error) {
    failure = error;
  } finally {
    lstat.mockImplementation(originalLstat);
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

it('rejects a symlink alias whose target does not exist yet', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-link-'));
  const managed = path.join(root, 'deployment', 'extensions');
  const writable = path.join(root, 'home', '.qwen', 'extensions');
  fs.mkdirSync(managed, { recursive: true });
  fs.mkdirSync(path.dirname(writable), { recursive: true });
  try {
    // The link target stays absent: existsSync follows links and reports the
    // link itself as missing, which must not hide the alias.
    fs.symlinkSync(path.join(managed, 'user-state'), writable, 'dir');
    expect(fs.existsSync(writable)).toBe(false);
    expect(() =>
      assertManagedExtensionStateSeparation(managed, [writable]),
    ).toThrow('must not overlap');
    // A link pointing away from the managed root stays admissible.
    const elsewhere = path.join(root, 'elsewhere');
    const outsideLink = path.join(root, 'home', '.qwen', 'themes');
    fs.symlinkSync(elsewhere, outsideLink, 'dir');
    expect(() =>
      assertManagedExtensionStateSeparation(managed, [outsideLink]),
    ).not.toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
