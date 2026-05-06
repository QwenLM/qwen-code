/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pickAsciiArtTier, resolveCustomBanner } from './customBanner.js';
import type { LoadedSettings, SettingsFile } from '../../config/settings.js';
import type {
  CustomAsciiArtSetting,
  Settings,
} from '../../config/settingsSchema.js';

function makeSettings(opts: {
  workspaceUi?: Settings['ui'];
  workspacePath?: string;
  userUi?: Settings['ui'];
  userPath?: string;
  systemUi?: Settings['ui'];
  systemPath?: string;
  isTrusted?: boolean;
}): LoadedSettings {
  const file = (settings: Settings, p: string): SettingsFile => ({
    settings,
    originalSettings: settings,
    path: p,
  });
  const empty: SettingsFile = {
    settings: {},
    originalSettings: {},
    path: '',
  };
  const merged: Settings = {
    ui: {
      ...(opts.userUi ?? {}),
      ...(opts.workspaceUi ?? {}),
      ...(opts.systemUi ?? {}),
    },
  };
  return {
    system: opts.systemUi
      ? file({ ui: opts.systemUi }, opts.systemPath ?? '/sys/settings.json')
      : empty,
    systemDefaults: empty,
    user: opts.userUi
      ? file(
          { ui: opts.userUi },
          opts.userPath ?? '/home/u/.qwen/settings.json',
        )
      : empty,
    workspace: opts.workspaceUi
      ? file(
          { ui: opts.workspaceUi },
          opts.workspacePath ?? '/repo/.qwen/settings.json',
        )
      : empty,
    isTrusted: opts.isTrusted ?? true,
    migratedInMemorScopes: new Set(),
    migrationWarnings: [],
    merged,
  } as unknown as LoadedSettings;
}

