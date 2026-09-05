/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isPathWithin,
  realPathWithin,
  readExtensionManifest,
  readExtraJsonFile,
  resolvePathWithin,
  resolvePluginRelativeFile,
  type ExtraJsonNullReason,
} from './path-confinement.js';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    isEnabled: () => true,
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
  }),
}));

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

  it.runIf(process.platform !== 'win32')('returns false for a broken symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      const link = path.join(dir, 'dangling');
      fs.symlinkSync(path.join(dir, 'missing'), link);
      expect(realPathWithin(link, dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('returns true for a symlink whose realpath stays inside root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      const target = path.join(dir, 'base.md');
      fs.writeFileSync(target, 'x', 'utf-8');
      const link = path.join(dir, 'link.md');
      fs.symlinkSync(target, link);
      // Legitimate in-package symlinks (git preserves them) must be accepted,
      // not blanket-rejected — the escape tests cover only the rejection side.
      expect(realPathWithin(link, dir)).toBe(true);
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

  it.runIf(process.platform !== 'win32')('throws for a manifest symlinked outside the package', () => {
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

  it.runIf(process.platform !== 'win32')('reads a symlinked manifest when trustSymlinks is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-out-'));
    try {
      fs.writeFileSync(
        path.join(outside, 'plugin.json'),
        JSON.stringify({ name: 'shared', version: '1.0.0' }),
        'utf-8',
      );
      fs.symlinkSync(
        path.join(outside, 'plugin.json'),
        path.join(dir, 'plugin.json'),
      );
      // Link-mode installs read the user's own dev tree; the escaping symlink
      // is followed instead of rejected. (The default strict rejection is
      // covered by 'throws for a manifest symlinked outside the package'.)
      expect(readExtensionManifest(dir, 'plugin.json', true)).toEqual({
        name: 'shared',
        version: '1.0.0',
      });
      // Legitimate in-package symlinks (e.g. git's link farm) must be accepted by strict mode.
      const inPkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-in-'));
      try {
        fs.writeFileSync(
          path.join(inPkgDir, 'plugin.real.json'),
          '{"name":"linked"}',
          'utf-8',
        );
        fs.symlinkSync(
          path.join(inPkgDir, 'plugin.real.json'),
          path.join(inPkgDir, 'plugin.json'),
        );
        expect(readExtensionManifest(inPkgDir, 'plugin.json')).toEqual({
          name: 'linked',
        });
      } finally {
        fs.rmSync(inPkgDir, { recursive: true, force: true });
      }
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

  it.each([
    ['null', 'null'],
    ['array', '[]'],
    ['scalar', '5'],
  ])('throws for a %s manifest body', (_label, body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      fs.writeFileSync(path.join(dir, 'plugin.json'), body, 'utf-8');
      expect(() => readExtensionManifest(dir, 'plugin.json')).toThrow(
        /expected a JSON object/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes control bytes out of unparseable-manifest errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'plugin.json'),
        '\u001b[31minvalid',
        'utf-8',
      );
      let message = '';
      try {
        readExtensionManifest(dir, 'plugin.json');
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toContain('\u001b');
      expect(message).toMatch(/Invalid plugin\.json/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'throws when the manifest path is not a regular file (e.g. FIFO)',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
      try {
        try {
          execFileSync('mkfifo', [path.join(dir, 'plugin.json')]);
        } catch {
          return;
        }
        expect(() => readExtensionManifest(dir, 'plugin.json')).toThrow(
          /not a regular file/,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
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

  it.runIf(process.platform !== 'win32')('rejects a symlink escaping the plugin', () => {
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

  it.runIf(process.platform !== 'win32')('throws a symlink-escape violation', () => {
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

describe('readExtraJsonFile', () => {
  it('reads a relative file inside the extension', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      fs.writeFileSync(path.join(dir, 'hooks.json'), '{"a":1}', 'utf-8');
      expect(readExtraJsonFile(dir, 'hooks.json')).toEqual({ a: 1 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads an absolute file inside the extension', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      const file = path.join(dir, 'hooks.json');
      fs.writeFileSync(file, '{"a":1}', 'utf-8');
      expect(readExtraJsonFile(dir, file)).toEqual({ a: 1 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a missing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      const reasons: string[] = [];
      expect(
        readExtraJsonFile(dir, 'nope.json', false, (reason) =>
          reasons.push(reason),
        ),
      ).toBeNull();
      expect(reasons).toEqual(['missing']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for an unparseable file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    mockWarn.mockClear();
    try {
      fs.writeFileSync(
        path.join(dir, 'hooks.json'),
        '\u001b[31m{invalid',
        'utf-8',
      );
      expect(readExtraJsonFile(dir, 'hooks.json')).toBeNull();
      const text = mockWarn.mock.calls.map((call) => String(call[0])).join(' ');
      expect(text).toContain('Failed to parse hooks.json:');
      expect(text).not.toContain('\u001b');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['null', 'null'],
    ['array', '[]'],
    ['scalar', '5'],
  ])('returns null for a %s body', (_label, body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      fs.writeFileSync(path.join(dir, 'hooks.json'), body, 'utf-8');
      expect(readExtraJsonFile(dir, 'hooks.json')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null with `directory` reason when the path is a directory, not a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      fs.mkdirSync(path.join(dir, 'hooks.json'), { recursive: true });
      let observed: ExtraJsonNullReason | null = null;
      const result = readExtraJsonFile(dir, 'hooks.json', false, (reason) => {
        observed = reason;
      });
      expect(result).toBeNull();
      expect(observed).toBe('directory');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'returns null with `directory` reason when the path is a FIFO',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
      try {
        try {
          execFileSync('mkfifo', [path.join(dir, 'hooks.json')]);
        } catch {
          return;
        }
        let observed: ExtraJsonNullReason | null = null;
        const result = readExtraJsonFile(dir, 'hooks.json', false, (reason) => {
          observed = reason;
        });
        expect(result).toBeNull();
        expect(observed).toBe('directory');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('returns null for a relative path escaping the extension', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-out-'));
    try {
      // Create the escape target on disk so the assertion can
      // distinguish "guard rejected the path" from "guard absent, file
      // simply missing" (the missing-file branch also returns null).
      // Without the target existing, a guard-free implementation passes
      // the assertion silently.
      const siblingName = path.basename(outside);
      fs.writeFileSync(
        path.join(outside, 'hooks.json'),
        JSON.stringify({ escape: true }),
        'utf-8',
      );
      expect(
        readExtraJsonFile(dir, path.join('..', siblingName, 'hooks.json')),
      ).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('returns null for a symlink escaping the extension', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-out-'));
    try {
      const secret = path.join(outside, 'hooks.json');
      fs.writeFileSync(secret, '{}', 'utf-8');
      fs.symlinkSync(secret, path.join(dir, 'hooks.json'));
      const reasons: string[] = [];
      expect(
        readExtraJsonFile(dir, 'hooks.json', false, (reason) =>
          reasons.push(reason),
        ),
      ).toBeNull();
      expect(reasons).toEqual(['confinement-threw']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // A symlink that stays INSIDE the package is legitimate and must be read
  // under strict confinement too — only links escaping the package are
  // refused. Mutating the realPathWithin gate breaks this.
  it.runIf(process.platform !== 'win32')(
    'reads an in-package symlink under strict confinement',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
      try {
        fs.writeFileSync(
          path.join(dir, 'target.json'),
          '{"hooks":{}}',
          'utf-8',
        );
        fs.symlinkSync(
          path.join(dir, 'target.json'),
          path.join(dir, 'link.json'),
        );
        expect(readExtraJsonFile(dir, 'link.json')).toEqual({ hooks: {} });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')('reads a symlinked auxiliary file when trustSymlinks is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-out-'));
    const siblingName = path.basename(outside);
    try {
      const secret = path.join(outside, 'hooks.json');
      fs.writeFileSync(secret, JSON.stringify({ hooks: {} }), 'utf-8');
      fs.symlinkSync(secret, path.join(dir, 'hooks.json'));
      // Link mode follows user's own symlinks AND literal `..` — both
      // reach the developer's own data. Strict-mode `..` rejection is
      // covered by 'returns null for a relative path escaping the extension'.
      expect(readExtraJsonFile(dir, 'hooks.json', true)).toEqual({
        hooks: {},
      });
      expect(
        readExtraJsonFile(dir, path.join(outside, 'hooks.json'), true),
      ).toEqual({ hooks: {} });
      expect(
        readExtraJsonFile(
          dir,
          path.join('..', siblingName, 'hooks.json'),
          true,
        ),
      ).toEqual({ hooks: {} });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns null (missing) for a link-mode .. path that points at no file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    try {
      // No sibling fixture — `..` resolves to a non-existent path.
      // Link-mode honors `..` and falls through to missing-file
      // (no warn). Strict-mode rejects before the existsSync probe —
      // onNull distinguishes: link-mode → 'missing', strict-mode →
      // 'confinement-threw'.
      const reasons: string[] = [];
      readExtraJsonFile(dir, '../no-such-sibling/hooks.json', true, (reason) =>
        reasons.push(reason),
      );
      expect(reasons).toEqual(['missing']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for an absolute path escaping the extension', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-out-'));
    try {
      // The escaping file must exist, or the read falls through to the
      // missing-file branch and never exercises the absolute-path guard.
      fs.writeFileSync(path.join(outside, 'hooks.json'), '{}', 'utf-8');
      expect(
        readExtraJsonFile(dir, path.join(outside, 'hooks.json')),
      ).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
