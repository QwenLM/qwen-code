/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ASSET_BYTES,
  assetsBranch,
  parseAssetsRepo,
  rawAssetUrl,
  remoteAssetPath,
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
    for (const bad of ['just-a-name', 'a/b/c', 'a b/c', 'o/r?x=1', ' / ']) {
      const r = parseAssetsRepo(bad);
      expect('error' in r, bad).toBe(true);
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
