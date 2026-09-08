/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadedSettings, type SettingsFile } from '../config/settings.js';
import type { Settings } from '../config/settingsSchema.js';
import { resolveCustomBanner } from '../ui/utils/customBanner.js';
import { resolveWebShellBrand } from './web-shell-brand.js';

const fsActual = vi.hoisted(
  () =>
    ({}) as {
      fstatSync: typeof import('node:fs').fstatSync;
      realpathSync: typeof import('node:fs').realpathSync;
    },
);

// Pass-through by default: roughly every case in this file reads through the
// real filesystem via the same namespace import, so a plain mock would strip
// `fs` from all of them. Only the two functions the TOCTOU and resolvability
// cases need to perturb are wrapped, and beforeEach re-attaches the real
// implementations so a leaked once-implementation cannot reach the next test.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsActual.fstatSync = actual.fstatSync;
  fsActual.realpathSync = actual.realpathSync;
  return { ...actual, fstatSync: vi.fn(), realpathSync: vi.fn() };
});

const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>';

function settingsFile(
  settings: Settings,
  filePath = '/settings.json',
): SettingsFile {
  return {
    settings,
    originalSettings: structuredClone(settings),
    path: filePath,
  };
}

function makeSettings(scopes: {
  system?: Settings;
  systemDefaults?: Settings;
  user?: Settings;
  userPath?: string;
  workspace?: Settings;
}): LoadedSettings {
  return new LoadedSettings(
    settingsFile(scopes.system ?? {}, '/system/settings.json'),
    settingsFile(scopes.systemDefaults ?? {}, '/system-defaults.json'),
    settingsFile(scopes.user ?? {}, scopes.userPath ?? '/settings.json'),
    settingsFile(scopes.workspace ?? {}, '/workspace/.qwen/settings.json'),
    true,
    new Set(),
  );
}

function brandSettings(brand: { name?: string; logoPath?: string }): Settings {
  return { ui: { brand } };
}

