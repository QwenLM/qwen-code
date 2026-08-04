/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ASSET_EXTENSIONS,
  MAX_ASSET_BYTES,
  MAX_TOTAL_ASSET_BYTES,
  assetsBranch,
  parseAssetsRepo,
  rawAssetUrl,
  remoteAssetPath,
  validateAssetBatch,
  validateAssetFile,
  sniffImageFormat,
  validateAssetContent,
} from './assets.js';

describe('assetsBranch', () => {
  it('mirrors the manual convention with a -review suffix', () => {
    // `-review` so hand-published evidence (`pr-assets/<PR>-verify`) and
    // review-published evidence never collide on one branch.
    expect(assetsBranch(8346)).toBe('pr-assets/8346-review');
  });
});

describe('remoteAssetPath', () => {
  const sha = 'abcdef0123456789'.repeat(4);

  it('prefixes the content hash so same-named files cannot collide', () => {
    const a = remoteAssetPath(7, 'before.png', sha);
    const b = remoteAssetPath(7, 'before.png', 'f'.repeat(64));
    expect(a).not.toBe(b);
    expect(a).toBe(`7-review/${sha.slice(0, 12)}-before.png`);
  });

  it('is idempotent for identical content — re-runs dedupe naturally', () => {
    expect(remoteAssetPath(7, 'a.png', sha)).toBe(
      remoteAssetPath(7, 'a.png', sha),
    );
  });

  it('sanitizes a hostile basename before it reaches a URL or git path', () => {
    expect(remoteAssetPath(7, 'a b/../$(x).png', sha)).toBe(
      `7-review/${sha.slice(0, 12)}-a_b_.._$_x_.png`.replace('$', '_'),
    );
  });
});

describe('rawAssetUrl', () => {
  it('pins to the commit, not the branch', () => {
    // A branch-addressed URL re-resolves on every push; a comment's evidence
    // must keep meaning what it meant when posted.
    const url = rawAssetUrl({
      repo: 'o/r',
      commitSha: 'deadbeef',
      remotePath: '7-review/x.png',
    });
    expect(url).toBe('https://github.com/o/r/raw/deadbeef/7-review/x.png');
    expect(url).not.toContain('pr-assets');
  });

  it('uses the web-host /raw/ form so Enterprise hosts work unchanged', () => {
    expect(
      rawAssetUrl({
        host: 'github.example.com',
        repo: 'o/r',
        commitSha: 'cafe',
        remotePath: 'p.png',
      }),
    ).toBe('https://github.example.com/o/r/raw/cafe/p.png');
  });
});

describe('parseAssetsRepo', () => {
  it('refuses an unset designation with an explanation, not a crash', () => {
    const r = parseAssetsRepo(undefined);
    expect('error' in r && r.error).toMatch(/QWEN_REVIEW_ASSETS_REPO/);
  });

  it('accepts owner/repo and nothing fancier', () => {
    expect(parseAssetsRepo('QwenLM/qwen-code')).toEqual({
      repo: 'QwenLM/qwen-code',
    });
    for (const bad of [
      'just-a-name',
      'a/b/c',
      'a b/c',
      'o/r?x=1',
      ' / ',
      // Dot segments are legal characters that mean something else in a URL
      // path — the same rule submit's isRepo enforces.
      'owner/..',
      '../repo',
      './x',
      'x/.',
    ]) {
      const r = parseAssetsRepo(bad);
      // Name the offending value in the assertion itself, so a regression
      // says which shape slipped through rather than "expected true".
      expect({ value: bad, refused: 'error' in r }).toEqual({
        value: bad,
        refused: true,
      });
    }
  });
});

describe('validateAssetFile', () => {
  it('allows the image types and only the image types', () => {
    expect(validateAssetFile('a.png', 100).ok).toBe(true);
    expect(validateAssetFile('a.JPG', 100).ok).toBe(true);
    expect(validateAssetFile('a.webp', 100).ok).toBe(true);
  });

  it.each([
    // SVG is a script container; the rest are simply not evidence images.
    'evil.svg',
    'a.pdf',
    'a.html',
    'a.png.sh',
    'noext',
  ])('refuses %s', (name) => {
    const r = validateAssetFile(name, 100);
    expect(r.ok).toBe(false);
  });

  it('refuses an empty file and an oversized one, naming the cap', () => {
    expect(validateAssetFile('a.png', 0).ok).toBe(false);
    const big = validateAssetFile('a.png', MAX_ASSET_BYTES + 1);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.reason).toContain(String(MAX_ASSET_BYTES));
  });
});

