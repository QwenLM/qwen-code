/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertManagedExtensionStateSeparation,
  getVerifiedManagedExtensionsDir,
  resolveManagedExtensionsDir,
} from './managed-extension-dir.js';
import { ExtensionManager } from './extensionManager.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

describe('unavailable filesystem-root managed configuration', () => {
  afterEach(() => vi.restoreAllMocks());

  function disconnectRoot() {
    const lstat = vi.mocked(fs.lstatSync);
    const original = lstat.getMockImplementation()!;
    const checked: string[] = [];
    lstat.mockImplementation((target) => {
      checked.push(String(target));
      throw Object.assign(new Error('disconnected filesystem root'), {
        code: 'ENOENT',
      });
    });
    return { checked, restore: () => lstat.mockImplementation(original) };
  }

  it('continues construction with a pinned unavailable root and denies managed reads', () => {
    const managed = path.resolve('/qwen-disconnected-drive/managed');
    const disconnected = disconnectRoot();
    try {
      expect(
        resolveManagedExtensionsDir(managed, undefined, {
          alreadyResolved: true,
        }),
      ).toBe(managed);
      expect(getVerifiedManagedExtensionsDir(managed)).toBeUndefined();
      expect(
        () =>
          new ExtensionManager({
            managedExtensionsDir: managed,
            workspaceDir: path.resolve('/qwen-other-drive/workspace'),
            isWorkspaceTrusted: true,
          }),
      ).not.toThrow();
    } finally {
      disconnected.restore();
    }
  });

  it('keeps unrelated literal state separate when no ancestor can be stated', () => {
    const disconnected = disconnectRoot();
    const root = path.parse(path.resolve('/')).root;
    try {
      expect(() =>
        assertManagedExtensionStateSeparation(
          path.join(root, 'qwen-offline', 'managed'),
          [path.join(root, 'qwen-state', 'extensions')],
        ),
      ).not.toThrow();
      expect(
        disconnected.checked.filter((value) => value === root),
      ).toHaveLength(2);
    } finally {
      disconnected.restore();
    }
  });

  it('still rejects literal overlap when every filesystem ancestor is unavailable', () => {
    const disconnected = disconnectRoot();
    const managed = path.resolve('/qwen-offline/managed');
    try {
      expect(() =>
        assertManagedExtensionStateSeparation(managed, [
          path.join(managed, 'state'),
        ]),
      ).toThrow('must not overlap');
      expect(() =>
        assertManagedExtensionStateSeparation(managed, [path.dirname(managed)]),
      ).toThrow('must not overlap');
    } finally {
      disconnected.restore();
    }
  });

  it('keeps initial command-line validation strict for an unavailable root', () => {
    const disconnected = disconnectRoot();
    try {
      expect(() =>
        resolveManagedExtensionsDir(path.resolve('/qwen-offline/managed')),
      ).toThrow('Invalid --managed-extensions');
    } finally {
      disconnected.restore();
    }
  });
});
