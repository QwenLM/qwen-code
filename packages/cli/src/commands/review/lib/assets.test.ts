/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ASSET_EXTENSIONS,
  ASSET_HEADER_BYTES,
  MAX_ASSET_BYTES,
  MAX_TOTAL_ASSET_BYTES,
  assetsBranch,
  parseAssetsRepo,
  rawAssetUrl,
  remoteAssetPath,
  sniffImageFormat,
  validateAssetBatch,
  validateAssetContent,
  validateAssetFile,
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
    // A multi-dot name claims only its LAST extension (pins `lastIndexOf`
    // in `claimedExtension` — see the matching content-gate pin below).
    expect(validateAssetFile('figure-1.final.png', 100).ok).toBe(true);
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
    [...'RIFF\u0000\u0000\u0000\u0000WEBPVP8 '].map((c) => c.charCodeAt(0)),
  );

  it('recognizes the four admitted signatures', () => {
    expect(sniffImageFormat(PNG)).toBe('png');
    expect(sniffImageFormat(JPEG)).toBe('jpeg');
    expect(sniffImageFormat(GIF)).toBe('gif');
    expect(sniffImageFormat(GIF87)).toBe('gif');
    expect(sniffImageFormat(WEBP)).toBe('webp');
    // VP8L and VP8X are the other two first chunks a conformant WebP carries.
    for (const fourcc of ['VP8L', 'VP8X']) {
      expect(
        sniffImageFormat(
          Uint8Array.from(
            [...`RIFF\u0000\u0000\u0000\u0000WEBP${fourcc}`].map((c) =>
              c.charCodeAt(0),
            ),
          ),
        ),
      ).toBe('webp');
    }
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
    // A RIFF container claiming WEBP but holding no WebP bitstream chunk
    // (VP8/VP8L/VP8X) at byte 12 is not admitted either.
    expect(
      sniffImageFormat(
        Uint8Array.from(
          [...'RIFF\u0000\u0000\u0000\u0000WEBPALPH'].map((c) =>
            c.charCodeAt(0),
          ),
        ),
      ),
    ).toBeNull();
    // A WEBP marker without the RIFF container prefix is not WEBP either,
    // and an unknown GIF version is not admitted.
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
  });

  // Every checked byte of every admitted signature, corrupted one byte at a
  // time, refuses — GIF in both variants so a dropped compare in either
  // branch is caught, WEBP across both the RIFF and the WEBP runs.
  const sig = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
  const corruptedPng = (i: number, b: number): number[] => {
    const h = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    h[i] = b;
    return h;
  };
  const ONE_BYTE_OFF: Array<[string, number[]]> = [
    ['PNG byte 0', corruptedPng(0, 0x00)],
    ['PNG byte 1', corruptedPng(1, 0x58)],
    ['PNG byte 2', corruptedPng(2, 0x58)],
    ['PNG byte 3', corruptedPng(3, 0x58)],
    ['PNG byte 4', corruptedPng(4, 0x00)],
    ['PNG byte 5', corruptedPng(5, 0x00)],
    ['PNG byte 6', corruptedPng(6, 0x00)],
    ['PNG byte 7', corruptedPng(7, 0x0b)],
    ['JPEG byte 0', [0x00, 0xd8, 0xff]],
    ['JPEG byte 1', [0xff, 0x00, 0xff]],
    ['JPEG byte 2', [0xff, 0xd8, 0x00]],
    ['GIF87a byte 0', sig('XIF87a')],
    ['GIF87a byte 1', sig('GXF87a')],
    ['GIF87a byte 2', sig('GIX87a')],
    ['GIF87a byte 3', sig('GIFX7a')],
    ['GIF byte 4 (both variants)', sig('GIF8Xa')],
    ['GIF87a byte 5', sig('GIF87X')],
    ['GIF89a byte 0', sig('XIF89a')],
    ['GIF89a byte 1', sig('GXF89a')],
    ['GIF89a byte 2', sig('GIX89a')],
    ['GIF89a byte 3', sig('GIFX9a')],
    ['GIF89a byte 5', sig('GIF89X')],
    ['WEBP RIFF byte 0', sig('XIFF\u0000\u0000\u0000\u0000WEBP')],
    ['WEBP RIFF byte 1', sig('RXFF\u0000\u0000\u0000\u0000WEBP')],
    ['WEBP RIFF byte 2', sig('RIXF\u0000\u0000\u0000\u0000WEBP')],
    ['WEBP RIFF byte 3', sig('RIFX\u0000\u0000\u0000\u0000WEBP')],
    ['WEBP marker byte 8', sig('RIFF\u0000\u0000\u0000\u0000XEBP')],
    ['WEBP marker byte 9', sig('RIFF\u0000\u0000\u0000\u0000WXBP')],
    ['WEBP marker byte 10', sig('RIFF\u0000\u0000\u0000\u0000WEXP')],
    ['WEBP marker byte 11', sig('RIFF\u0000\u0000\u0000\u0000WEB ')],
    ['WEBP fourcc byte 12', sig('RIFF\u0000\u0000\u0000\u0000WEBPXP8 ')],
    ['WEBP fourcc byte 13', sig('RIFF\u0000\u0000\u0000\u0000WEBPVX8 ')],
    ['WEBP fourcc byte 14', sig('RIFF\u0000\u0000\u0000\u0000WEBPVPX ')],
    ['WEBP fourcc byte 15', sig('RIFF\u0000\u0000\u0000\u0000WEBPVP8\u0000')],
  ];

  it.each(ONE_BYTE_OFF)(
    'refuses %s — one byte off a real signature',
    (_label, header) => {
      expect(sniffImageFormat(Uint8Array.from(header))).toBeNull();
    },
  );

  it('admits content that matches the extension claim', () => {
    expect(validateAssetContent('a.png', PNG).ok).toBe(true);
    expect(validateAssetContent('b.jpg', JPEG).ok).toBe(true);
    expect(validateAssetContent('b.jpeg', JPEG).ok).toBe(true);
    expect(validateAssetContent('c.gif', GIF).ok).toBe(true);
    expect(validateAssetContent('c87.gif', GIF87).ok).toBe(true);
    expect(validateAssetContent('d.webp', WEBP).ok).toBe(true);
    // The batch gate lowercases extensions; the content gate must agree.
    expect(validateAssetContent('E.JPG', JPEG).ok).toBe(true);
    // A multi-dot name claims only its LAST extension — pins `lastIndexOf`
    // in `claimedExtension`: an `indexOf` mutant refuses this as
    // "final.png" (fail-closed, but a false refusal of real evidence)
    // while every other test in both suites stays green.
    expect(validateAssetContent('figure-1.final.png', PNG).ok).toBe(true);
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

  // The allowlist refusal is built once (`refusedExtension`) and both gates
  // must emit it byte-identically, so one expectation per input covers both
  // call sites: a gate that parses extensions (case, trailing dot) or
  // formats the refusal on its own again fails here instead of drifting
  // silently. Even real PNG bytes cannot save a disallowed extension.
  it.each([
    ['evil.svg', 'svg'],
    ['evil.SVG', 'svg'],
    // The refusal must name the LAST extension: the `indexOf` mutant's
    // `"png.sh"` reason is caught here in both gates at once.
    ['a.png.sh', 'sh'],
    ['archive.', ''],
    ['noext', ''],
  ])('refuses %s with the one shared refusal in both gates', (name, ext) => {
    const reason =
      `${name}: extension "${ext}" is not an allowed ` +
      `evidence image type (${[...ASSET_EXTENSIONS].join(', ')})`;
    expect(validateAssetFile(name, 100)).toEqual({ ok: false, reason });
    expect(validateAssetContent(name, PNG)).toEqual({ ok: false, reason });
  });

  it('admits every allowed extension by content — the two gates agree', () => {
    // Admitting a format is a TWO-place change: the allowlist key and the
    // matching sniffImageFormat branch. This pin binds them — a format
    // admitted by name whose signature the sniffer does not recognize
    // refuses every real file of it, and this assertion fails CI naming
    // WHICH admission is dead. Slicing to ASSET_HEADER_BYTES binds the
    // publish-time sniff depth too: a signature that runs past the constant
    // refuses here until the constant covers it.
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
          bytes !== undefined &&
          validateAssetContent(
            `probe.${ext}`,
            bytes.subarray(0, ASSET_HEADER_BYTES),
          ).ok,
      }).toEqual({ ext, admittedByContent: true });
    }
  });
});