describe('validateAssetBatch', () => {
  it('refuses a batch whose files individually pass but jointly exceed the cap', () => {
    // Five 9MB files: each clears the 10MB per-file cap, 45MB total does not.
    // Pure sizes, no fixtures — that is why the ruling lives in the lib.
    const nine = 9 * 1024 * 1024;
    const files = Array.from({ length: 5 }, (_, i) => ({
      basename: `shot-${i}.png`,
      bytes: nine,
    }));
    const r = validateAssetBatch(files);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(String(MAX_TOTAL_ASSET_BYTES));
    // Four of the same pass.
    expect(validateAssetBatch(files.slice(0, 4)).ok).toBe(true);
  });

  it('surfaces a per-file refusal with the file named', () => {
    const r = validateAssetBatch([
      { basename: 'ok.png', bytes: 100 },
      { basename: 'evil.svg', bytes: 100 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('evil.svg');
  });
});

describe('sniffImageFormat / validateAssetContent', () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const GIF = Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0)));
  const GIF87 = Uint8Array.from([...'GIF87a'].map((c) => c.charCodeAt(0)));
  const WEBP = Uint8Array.from(
    [...'RIFF\u0000\u0000\u0000\u0000WEBP'].map((c) => c.charCodeAt(0)),
  );

  it('recognizes the four admitted signatures', () => {
    expect(sniffImageFormat(PNG)).toBe('png');
    expect(sniffImageFormat(JPEG)).toBe('jpeg');
    expect(sniffImageFormat(GIF)).toBe('gif');
    expect(sniffImageFormat(GIF87)).toBe('gif');
    expect(sniffImageFormat(WEBP)).toBe('webp');
  });

  it('returns null for non-images, truncated or near-miss headers, and empty input', () => {
    expect(
      sniffImageFormat(
        Uint8Array.from([...'#!/bin/sh\n'].map((c) => c.charCodeAt(0))),
      ),
    ).toBeNull();
    expect(sniffImageFormat(PNG.subarray(0, 4))).toBeNull();
    expect(sniffImageFormat(Uint8Array.from([]))).toBeNull();
    // RIFF alone is not WEBP — AVI and WAV share the container prefix.
    expect(
      sniffImageFormat(
        Uint8Array.from([...'RIFF0000AVI '].map((c) => c.charCodeAt(0))),
      ),
    ).toBeNull();
    // Depth pins: each signature component is checked to its full length, so
    // bytes one compare short of a real signature — in ANY position — are not
    // admitted. A WEBP marker without the RIFF container prefix is not WEBP
    // either.
    expect(sniffImageFormat(Uint8Array.from([0xff, 0xd8, 0x00]))).toBeNull();
    expect(sniffImageFormat(Uint8Array.from([0x00, 0xd8, 0xff]))).toBeNull();
    expect(sniffImageFormat(Uint8Array.from([0xff, 0x00, 0xff]))).toBeNull();
    expect(
      sniffImageFormat(
        Uint8Array.from([0x00, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBeNull();
    expect(
      sniffImageFormat(
        Uint8Array.from([0x89, 0x58, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBeNull();
    expect(
      sniffImageFormat(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBeNull();
    expect(
      sniffImageFormat(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x00, 0x1a, 0x0a]),
      ),
    ).toBeNull();
    expect(
      sniffImageFormat(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x0a]),
      ),
    ).toBeNull();
    const pngByte7Off = Uint8Array.from(PNG);
    pngByte7Off[7] = 0x0b;
    expect(sniffImageFormat(pngByte7Off)).toBeNull();
    expect(
      sniffImageFormat(
        Uint8Array.from([...'RIFF0000WEB '].map((c) => c.charCodeAt(0))),
      ),
    ).toBeNull();
    expect(
      sniffImageFormat(
        Uint8Array.from([...'XXXX0000WEBP'].map((c) => c.charCodeAt(0))),
      ),
    ).toBeNull();
    expect(
      sniffImageFormat(
        Uint8Array.from([...'GIF89b'].map((c) => c.charCodeAt(0))),
      ),
    ).toBeNull();
    // The same one-compare-short refusal INSIDE the multi-byte ascii() runs:
    // each row corrupts exactly one byte of a real signature, and every byte
    // of every run appears — GIF in BOTH variants, because a shared-prefix
    // corruption in one variant is refused by the other's intact checks only
    // through the byte where the variants differ, which a byte-4 edit could
    // move. Without both forms, one run's dropped comparison survives green.
    const oneByteOff: number[][] = [
      // PNG bytes 2-3 (bytes 0-1 and 4-7 are pinned above)
      [0x89, 0x50, 0x58, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      [0x89, 0x50, 0x4e, 0x58, 0x0d, 0x0a, 0x1a, 0x0a],
      // GIF bytes 0-3 and 5 in each variant form; byte 4 once — the same
      // corrupted byte covers both variants' checks at that position
      ...[
        'XIF87a',
        'GXF87a',
        'GIX87a',
        'GIFX7a',
        'GIF87X',
        'XIF89a',
        'GXF89a',
        'GIX89a',
        'GIFX9a',
        'GIF8Xa',
        // RIFF container bytes 0-3 and WEBP marker bytes 8-10 (byte 11 is
        // pinned above)
        'XIFF\u0000\u0000\u0000\u0000WEBP',
        'RXFF\u0000\u0000\u0000\u0000WEBP',
        'RIXF\u0000\u0000\u0000\u0000WEBP',
        'RIFX\u0000\u0000\u0000\u0000WEBP',
        'RIFF\u0000\u0000\u0000\u0000XEBP',
        'RIFF\u0000\u0000\u0000\u0000WXBP',
        'RIFF\u0000\u0000\u0000\u0000WEXP',
      ].map((s) => [...s].map((c) => c.charCodeAt(0))),
    ];
    for (const header of oneByteOff) {
      expect(sniffImageFormat(Uint8Array.from(header))).toBeNull();
    }
  });

  it('admits content that matches the extension claim', () => {
    expect(validateAssetContent('a.png', PNG).ok).toBe(true);
    expect(validateAssetContent('b.jpg', JPEG).ok).toBe(true);
    expect(validateAssetContent('b.jpeg', JPEG).ok).toBe(true);
    expect(validateAssetContent('c.gif', GIF).ok).toBe(true);
    expect(validateAssetContent('c87.gif', GIF87).ok).toBe(true);
    expect(validateAssetContent('d.webp', WEBP).ok).toBe(true);
    // The batch gate lowercases extensions; the content gate must agree.
    expect(validateAssetContent('E.JPG', JPEG).ok).toBe(true);
  });

  it('refuses a name whose content is a different format — or no image at all', () => {
    // The attack shape: arbitrary bytes named *.png hosted at a github.com
    // URL through a review's evidence push.
    const shell = Uint8Array.from(
      [...'#!/bin/sh\n'].map((c) => c.charCodeAt(0)),
    );
    const r1 = validateAssetContent('evil.png', shell);
    expect(r1.ok).toBe(false);
    if (!r1.ok)
      expect(r1.reason).toContain(
        'content is not a recognized image but the extension claims png',
      );
    const r2 = validateAssetContent('mislabeled.png', JPEG);
    expect(r2.ok).toBe(false);
    // Direction matters to the operator: what the content IS comes first.
    if (!r2.ok)
      expect(r2.reason).toContain(
        'content is jpeg but the extension claims png',
      );
  });

  it('fails closed on an extension outside the allowlist', () => {
    expect(validateAssetContent('x.svg', PNG).ok).toBe(false);
    expect(validateAssetContent('noext', PNG).ok).toBe(false);
    // Inherited Object.prototype keys are not allowlist hits: the refusal
    // must come from the allowlist branch, not the content comparison.
    const proto = validateAssetContent('x.__proto__', PNG);
    expect(proto.ok).toBe(false);
    if (!proto.ok) expect(proto.reason).toContain('is not an allowed');
  });

  it('admits every allowed extension by content — the two gates agree', () => {
    // Admitting a format is a TWO-place change: the allowlist key and the
    // matching sniffImageFormat branch. This pin binds them — a format
    // admitted by name whose signature the sniffer does not recognize would
    // refuse every real file of it while CI stayed green. Naming the
    // extension in the assertion itself says WHICH admission is dead.
    const canonical: Record<string, Uint8Array> = {
      png: PNG,
      jpg: JPEG,
      jpeg: JPEG,
      gif: GIF,
      webp: WEBP,
    };
    for (const ext of ASSET_EXTENSIONS) {
      const bytes = canonical[ext];
      expect({
        ext,
        admittedByContent:
          bytes !== undefined && validateAssetContent(`probe.${ext}`, bytes).ok,
      }).toEqual({ ext, admittedByContent: true });
    }
  });
});
