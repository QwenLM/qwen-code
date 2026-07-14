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
  MAX_IMAGES,
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

test('selectImages enforces the accepted-image cap', () => {
  const many = Array.from({ length: MAX_IMAGES + 5 }, (_, i) => ({
    name: `s${i}-light.png`,
    ext: 'png',
    size: 10,
    magic: PNG,
  }));
  const { accepted, warnings } = selectImages(many);
  assert.equal(accepted.length, MAX_IMAGES);
  assert.ok(warnings.some((w) => w.includes('image cap')));
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

test('buildComment pairs light/dark, lists gifs, labels flows, escapes, links the run', () => {
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
  assert.match(body, /model-switch\.gif/);
  assert.match(body, /Open the slash menu and switch model/); // flow label
  assert.match(body, /abc1234/);
  assert.match(body, /https:\/\/run\.example\/1/);
  // Exactly one screenshot row: the single view with light+dark paired.
  const rows = body.split('\n').filter((l) => l.startsWith('<tr><td'));
  assert.equal(rows.length, 1);
});

test('buildComment is empty-safe and marks a missing pair with an em dash', () => {
  const empty = buildComment([], {});
  assert.match(empty, /web-shell visual preview/);
  assert.doesNotMatch(empty, /<table>/); // no screenshots section

  const onlyLight = buildComment(['home-light.png'], { rawBase: 'r' });
  assert.match(onlyLight, /<td>—<\/td>/); // the missing dark cell
});
