/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { classifyPastedImagePaths } from './pasted-image-paths.js';

describe('classifyPastedImagePaths', () => {
  it.each<[string, string[]]>([
    ["'/a/one.png' '/b/two.jpg'", ['/a/one.png', '/b/two.jpg']],
    ['"/a/one.png" "/b/two.jpg"', ['/a/one.png', '/b/two.jpg']],
    [
      '"/a/my image.png" \'/b/other image.jpg\'',
      ['/a/my image.png', '/b/other image.jpg'],
    ],
    [
      String.raw`"C:\a\one.png" "C:\b\two.jpg"`,
      [String.raw`C:\a\one.png`, String.raw`C:\b\two.jpg`],
    ],
    [
      String.raw`"C:\My Images\one.png" "D:\Other Images\two.jpg"`,
      [String.raw`C:\My Images\one.png`, String.raw`D:\Other Images\two.jpg`],
    ],
    [
      '@/a/one.png @"/b/two.jpg" @\'/c/three.webp\'',
      ['/a/one.png', '/b/two.jpg', '/c/three.webp'],
    ],
    [
      '"/a/one.png" /b/two.jpg\n\'/c/three.webp\'',
      ['/a/one.png', '/b/two.jpg', '/c/three.webp'],
    ],
    ['/a/my\\ image.png /b/two.png', ['/a/my image.png', '/b/two.png']],
    ['/a/my\\ /image.png /b/two.png', ['/a/my /image.png', '/b/two.png']],
    ['"/a/part /one.png" "/b/two.jpg"', ['/a/part /one.png', '/b/two.jpg']],
    ['"/a/O\'Reilly.png" "/b/two.jpg"', ["/a/O'Reilly.png", '/b/two.jpg']],
    ['/a/one.png /b/two.jpg', ['/a/one.png', '/b/two.jpg']],
    ['"/a/my image.png"', ['/a/my image.png']],
  ])('classifies image paths in %s', (input, imagePaths) => {
    expect(classifyPastedImagePaths(input)).toEqual({
      imagePaths,
      allImages: true,
    });
  });

  it('retains normal text handling for mixed or non-image input', () => {
    for (const input of [
      '',
      'just some text',
      '/src/index.ts',
      '@/a/img.png describe this',
      'describe this "/a/img.png"',
      '"/a/img.png" /src/index.ts',
    ]) {
      expect(classifyPastedImagePaths(input).allImages).toBe(false);
    }
  });

  it('keeps quoted local file URIs separate and decodes their names', () => {
    const paths = ['one image.png', 'two image.jpg'].map((name) =>
      path.resolve(name),
    );
    const input = paths
      .map((name) => `"${pathToFileURL(name).href}"`)
      .join(' ');
    expect(classifyPastedImagePaths(input)).toEqual({
      imagePaths: paths,
      allImages: true,
    });
  });

  it.each([
    'file://attacker.example.com/share/shot.png',
    'File://attacker.example.com/share/shot.png',
    'FILE://attacker.example.com/share/shot.png',
    'file:////attacker.example.com/share/shot.png',
    String.raw`\\attacker.example.com\share\shot.png`,
    '//attacker.example.com/share/shot.png',
  ])('does not promote remote or UNC input %s', (remote) => {
    for (const token of [remote, `"${remote}"`, `'${remote}'`]) {
      expect(classifyPastedImagePaths(token)).toEqual({
        imagePaths: [],
        allImages: false,
      });
      expect(classifyPastedImagePaths(`"/a/local.png" ${token}`)).toEqual({
        imagePaths: ['/a/local.png'],
        allImages: false,
      });
    }
  });
});