describe('resolveWebShellBrand', () => {
  let dir: string;

  beforeEach(() => {
    vi.mocked(fs.fstatSync).mockReset().mockImplementation(fsActual.fstatSync);
    vi.mocked(fs.realpathSync)
      .mockReset()
      .mockImplementation(fsActual.realpathSync);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-shell-brand-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeLogo(contents: string, name = 'logo.svg'): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents, 'utf-8');
    return file;
  }

  describe('name', () => {
    it('returns an empty brand when nothing is configured', () => {
      expect(resolveWebShellBrand(makeSettings({}))).toEqual({ brand: {} });
    });

    it('returns an empty brand for empty and whitespace-only values', () => {
      const settings = makeSettings({
        user: brandSettings({ name: '   ', logoPath: '' }),
      });
      expect(resolveWebShellBrand(settings)).toEqual({ brand: {} });
    });

    it('trims the configured name', () => {
      const settings = makeSettings({
        user: brandSettings({ name: '  QiuQiu Code  ' }),
      });
      expect(resolveWebShellBrand(settings).brand).toEqual({
        name: 'QiuQiu Code',
      });
    });

    it('strips terminal escape sequences and folds whitespace, like the TUI banner title', () => {
      const settings = makeSettings({
        user: brandSettings({ name: '\u001b[31mQiuQiu\u001b[0m\n\nCode' }),
      });
      expect(resolveWebShellBrand(settings).brand).toEqual({
        name: 'QiuQiu Code',
      });
    });

    it('drops a name that is nothing but escape sequences', () => {
      const settings = makeSettings({
        user: brandSettings({ name: '\u001b[31m\u001b[0m' }),
      });
      expect(resolveWebShellBrand(settings)).toEqual({ brand: {} });
    });

    it('caps the name at 80 characters', () => {
      const settings = makeSettings({
        user: brandSettings({ name: 'x'.repeat(120) }),
      });
      expect(resolveWebShellBrand(settings).brand.name).toHaveLength(80);
    });

    it('lets the system layer override the user layer', () => {
      const settings = makeSettings({
        user: brandSettings({ name: 'User Brand' }),
        system: brandSettings({ name: 'System Brand' }),
      });
      expect(resolveWebShellBrand(settings).brand).toEqual({
        name: 'System Brand',
      });
    });

    it('lets the user layer override system defaults', () => {
      const settings = makeSettings({
        systemDefaults: brandSettings({ name: 'Default Brand' }),
        user: brandSettings({ name: 'User Brand' }),
      });
      expect(resolveWebShellBrand(settings).brand).toEqual({
        name: 'User Brand',
      });
    });

    it('falls back to a lower layer when a higher one omits the key', () => {
      const settings = makeSettings({
        user: brandSettings({ name: 'User Brand' }),
        system: brandSettings({}),
      });
      expect(resolveWebShellBrand(settings).brand).toEqual({
        name: 'User Brand',
      });
    });

    it('lets an empty value at a higher layer reset a managed brand', () => {
      // `""` is a defined value, so it wins over a lower layer exactly as
      // mergeSettings lets any defined value win. Skipping it would leave a
      // SystemDefaults-managed brand impossible to opt out of, which is what
      // the schema description promises an empty value means.
      const settings = makeSettings({
        systemDefaults: brandSettings({ name: 'Managed Brand' }),
        user: brandSettings({ name: '' }),
      });
      expect(resolveWebShellBrand(settings)).toEqual({ brand: {} });
    });
  });

  describe('workspace exclusion', () => {
    it('ignores a name set only in workspace settings', () => {
      const settings = makeSettings({
        workspace: brandSettings({ name: 'Repo Brand' }),
      });
      expect(resolveWebShellBrand(settings)).toEqual({ brand: {} });
    });

    it('ignores a logo set only in workspace settings', () => {
      const logoPath = writeLogo(LOGO_SVG);
      const settings = makeSettings({
        workspace: brandSettings({ logoPath }),
      });
      const result = resolveWebShellBrand(settings);
      expect(result.brand).toEqual({});
      expect(result.warning).toBeUndefined();
    });

    it('keeps the user name when the workspace layer sets a different one', () => {
      const settings = makeSettings({
        user: brandSettings({ name: 'User Brand' }),
        workspace: brandSettings({ name: 'Repo Brand' }),
      });
      expect(resolveWebShellBrand(settings).brand).toEqual({
        name: 'User Brand',
      });
    });
  });

  describe('logo', () => {
    it('encodes a valid SVG as a data URI that decodes to the source', () => {
      const logoPath = writeLogo(LOGO_SVG);
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath }) }),
      );
      expect(warning).toBeUndefined();
      expect(brand.logoDataUri?.startsWith('data:image/svg+xml,')).toBe(true);
      expect(
        decodeURIComponent(
          brand.logoDataUri!.slice('data:image/svg+xml,'.length),
        ),
      ).toBe(LOGO_SVG);
    });

    it('accepts an XML declaration, a comment and a DOCTYPE before the root', () => {
      const logoPath = writeLogo(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<!-- exported from a design tool -->\n' +
          '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
          LOGO_SVG,
      );
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath }) }),
      );
      expect(warning).toBeUndefined();
      expect(brand.logoDataUri).toBeDefined();
    });

    it('accepts a DOCTYPE with an internal subset', () => {
      const logoPath = writeLogo(
        '<!DOCTYPE svg [ <!ENTITY x "y"> ]>\n' + LOGO_SVG,
      );
      const { warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath }) }),
      );
      expect(warning).toBeUndefined();
    });

    it('keeps the configured name when the logo is rejected', () => {
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({
          user: brandSettings({
            name: 'QiuQiu Code',
            logoPath: path.join(dir, 'missing.svg'),
          }),
        }),
      );
      expect(brand).toEqual({ name: 'QiuQiu Code' });
      expect(warning).toContain('does not exist');
    });

    it.each([
      ['a missing file', () => path.join(dir, 'missing.svg'), 'does not exist'],
      ['a directory', () => dir, 'must be a regular file'],
      [
        'a document whose root is not svg',
        () => writeLogo('<html><body>not a logo</body></html>', 'page.html'),
        'is not an SVG document',
      ],
      [
        'a plain text file',
        () => writeLogo('just words', 'notes.txt'),
        'is not an SVG document',
      ],
      [
        'a file over the size cap',
        () =>
          writeLogo(`<svg>${'<!-- padding -->'.repeat(2400)}</svg>`, 'big.svg'),
        // Unique to the pre-read `stat.size` guard; the post-decode cap says
        // 'bytes once decoded' instead. Pinning the pre-read message matters:
        // that guard is what keeps an oversized file out of memory entirely.
        'exceeds 32768 bytes:',
      ],
    ])('rejects %s', (_label, makePath, expectedWarning) => {
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath: makePath() }) }),
      );
      expect(brand.logoDataUri).toBeUndefined();
      expect(warning).toContain(expectedWarning);
    });

    it('rejects a file whose decoded size exceeds the cap though its on-disk size does not', () => {
      // 0x80 is invalid UTF-8, so each byte decodes to a 3-byte U+FFFD: a
      // 32,768-byte file passes the pre-read stat check and can only be caught
      // by the post-decode byte-length check inside readRegularFileNoFollow.
      // Without this fixture the inner cap is unreachable from any shipped test.
      const file = path.join(dir, 'undecodable.svg');
      fs.writeFileSync(file, Buffer.alloc(32768, 0x80));
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath: file }) }),
      );
      expect(brand.logoDataUri).toBeUndefined();
      expect(warning).toContain('once decoded');
    });

    it('rejects an <svg> root that declares no SVG namespace', () => {
      // A bare <svg> root is only parsed as an image when it carries the SVG
      // namespace. Accepting this shape would ship a data URI that paints a
      // blank mark — and writes nothing to stderr, the one channel the
      // protocol reference promises the operator.
      const file = writeLogo(
        '<svg viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>',
      );
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath: file }) }),
      );
      expect(brand.logoDataUri).toBeUndefined();
      expect(warning).toContain('namespaced <svg>');
    });

    it("accepts whitespace around the xmlns attribute's equals sign", () => {
      // XML's grammar allows whitespace around an attribute's `=`, and a
      // browser's image loader parses this as SVG just fine — the namespace
      // check must not reject a renderable document over spacing.
      const file = writeLogo(
        '<svg xmlns = "http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>',
      );
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath: file }) }),
      );
      expect(warning).toBeUndefined();
      expect(brand.logoDataUri).toBeDefined();
    });

    it('accepts a quoted `>` in an attribute value before the xmlns', () => {
      // `>` is legal inside an XML attribute value; a scanner blind to quote
      // state ends the root tag early and misattributes the rejection. The
      // fixture carries a viewBox so only the quote handling is exercised.
      const file = writeLogo(
        '<svg viewBox="0 0 8 8" aria-label="Next >" xmlns="http://www.w3.org/2000/svg"><circle cx="4" cy="4" r="4"/></svg>',
      );
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath: file }) }),
      );
      expect(warning).toBeUndefined();
      expect(brand.logoDataUri).toBeDefined();
    });

    it("rejects an xmlns-shaped substring inside another attribute's value", () => {
      // The document declares NO default namespace — the match sits inside
      // `data-note`. Accepting it would ship a data URI that paints a blank
      // mark with nothing on stderr, the failure the namespace rule exists to
      // prevent.
      const file = writeLogo(
        '<svg viewBox="0 0 8 8" data-note=\'xmlns="http://www.w3.org/2000/svg"\'/>',
      );
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath: file }) }),
      );
      expect(brand.logoDataUri).toBeUndefined();
      expect(warning).toContain('namespaced <svg>');
    });

    it('rejects a prefix-only xmlns binding with no default namespace', () => {
      // Inkscape emits `xmlns:svg` beside the real `xmlns`; on its own it does
      // not put the root element in the SVG namespace.
      const file = writeLogo(
        '<svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 8 8"/>',
      );
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath: file }) }),
      );
      expect(brand.logoDataUri).toBeUndefined();
      expect(warning).toContain('namespaced <svg>');
    });

    it.each([
      ['a system literal containing >', '<!DOCTYPE svg SYSTEM "a>b.dtd">\n'],
      ['a system literal containing [', '<!DOCTYPE svg SYSTEM "svg[1.dtd">\n'],
      [
        'an internal subset entity containing ]',
        '<!DOCTYPE svg [ <!ENTITY gt "]"> ]>\n',
      ],
    ])('accepts a DOCTYPE with %s', (_label, prolog) => {
      // Quoted literals and the internal-subset bracket may hold `>`, `[` and
      // `]`; the scanner must not treat any of them as the end of the DOCTYPE.
      const file = writeLogo(prolog + LOGO_SVG);
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath: file }) }),
      );
      expect(warning).toBeUndefined();
      expect(brand.logoDataUri).toBeDefined();
    });

    it('warns but accepts when the root has no viewBox or dimensions', () => {
      // The browser loads this image successfully — no error event — but
      // without a viewBox or explicit width+height it cannot scale the
      // artwork into the fixed sidebar box and may paint a blank mark. The
      // daemon's stderr is the only channel that can tell the operator, so
      // the logo is accepted with an advisory rather than rejected.
      const file = writeLogo(
        '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="4" cy="4" r="4"/></svg>',
      );
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath: file }) }),
      );
      expect(brand.logoDataUri).toBeDefined();
      expect(warning).toContain('no viewBox or width/height');
    });

    it('does not warn when width and height stand in for a viewBox', () => {
      const file = writeLogo(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="4"/></svg>',
      );
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath: file }) }),
      );
      expect(warning).toBeUndefined();
      expect(brand.logoDataUri).toBeDefined();
    });

    it('rejects a symlink, even one pointing at a valid SVG', (ctx) => {
      const target = writeLogo(LOGO_SVG);
      const link = path.join(dir, 'link.svg');
      try {
        fs.symlinkSync(target, link);
      } catch {
        // Reported as a skip rather than an early return: a silent `return`
        // would show as a pass on a platform without symlink privileges, and
        // the refusal guard this test pins could then be deleted undetected.
        ctx.skip();
        return;
      }
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath: link }) }),
      );
      expect(brand.logoDataUri).toBeUndefined();
      expect(warning).toContain('must not be a symlink');
    });

    it('reports a hard-linked logo distinctly from a non-regular file', (ctx) => {
      const target = writeLogo(LOGO_SVG);
      const link = path.join(dir, 'hard.svg');
      try {
        fs.linkSync(target, link);
      } catch {
        ctx.skip(); // Same reason as the symlink case above.
        return;
      }
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath: link }) }),
      );
      // The file *is* a regular file, so the message must say what actually
      // refused it — otherwise the operator debugs permissions and spelling.
      expect(brand.logoDataUri).toBeUndefined();
      expect(warning).toContain('hard links');
    });

    it('refuses a file swapped between the lstat and the open', () => {
      // The fd identity re-check is the only thing that refuses a path whose
      // target was replaced (or hard-linked) after the pre-open guards ran.
      // Perturbing `ino` drives exactly that; deleting the re-check turns
      // this red — and it is also the last FIFO defence, since O_NONBLOCK
      // lets a read-only FIFO open succeed.
      const logoPath = writeLogo(LOGO_SVG);
      vi.mocked(fs.fstatSync).mockImplementationOnce(((fd: number) => {
        const stat = fsActual.fstatSync(fd);
        const fake = Object.create(Object.getPrototypeOf(stat)) as fs.Stats;
        Object.assign(fake, stat, { ino: stat.ino + 1 });
        return fake;
      }) as never);
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath }) }),
      );
      expect(brand.logoDataUri).toBeUndefined();
      expect(warning).toContain('changed while it was being read');
    });

    it('soft-fails a path that cannot be statted', () => {
      // logo.svg is a regular file, so logo.svg/nested.svg raises ENOTDIR on
      // lstat — the soft-fail must keep the configured name and report the
      // published `ui.brand.logoPath is not readable` line, not blow up.
      const logoPath = writeLogo(LOGO_SVG);
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({
          user: brandSettings({
            name: 'QiuQiu Code',
            logoPath: path.join(logoPath, 'nested.svg'),
          }),
        }),
      );
      expect(brand).toEqual({ name: 'QiuQiu Code' });
      expect(warning).toContain('is not readable');
    });

    it('soft-fails when the path cannot be resolved', () => {
      const logoPath = writeLogo(LOGO_SVG);
      vi.mocked(fs.realpathSync).mockImplementationOnce((() => {
        const error = new Error(
          'too many levels of symbolic links',
        ) as NodeJS.ErrnoException;
        error.code = 'ELOOP';
        throw error;
      }) as never);
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath }) }),
      );
      expect(brand.logoDataUri).toBeUndefined();
      expect(warning).toContain('is not resolvable');
    });

    it('expands a leading tilde against the home directory', (ctx) => {
      const previousHome = process.env['HOME'];
      const previousProfile = process.env['USERPROFILE'];
      process.env['HOME'] = dir;
      process.env['USERPROFILE'] = dir;
      try {
        if (os.homedir() !== path.normalize(dir)) {
          // Reported as a skip rather than an early return: a silent `return`
          // would show as a pass on a platform that resolves the home directory
          // from the password database instead of the environment.
          ctx.skip();
          return;
        }
        writeLogo(LOGO_SVG, 'tilde-logo.svg');
        const { brand, warning } = resolveWebShellBrand(
          makeSettings({
            user: brandSettings({ logoPath: '~/tilde-logo.svg' }),
          }),
        );
        expect(warning).toBeUndefined();
        expect(brand.logoDataUri).toBeDefined();
      } finally {
        if (previousHome === undefined) delete process.env['HOME'];
        else process.env['HOME'] = previousHome;
        if (previousProfile === undefined) delete process.env['USERPROFILE'];
        else process.env['USERPROFILE'] = previousProfile;
      }
    });

    it('resolves a relative path against the settings file that declared it', () => {
      fs.mkdirSync(path.join(dir, 'brand'));
      fs.writeFileSync(path.join(dir, 'brand', 'logo.svg'), LOGO_SVG, 'utf-8');

      const { brand, warning } = resolveWebShellBrand(
        makeSettings({
          user: brandSettings({ logoPath: 'brand/logo.svg' }),
          userPath: path.join(dir, 'settings.json'),
        }),
      );

      expect(warning).toBeUndefined();
      expect(brand.logoDataUri).toBeDefined();
    });

    it('rejects a relative path whose settings layer has no owning file', () => {
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({
          user: brandSettings({ logoPath: 'brand/logo.svg' }),
          userPath: '',
        }),
      );

      expect(brand.logoDataUri).toBeUndefined();
      expect(warning).toContain('no owning file directory');
    });

    it('accepts an SVG that contains script, because the client renders it as an image', () => {
      // The resolver passes bytes through: SVG loaded as an image cannot run
      // script, and the sidebar and the favicon both render the data URI
      // through an image context. The alarm for a renderer that ever INLINES
      // those bytes lives in the sidebar test (it asserts an img src and zero
      // script nodes in the document) — this test stays green by design then,
      // which is exactly why that other test exists.
      const logoPath = writeLogo(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>alert(1)</script></svg>',
      );
      const { brand, warning } = resolveWebShellBrand(
        makeSettings({ user: brandSettings({ logoPath }) }),
      );
      expect(warning).toBeUndefined();
      expect(brand.logoDataUri).toContain('data:image/svg+xml,');
    });
  });

  describe('TUI banner parity', () => {
    // The resolver's own comments and the schema description claim the name is
    // sanitized exactly like the TUI banner title — strip, fold, clamp at 80,
    // drop empty — but nothing joined the two implementations until this test.
    // `resolveCustomBanner` is that sanitizer's only other consumer, so if
    // either side drifts, this goes red.
    it.each([
      ['plain', 'QiuQiu Code'],
      ['escape sequences and newlines', '\u001b[31mQiuQiu\u001b[0m\n\nCode'],
      ['over the 80 character cap', 'x'.repeat(120)],
      ['nothing but escape sequences', '\u001b[31m\u001b[0m'],
    ])('sanitizes %s identically to the TUI banner title', (_label, raw) => {
      const settings = makeSettings({
        user: {
          ui: { brand: { name: raw }, customBannerTitle: raw },
        } as Settings,
      });
      expect(resolveWebShellBrand(settings).brand.name).toBe(
        resolveCustomBanner(settings).title,
      );
    });
  });
});
