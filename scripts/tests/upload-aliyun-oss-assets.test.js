/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseUploadArgs } from '../upload-aliyun-oss-assets.js';

describe('parseUploadArgs', () => {
  it('returns help=true and skips later validation when --help is passed', () => {
    const args = parseUploadArgs(['--help']);
    expect(args.help).toBe(true);
    // Other fields stay at their defaults; no fail() is thrown.
    expect(args.assets).toEqual([]);
  });

  it('parses required options and asset list', () => {
    const args = parseUploadArgs([
      '--bucket',
      'my-bucket',
      '--config',
      '/tmp/.ossutilconfig',
      '--prefix',
      'releases/qwen-code/v1.2.3',
      'a.tar.gz',
      'b.zip',
    ]);
    expect(args).toMatchObject({
      bucket: 'my-bucket',
      config: '/tmp/.ossutilconfig',
      prefix: 'releases/qwen-code/v1.2.3',
      assets: ['a.tar.gz', 'b.zip'],
      help: false,
    });
  });

  it('strips a trailing slash from --prefix', () => {
    const args = parseUploadArgs([
      '--bucket',
      'b',
      '--config',
      'c',
      '--prefix',
      'installation/',
      'one.txt',
    ]);
    expect(args.prefix).toBe('installation');
  });

  it.each([
    [['--bucket', 'b', '--config', 'c', 'asset.txt'], '--prefix'],
    [['--config', 'c', '--prefix', 'p', 'asset.txt'], '--bucket'],
    [['--bucket', 'b', '--prefix', 'p', 'asset.txt'], '--config'],
    [['--bucket', 'b', '--config', 'c', '--prefix', 'p'], 'ASSET path'],
  ])('rejects when %j is missing', (argv, expectedFragment) => {
    expect(() => parseUploadArgs(argv)).toThrow(
      new RegExp(expectedFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('rejects unknown options', () => {
    expect(() =>
      parseUploadArgs([
        '--bucket',
        'b',
        '--config',
        'c',
        '--prefix',
        'p',
        '--bogus',
        'asset.txt',
      ]),
    ).toThrow(/Unknown option: --bogus/);
  });

  it('errors when an option is missing its value', () => {
    expect(() => parseUploadArgs(['--bucket'])).toThrow();
  });
});
