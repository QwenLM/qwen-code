/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  assertManagedExtensionStateSeparation,
  resolveManagedExtensionsDir,
} from './managed-extension-dir.js';

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

it('rejects case aliases of managed state roots on case-insensitive filesystems', () => {
  // Exercise the fold host-independently the way storage.test.ts does: fake
  // a case-folding platform so the guard cannot lean on the volume's own
  // case behavior. The alias spelling is never created, so a case-sensitive
  // host still judges the pair by string comparison alone.
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-case-'));
  const managed = path.join(root, 'ManagedPackages');
  const alias = path.join(root, 'managedpackages');
  fs.mkdirSync(managed);
  try {
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
    Object.defineProperty(process, 'platform', { value: originalPlatform });
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

// Windows cannot create directory symlinks without extra privileges.
it.skipIf(process.platform === 'win32')(
  'rejects a symlink alias whose target does not exist yet',
  () => {
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
  },
);

// Windows cannot create directory symlinks without extra privileges.
it.skipIf(process.platform === 'win32')(
  'resolves a relative symlink target against the physical parent of the link',
  () => {
    // realpath the base: os.tmpdir() sits behind a symlink on some platforms
    // (macOS /var), and the assertions below compare a realpath result
    // against joins off this root.
    // realpath the base: os.tmpdir() sits behind a symlink on some platforms
    // (macOS /var), and the assertions below compare a realpath result
    // against joins off this root.
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-link-')),
    );
    const home = path.join(root, 'home');
    // home/.qwen -> home/dotfiles/qwen, and inside the real directory a
    // relative link whose '..' legs only land correctly when resolved
    // against the link's physical parent, not its lexical one.
    fs.mkdirSync(path.join(home, 'dotfiles', 'qwen'), { recursive: true });
    fs.mkdirSync(path.join(home, 'shared', 'themes'), { recursive: true });
    fs.symlinkSync(path.join('dotfiles', 'qwen'), path.join(home, '.qwen'));
    fs.symlinkSync(
      path.join('..', '..', 'shared', 'themes'),
      path.join(home, '.qwen', 'themes'),
    );
    try {
      expect(fs.realpathSync.native(path.join(home, '.qwen', 'themes'))).toBe(
        path.join(home, 'shared', 'themes'),
      );
      expect(() =>
        assertManagedExtensionStateSeparation(
          path.join(home, 'shared', 'themes'),
          [path.join(home, '.qwen', 'themes')],
        ),
      ).toThrow('must not overlap');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'accepts the container translation of a Windows drive spelling',
  () => {
    const translated = '/c/qwen-managed-translation';
    const directoryStats = {
      isSymbolicLink: () => false,
      isDirectory: () => true,
    } as unknown as fs.Stats;
    const lstat = vi.mocked(fs.lstatSync);
    const originalLstat = lstat.getMockImplementation()!;
    const actualStat = fs.statSync;
    const actualAccess = fs.accessSync;
    const actualReaddir = fs.readdirSync;
    const actualRealpathNative = fs.realpathSync.native;
    lstat.mockImplementation((target, options) =>
      target === translated ? directoryStats : originalLstat(target, options),
    );
    const statSpy = vi
      .spyOn(fs, 'statSync')
      .mockImplementation(((target: fs.PathLike, ...rest: unknown[]) =>
        target === translated
          ? directoryStats
          : (actualStat as (...args: unknown[]) => fs.Stats)(
              target,
              ...rest,
            )) as typeof fs.statSync);
    const accessSpy = vi
      .spyOn(fs, 'accessSync')
      .mockImplementation(((target: fs.PathLike, ...rest: unknown[]) =>
        target === translated
          ? undefined
          : (actualAccess as (...args: unknown[]) => void)(
              target,
              ...rest,
            )) as typeof fs.accessSync);
    const readdirSpy = vi
      .spyOn(fs, 'readdirSync')
      .mockImplementation(((target: fs.PathLike, ...rest: unknown[]) =>
        target === translated
          ? []
          : (actualReaddir as (...args: unknown[]) => unknown)(
              target,
              ...rest,
            )) as typeof fs.readdirSync);
    const realpathSpy = vi
      .spyOn(fs.realpathSync, 'native')
      .mockImplementation(((target: fs.PathLike, ...rest: unknown[]) =>
        target === translated
          ? translated
          : (actualRealpathNative as (...args: unknown[]) => string)(
              target,
              ...rest,
            )) as typeof fs.realpathSync.native);
    try {
      expect(resolveManagedExtensionsDir('C:\\qwen-managed-translation')).toBe(
        translated,
      );
    } finally {
      lstat.mockImplementation(originalLstat);
      statSpy.mockRestore();
      accessSpy.mockRestore();
      readdirSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'still rejects a Windows drive spelling whose translation does not exist',
  () => {
    expect(() =>
      resolveManagedExtensionsDir('C:\\qwen-managed-definitely-missing'),
    ).toThrow(/Invalid --managed-extensions/);
  },
);
