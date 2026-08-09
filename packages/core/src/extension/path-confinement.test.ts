/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isPathWithin,
  realPathWithin,
  readExtensionManifest,
  resolvePathWithin,
  resolvePluginRelativeFile,
} from './path-confinement.js';

describe('isPathWithin', () => {
  it('accepts equality and nested paths', () => {
    const nested = path.join('a', 'b', 'c');
    const parent = path.join('a', 'b');
    expect(isPathWithin(parent, parent)).toBe(true);
    expect(isPathWithin(nested, parent)).toBe(true);
  });

  it('rejects sibling-prefix and unrelated paths', () => {
    const parent = path.join('a', 'b');
    expect(isPathWithin(path.join('a', 'b-evil'), parent)).toBe(false);
    expect(isPathWithin(path.join('x', 'y'), parent)).toBe(false);
  });
});

describe('realPathWithin', () => {
  it('returns true when the real path stays inside root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      expect(realPathWithin(dir, dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false for a broken symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      const link = path.join(dir, 'dangling');
      fs.symlinkSync(path.join(dir, 'missing'), link);
      expect(realPathWithin(link, dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readExtensionManifest', () => {
  it('returns null for a missing manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      expect(readExtensionManifest(dir, 'plugin.json')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws for unparseable JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      fs.writeFileSync(path.join(dir, 'plugin.json'), '{invalid', 'utf-8');
      expect(() => readExtensionManifest(dir, 'plugin.json')).toThrow(
        /Invalid plugin\.json/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws for a manifest symlinked outside the package', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-out-'));
    try {
      const secret = path.join(outside, 'plugin.json');
      fs.writeFileSync(secret, '{"name":"x"}', 'utf-8');
      fs.symlinkSync(secret, path.join(dir, 'plugin.json'));
      expect(() => readExtensionManifest(dir, 'plugin.json')).toThrow(
        /resolves through a symlink outside the package/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads a valid manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      fs.writeFileSync(path.join(dir, 'plugin.json'), '{"name":"x"}', 'utf-8');
      expect(readExtensionManifest(dir, 'plugin.json')).toEqual({
        name: 'x',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolvePluginRelativeFile', () => {
  it('resolves an in-package relative path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      expect(resolvePluginRelativeFile(dir, 'hooks/hooks.json')).toBe(
        path.resolve(dir, 'hooks/hooks.json'),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an absolute path', () => {
    expect(resolvePluginRelativeFile('/pkg', '/etc/passwd')).toBeNull();
  });

  it('rejects a path escaping the plugin via ..', () => {
    expect(resolvePluginRelativeFile('/pkg', '../outside')).toBeNull();
  });

  it('rejects a symlink escaping the plugin', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-out-'));
    try {
      const secret = path.join(outside, 'secret.json');
      fs.writeFileSync(secret, '{}', 'utf-8');
      fs.symlinkSync(secret, path.join(dir, 'leak'));
      expect(resolvePluginRelativeFile(dir, './leak')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('resolvePathWithin', () => {
  const describeErr = (kind: string) => `violation:${kind}`;

  it('resolves a safe relative path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      const resolved = resolvePathWithin(dir, 'hooks/hooks.json', describeErr);
      expect(resolved).toBe(path.resolve(dir, 'hooks/hooks.json'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws an absolute-path violation', () => {
    expect(() => resolvePathWithin('/pkg', '/etc/passwd', describeErr)).toThrow(
      'violation:absolute',
    );
  });

  it('throws an escapes violation for a .. path', () => {
    expect(() => resolvePathWithin('/pkg', '../outside', describeErr)).toThrow(
      'violation:escapes',
    );
  });

  it('throws a symlink-escape violation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-out-'));
    try {
      const secret = path.join(outside, 'secret.json');
      fs.writeFileSync(secret, '{}', 'utf-8');
      fs.symlinkSync(secret, path.join(dir, 'leak'));
      expect(() => resolvePathWithin(dir, './leak', describeErr)).toThrow(
        'violation:symlink-escape',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
