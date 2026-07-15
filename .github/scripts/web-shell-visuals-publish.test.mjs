/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildComment,
  classifyMagic,
  MAX_BYTES,
  MAX_CANDIDATES,
  MAX_GIFS,
  MAX_SCREENSHOTS,
  sanitizeName,
  selectImages,
} from './web-shell-visuals-publish.mjs';

const PNG = '89504e470d0a1a0a';
const GIF89 = '474946383961';
const GIF87 = '474946383761';

test('sanitizeName preserves the extension (regression: a trailing char broke the .png filter)', () => {
  assert.equal(
    sanitizeName('session-transcript-light.png'),
    'session-transcript-light.png',
  );
  assert.match(sanitizeName('model-dialog-dark.png'), /\.png$/);
  assert.match(sanitizeName('model-switch.gif'), /\.gif$/);
  // Disallowed characters become `_`, but the extension is untouched.
  assert.equal(sanitizeName('weird name!.png'), 'weird_name_.png');
  assert.equal(sanitizeName('trailing.png\n'), 'trailing.png_');
});

test('classifyMagic accepts real PNG/GIF magic and rejects mismatches', () => {
  assert.equal(classifyMagic('png', PNG), 'png');
  assert.equal(classifyMagic('gif', GIF89), 'gif');
  assert.equal(classifyMagic('gif', GIF87), 'gif');
  assert.equal(classifyMagic('png', GIF89), null); // GIF bytes in a .png
  assert.equal(classifyMagic('gif', PNG), null); // PNG bytes in a .gif
  assert.equal(classifyMagic('png', 'deadbeefdeadbeef'), null);
  assert.equal(classifyMagic('svg', PNG), null); // unknown extension
});

test('selectImages accepts valid images and keeps safe, extension-correct names', () => {
  const { accepted, warnings } = selectImages([
    { name: 'a-light.png', ext: 'png', size: 100, magic: PNG },
    { name: 'a-dark.png', ext: 'png', size: 100, magic: PNG },
    { name: 'model-switch.gif', ext: 'gif', size: 100, magic: GIF89 },
  ]);
  assert.equal(accepted.length, 3);
  assert.deepEqual(
    accepted.map((a) => a.safeName),
    ['a-light.png', 'a-dark.png', 'model-switch.gif'],
  );
  assert.deepEqual(warnings, []);
});

test('selectImages skips oversized and magic-invalid files', () => {
  let r = selectImages([
    { name: 'big.png', ext: 'png', size: MAX_BYTES + 1, magic: PNG },
  ]);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('exceeds')));

  r = selectImages([{ name: 'fake.png', ext: 'png', size: 10, magic: GIF89 }]);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('not a valid')));
});

test('selectImages caps screenshots per-kind WITHOUT starving gifs', () => {
  const many = [
    ...Array.from({ length: MAX_SCREENSHOTS + 5 }, (_, i) => ({
      name: `s${i}-light.png`,
      ext: 'png',
      size: 10,
      magic: PNG,
    })),
    { name: 'model-switch.gif', ext: 'gif', size: 10, magic: GIF89 },
  ];
  const { accepted } = selectImages(many);
  const png = accepted.filter((a) => a.kind === 'png').length;
  const gif = accepted.filter((a) => a.kind === 'gif').length;
  assert.equal(png, MAX_SCREENSHOTS); // screenshots capped
  assert.equal(gif, 1); // the gif survives the screenshot flood (not starved)
});

test('selectImages caps gifs per-kind', () => {
  const gifs = Array.from({ length: MAX_GIFS + 3 }, (_, i) => ({
    name: `flow${i}.gif`,
    ext: 'gif',
    size: 10,
    magic: GIF89,
  }));
  assert.equal(selectImages(gifs).accepted.length, MAX_GIFS);
});

test('selectImages bounds EXAMINED candidates so a junk flood cannot run forever', () => {
  const flood = Array.from({ length: MAX_CANDIDATES + 50 }, (_, i) => ({
    name: `x${i}.png`,
    ext: 'png',
    size: 10,
    magic: '00000000', // all invalid
  }));
  const { accepted, warnings } = selectImages(flood);
  assert.equal(accepted.length, 0);
  assert.ok(warnings.some((w) => w.includes('candidate files')));
});

test('buildComment lists before/after composites, labels flows, escapes, links the run', () => {
  const body = buildComment(
    [
      'session-transcript-light.png',
      'session-transcript-dark.png',
      'model-switch.gif',
    ],
    {
      rawBase: 'https://raw.example/imgs',
      shortSha: 'abc1234',
      runUrl: 'https://run.example/1',
    },
  );
  assert.match(body, /<!-- qwen:web-shell-visuals -->/);
  assert.match(body, /session-transcript-light\.png/);
  assert.match(body, /session-transcript-dark\.png/);
  assert.match(body, /Only \*\*screenshots\*\* that changed are shown/); // before/after framing
  assert.match(body, /model-switch\.gif/);
  assert.match(body, /Open the slash menu and switch model/); // flow label
  assert.match(body, /abc1234/);
  assert.match(body, /https:\/\/run\.example\/1/);
  // Each changed composite is listed as its own wide image (light + dark).
  const shotImgs = body
    .split('\n')
    .filter((l) => /^<img /.test(l) && /\.png/.test(l));
  assert.equal(shotImgs.length, 2);
  assert.doesNotMatch(body, /<table>/); // composites are a list, not a table
});

test('buildComment does not leak Object.prototype members as flow labels', () => {
  const body = buildComment(['toString.gif', 'constructor.gif'], {
    rawBase: 'r',
  });
  assert.doesNotMatch(body, /native code/);
  assert.match(body, /\*\*ToString\*\*/); // falls back to the prettified filename
});

test('buildComment says "no visual changes" when there are no composites', () => {
  const empty = buildComment([], { shortSha: 'abc1234' });
  assert.match(empty, /web-shell visual preview/);
  assert.doesNotMatch(empty, /<img /); // no screenshots, no flows
  assert.match(empty, /No screenshot changes against `main`/);
});

test('buildComment lists a lone composite as one wide image (no light/dark table)', () => {
  const body = buildComment(['home-light.png'], { rawBase: 'r' });
  assert.match(body, /<img src="r\/home-light\.png" width="900"/);
  assert.doesNotMatch(body, /<table>/); // composites are a flat list now
  // A lone light shot no longer needs a dark-pair placeholder cell.
  assert.doesNotMatch(body, /<td>/);
});