describe('resolveCustomBanner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-banner-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty banner when nothing is configured', () => {
    const out = resolveCustomBanner(makeSettings({}));
    expect(out.asciiArt.small).toBeUndefined();
    expect(out.asciiArt.large).toBeUndefined();
    expect(out.title).toBeUndefined();
  });

  it('accepts an inline string and uses it for both tiers', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: { customAsciiArt: '  ACME\n  ----' },
      }),
    );
    expect(out.asciiArt.small).toBe('  ACME\n  ----');
    expect(out.asciiArt.large).toBe('  ACME\n  ----');
  });

  it('accepts a {path} object and reads from disk', () => {
    const file = path.join(tmpDir, 'brand.txt');
    fs.writeFileSync(file, 'WIDE\nLOGO\n');
    const out = resolveCustomBanner(
      makeSettings({
        workspaceUi: {
          customAsciiArt: { path: 'brand.txt' } as CustomAsciiArtSetting,
        },
        workspacePath: path.join(tmpDir, 'settings.json'),
      }),
    );
    expect(out.asciiArt.small).toBe('WIDE\nLOGO');
    expect(out.asciiArt.large).toBe('WIDE\nLOGO');
  });

  it('resolves relative paths against the owning settings directory', () => {
    const file = path.join(tmpDir, 'art.txt');
    fs.writeFileSync(file, 'X\nY');
    const out = resolveCustomBanner(
      makeSettings({
        userUi: {
          customAsciiArt: { path: './art.txt' } as CustomAsciiArtSetting,
        },
        userPath: path.join(tmpDir, 'settings.json'),
      }),
    );
    expect(out.asciiArt.small).toBe('X\nY');
  });

  it('accepts width-aware {small, large} tiers', () => {
    const out = resolveCustomBanner(
      makeSettings({
        workspaceUi: {
          customAsciiArt: {
            small: 'small',
            large: 'large',
          } as CustomAsciiArtSetting,
        },
      }),
    );
    expect(out.asciiArt.small).toBe('small');
    expect(out.asciiArt.large).toBe('large');
  });

  it('omits a tier when only one is provided', () => {
    const out = resolveCustomBanner(
      makeSettings({
        workspaceUi: {
          customAsciiArt: { large: 'big' } as CustomAsciiArtSetting,
        },
      }),
    );
    expect(out.asciiArt.small).toBeUndefined();
    expect(out.asciiArt.large).toBe('big');
  });

  it('strips ANSI escape sequences from inline art', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: { customAsciiArt: '\x1b[31mhostile\x1b[0m\nART' },
      }),
    );
    expect(out.asciiArt.small).not.toContain('\x1b');
    expect(out.asciiArt.small).toContain('hostile');
    expect(out.asciiArt.small).toContain('ART');
  });

  it('strips C1 control characters (0x80-0x9f) including single-byte CSI', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: { customAsciiArt: 'A\x9b31mB\x9c\x90X' },
      }),
    );
    // 0x9b (single-byte CSI), 0x9c (ST), 0x90 (DCS) are all C1 — must be
    // replaced with space, not interpreted by the terminal.
    expect(out.asciiArt.small).not.toMatch(/[\x80-\x9f]/);
    expect(out.asciiArt.small).toContain('A');
    expect(out.asciiArt.small).toContain('B');
    expect(out.asciiArt.small).toContain('X');
  });

  it('strips OSC-8 hyperlinks from inline art', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: {
          customAsciiArt: '\x1b]8;;https://evil\x07click\x1b]8;;\x07',
        },
      }),
    );
    expect(out.asciiArt.small).not.toContain('\x1b');
    expect(out.asciiArt.small).toContain('click');
  });

  it('preserves newlines so multi-line art survives sanitization', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: { customAsciiArt: 'line1\nline2\nline3' },
      }),
    );
    expect(out.asciiArt.small?.split('\n')).toEqual([
      'line1',
      'line2',
      'line3',
    ]);
  });

  it('caps art at 200 lines × 200 cols', () => {
    const tooManyLines = Array.from({ length: 250 }, () => 'x').join('\n');
    const out1 = resolveCustomBanner(
      makeSettings({ userUi: { customAsciiArt: tooManyLines } }),
    );
    expect(out1.asciiArt.small?.split('\n').length).toBe(200);

    const tooWide = 'a'.repeat(300);
    const out2 = resolveCustomBanner(
      makeSettings({ userUi: { customAsciiArt: tooWide } }),
    );
    expect(out2.asciiArt.small?.length).toBe(200);
  });

  it('reads from an absolute path verbatim', () => {
    const file = path.join(tmpDir, 'absolute.txt');
    fs.writeFileSync(file, 'ABS\nART');
    const out = resolveCustomBanner(
      makeSettings({
        userUi: {
          customAsciiArt: { path: file } as CustomAsciiArtSetting,
        },
        userPath: '/some/other/dir/settings.json',
      }),
    );
    expect(out.asciiArt.small).toBe('ABS\nART');
  });

  it('refuses to open a FIFO at the configured path (POSIX) — must not hang startup', () => {
    if (process.platform === 'win32') return;
    const fifoPath = path.join(tmpDir, 'pipe.fifo');
    // mkfifo via child_process keeps this test self-contained without
    // pulling in a native dep. If `mkfifo` isn't available (very rare on
    // POSIX dev boxes) we skip the assertion rather than fail the suite.
    try {
      execFileSync('mkfifo', [fifoPath]);
    } catch {
      return;
    }
    const start = Date.now();
    const out = resolveCustomBanner(
      makeSettings({
        userUi: {
          customAsciiArt: { path: 'pipe.fifo' } as CustomAsciiArtSetting,
        },
        userPath: path.join(tmpDir, 'settings.json'),
      }),
    );
    const elapsedMs = Date.now() - start;
    // The pre-open lstat() check should reject the FIFO instantly. If the
    // resolver ever regresses to opening a FIFO read-only, this assertion
    // will catch it because the open would block until a writer connects
    // (we never start one) and the test would hang well past 1s.
    expect(elapsedMs).toBeLessThan(1000);
    expect(out.asciiArt.small).toBeUndefined();
    expect(out.asciiArt.large).toBeUndefined();
  });

  it('refuses to follow a symlink at the configured path on POSIX', () => {
    if (process.platform === 'win32') return;
    const real = path.join(tmpDir, 'real.txt');
    fs.writeFileSync(real, 'REAL\nART');
    const link = path.join(tmpDir, 'link.txt');
    fs.symlinkSync(real, link);
    const out = resolveCustomBanner(
      makeSettings({
        userUi: {
          customAsciiArt: { path: 'link.txt' } as CustomAsciiArtSetting,
        },
        userPath: path.join(tmpDir, 'settings.json'),
      }),
    );
    // O_NOFOLLOW makes openSync throw ELOOP — resolver soft-fails, so the
    // tier ends up undefined rather than reading through the symlink.
    expect(out.asciiArt.small).toBeUndefined();
  });

  it('falls back when the {path} target is missing', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: {
          customAsciiArt: { path: 'missing.txt' } as CustomAsciiArtSetting,
        },
        userPath: path.join(tmpDir, 'settings.json'),
      }),
    );
    expect(out.asciiArt.small).toBeUndefined();
    expect(out.asciiArt.large).toBeUndefined();
  });

  it('truncates oversize files at 64KB', () => {
    const file = path.join(tmpDir, 'huge.txt');
    fs.writeFileSync(file, 'a'.repeat(65 * 1024));
    const out = resolveCustomBanner(
      makeSettings({
        userUi: {
          customAsciiArt: { path: 'huge.txt' } as CustomAsciiArtSetting,
        },
        userPath: path.join(tmpDir, 'settings.json'),
      }),
    );
    // Capped at 200 cols regardless; mostly we're asserting "doesn't blow up".
    expect(out.asciiArt.small?.length).toBe(200);
  });

  it('rejects {path} mixed with tier keys (mutually exclusive object branches)', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: {
          customAsciiArt: {
            path: 'p.txt',
            small: 'should-be-rejected',
          } as unknown as CustomAsciiArtSetting,
        },
        userPath: '/home/u/.qwen/settings.json',
      }),
    );
    // The resolver must NOT silently let `path` win — both forms are
    // dropped and we fall through to the default art.
    expect(out.asciiArt.small).toBeUndefined();
    expect(out.asciiArt.large).toBeUndefined();
  });

  it('caps art width by terminal cells, not UTF-16 length (CJK fullwidth)', () => {
    // 200 fullwidth CJK characters render at ~400 cells; before the fix
    // the .length cap let them through. The cap is now visual width, so
    // ~100 fullwidth chars max per line.
    const fullwidth = '一'.repeat(150); // 150 chars × 2 cells = 300 cells
    const out = resolveCustomBanner(
      makeSettings({ userUi: { customAsciiArt: fullwidth } }),
    );
    const small = out.asciiArt.small ?? '';
    // Truncated by visual width: each fullwidth char is 2 cells, so
    // ≤ 100 chars fit under MAX_ART_COLS=200.
    expect(small.length).toBeLessThanOrEqual(100);
    // And it's a valid string of fullwidth chars (no surrogate / split
    // mid-codepoint — every char is a full BMP code point here).
    expect(/^一+$/.test(small)).toBe(true);
  });

  it('falls back when a {path} entry lives in a scope with no associated file path', () => {
    // `userPath: ''` simulates a path-less scope (e.g. systemDefaults).
    // A {path} tier in such a scope can't resolve relative paths, so we
    // soft-fail it specifically instead of silently dropping the whole
    // scope (which would block inline tiers from path-less scopes too).
    const out = resolveCustomBanner(
      makeSettings({
        userUi: {
          customAsciiArt: { path: 'art.txt' } as CustomAsciiArtSetting,
        },
        userPath: '',
      }),
    );
    expect(out.asciiArt.small).toBeUndefined();
    expect(out.asciiArt.large).toBeUndefined();
  });

  it('still accepts inline string art from a scope with no file path (decoupled from {path} resolution)', () => {
    // The flip side of the previous test: inline strings don't need an
    // owning settings directory, so a path-less scope must still
    // contribute. Before the decoupling, the whole scope was dropped on
    // `!file.path`, so even inline art would silently disappear.
    const out = resolveCustomBanner(
      makeSettings({
        userUi: { customAsciiArt: 'INLINE-FROM-PATHLESS-SCOPE' },
        userPath: '',
      }),
    );
    expect(out.asciiArt.small).toBe('INLINE-FROM-PATHLESS-SCOPE');
    expect(out.asciiArt.large).toBe('INLINE-FROM-PATHLESS-SCOPE');
  });

  it('rejects a malformed customAsciiArt and falls back to default', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: {
          customAsciiArt: { path: 42 } as unknown as CustomAsciiArtSetting,
        },
      }),
    );
    expect(out.asciiArt.small).toBeUndefined();
    expect(out.asciiArt.large).toBeUndefined();
  });

  it('treats whitespace-only inline art as empty', () => {
    const out = resolveCustomBanner(
      makeSettings({ userUi: { customAsciiArt: '   \n   ' } }),
    );
    expect(out.asciiArt.small).toBeUndefined();
  });

  it('ignores untrusted workspace settings — does not honor an untrusted checkout (no inline render, no file read)', () => {
    const file = path.join(tmpDir, 'evil.txt');
    fs.writeFileSync(file, 'EVIL');
    const out = resolveCustomBanner(
      makeSettings({
        isTrusted: false,
        // Workspace tries to provide both an inline string AND a {path}
        // tier — both must be ignored when the workspace is untrusted.
        workspaceUi: {
          customAsciiArt: {
            small: 'WORKSPACE-INLINE',
            large: { path: 'evil.txt' },
          } as CustomAsciiArtSetting,
        },
        workspacePath: path.join(tmpDir, 'settings.json'),
        // User scope still contributes; if it didn't, we couldn't tell
        // "untrusted dropped the workspace" apart from "resolver broke".
        userUi: { customAsciiArt: 'USER-FALLBACK' },
      }),
    );
    expect(out.asciiArt.small).toBe('USER-FALLBACK');
    expect(out.asciiArt.large).toBe('USER-FALLBACK');
    expect(out.asciiArt.small).not.toContain('WORKSPACE');
    expect(out.asciiArt.small).not.toContain('EVIL');
  });

  it('honors workspace settings when isTrusted is true (sanity check on the trust gate)', () => {
    const out = resolveCustomBanner(
      makeSettings({
        isTrusted: true,
        workspaceUi: { customAsciiArt: 'WORKSPACE-TRUSTED' },
        userUi: { customAsciiArt: 'USER' },
      }),
    );
    expect(out.asciiArt.small).toBe('WORKSPACE-TRUSTED');
  });

  it('uses workspace value when both user and workspace provide art', () => {
    const out = resolveCustomBanner(
      makeSettings({
        workspaceUi: { customAsciiArt: 'WORKSPACE' },
        userUi: { customAsciiArt: 'USER' },
      }),
    );
    expect(out.asciiArt.small).toBe('WORKSPACE');
  });

  it('combines tiers across scopes via deep-merge (workspace.large + user.small)', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: {
          customAsciiArt: { small: 'user-small' } as CustomAsciiArtSetting,
        },
        workspaceUi: {
          customAsciiArt: { large: 'workspace-large' } as CustomAsciiArtSetting,
        },
      }),
    );
    expect(out.asciiArt.small).toBe('user-small');
    expect(out.asciiArt.large).toBe('workspace-large');
  });

  it('sanitizes the title and trims whitespace', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: { customBannerTitle: '  \x1b[31mAcme CLI\x1b[0m  ' },
      }),
    );
    expect(out.title).toBe('Acme CLI');
  });

  it('strips C1 control characters from the title', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: { customBannerTitle: 'Acme\x9b31m CLI\x9c' },
      }),
    );
    expect(out.title).not.toMatch(/[\x80-\x9f]/);
    expect(out.title).toContain('Acme');
    expect(out.title).toContain('CLI');
  });

  it('caps the title at 80 characters', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: { customBannerTitle: 'x'.repeat(200) },
      }),
    );
    expect(out.title?.length).toBe(80);
  });

  it('treats empty title as undefined (falls back to default)', () => {
    const out = resolveCustomBanner(
      makeSettings({ userUi: { customBannerTitle: '   ' } }),
    );
    expect(out.title).toBeUndefined();
  });

  it('strips newlines from titles so the info panel layout is preserved', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: { customBannerTitle: 'Line1\nLine2' },
      }),
    );
    expect(out.title).toBe('Line1 Line2');
  });

  it('returns subtitle undefined when nothing is configured', () => {
    const out = resolveCustomBanner(makeSettings({}));
    expect(out.subtitle).toBeUndefined();
  });

  it('sanitizes the subtitle and trims whitespace', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: {
          customBannerSubtitle: '  \x1b[31mPowered by something\x1b[0m  ',
        },
      }),
    );
    expect(out.subtitle).toBe('Powered by something');
  });

  it('caps the subtitle at 160 characters (looser than title for taglines)', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: { customBannerSubtitle: 'x'.repeat(400) },
      }),
    );
    expect(out.subtitle?.length).toBe(160);
  });

  it('treats empty subtitle as undefined (header keeps the blank spacer row)', () => {
    const out = resolveCustomBanner(
      makeSettings({ userUi: { customBannerSubtitle: '   ' } }),
    );
    expect(out.subtitle).toBeUndefined();
  });

  it('strips newlines and C1 controls from the subtitle', () => {
    const out = resolveCustomBanner(
      makeSettings({
        userUi: { customBannerSubtitle: 'Line1\nLine2\x9b31m end' },
      }),
    );
    // Newline folds to a single space; the 0x9b (single-byte CSI) is
    // replaced with a space; the literal "31m" parameter chars survive
    // as plain text (they were never going to be interpreted without the
    // leading control byte) — exactly the same shape the title sanitizer
    // produces for the equivalent input.
    expect(out.subtitle).not.toMatch(/[\x80-\x9f]/);
    expect(out.subtitle).not.toContain('\n');
    expect(out.subtitle).toContain('Line1 Line2');
    expect(out.subtitle).toContain('end');
  });
});

describe('pickAsciiArtTier', () => {
  const measure = (s: string) => s.length;

  it('prefers large when it fits', () => {
    expect(pickAsciiArtTier('small', 'BIGGER', 100, 2, 40, measure)).toBe(
      'BIGGER',
    );
  });

  it('falls back to small when large is too wide', () => {
    expect(pickAsciiArtTier('sml', 'a'.repeat(200), 60, 2, 40, measure)).toBe(
      'sml',
    );
  });

  it('returns undefined when neither tier fits', () => {
    expect(
      pickAsciiArtTier('a'.repeat(80), 'a'.repeat(120), 50, 2, 40, measure),
    ).toBeUndefined();
  });

  it('skips missing tiers', () => {
    expect(pickAsciiArtTier(undefined, 'fits', 100, 2, 40, measure)).toBe(
      'fits',
    );
    expect(pickAsciiArtTier('fits', undefined, 100, 2, 40, measure)).toBe(
      'fits',
    );
    expect(
      pickAsciiArtTier(undefined, undefined, 100, 2, 40, measure),
    ).toBeUndefined();
  });
});
