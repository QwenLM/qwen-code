/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUploadArgs, uploadAssets } from '../upload-aliyun-oss-assets.js';

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

describe('uploadAssets (integration)', () => {
  function prependProcessPath(directory) {
    const pathKeys = Object.keys(process.env).filter(
      (key) => key.toLowerCase() === 'path',
    );
    const pathKey = pathKeys[0] || 'PATH';
    const previousValues = new Map(
      pathKeys.map((key) => [key, process.env[key]]),
    );
    const nextValue = `${directory}${path.delimiter}${process.env[pathKey] || ''}`;

    if (pathKeys.length === 0) {
      process.env[pathKey] = nextValue;
    } else {
      for (const key of pathKeys) {
        process.env[key] = nextValue;
      }
    }
    return () => {
      if (previousValues.size === 0) {
        delete process.env[pathKey];
        return;
      }
      for (const key of pathKeys) {
        const previousValue = previousValues.get(key);
        if (previousValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previousValue;
        }
      }
    };
  }

  function makeOssutilShim(workDir, behavior = 'success') {
    fs.mkdirSync(workDir, { recursive: true });
    const ossutilPath = path.join(
      workDir,
      process.platform === 'win32' ? 'ossutil.cmd' : 'ossutil',
    );
    const logPath = path.join(workDir, 'ossutil.log');
    if (process.platform === 'win32') {
      const successScript = [
        '@echo off',
        ':log_args',
        'if "%~1"=="" goto done_log_args',
        `>>"${logPath}" echo(%~1`,
        'shift',
        'goto log_args',
        ':done_log_args',
        'exit /b 0',
        '',
      ].join('\r\n');
      const failScript = [
        '@echo off',
        ':log_args',
        'if "%~1"=="" goto done_log_args',
        `>>"${logPath}" echo(%~1`,
        'shift',
        'goto log_args',
        ':done_log_args',
        'exit /b 1',
        '',
      ].join('\r\n');
      fs.writeFileSync(
        ossutilPath,
        behavior === 'fail' ? failScript : successScript,
      );
      return { ossutilPath, logPath };
    }

    const successScript = `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "${logPath}"
exit 0
`;
    const failScript = `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "${logPath}"
exit 1
`;
    fs.writeFileSync(
      ossutilPath,
      behavior === 'fail' ? failScript : successScript,
    );
    fs.chmodSync(ossutilPath, 0o755);
    return { ossutilPath, logPath };
  }

  it('spawns ossutil with the expected cp arguments per asset', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-upload-'));
    try {
      const { logPath } = makeOssutilShim(tmp);
      const assets = ['a.tar.gz', 'b.zip'].map((name) => {
        const filePath = path.join(tmp, name);
        fs.writeFileSync(filePath, name);
        return filePath;
      });
      const configPath = path.join(tmp, '.ossutilconfig');
      fs.writeFileSync(configPath, '[Credentials]\n');

      const restorePath = prependProcessPath(tmp);
      try {
        uploadAssets({
          assets,
          bucket: 'qwen-test-bucket',
          config: configPath,
          prefix: 'releases/qwen-code/v0.0.0',
        });
      } finally {
        restorePath();
      }

      const log = fs.readFileSync(logPath, 'utf8');
      expect(log).toContain(
        `oss://qwen-test-bucket/releases/qwen-code/v0.0.0/a.tar.gz`,
      );
      expect(log).toContain(
        `oss://qwen-test-bucket/releases/qwen-code/v0.0.0/b.zip`,
      );
      expect(log).toContain(`-c\n${configPath}`);
      expect(log).toContain('--acl\npublic-read');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('aggregates failures from ossutil non-zero exits', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-upload-fail-'));
    try {
      const { logPath } = makeOssutilShim(tmp, 'fail');
      const assetPath = path.join(tmp, 'asset.tar.gz');
      fs.writeFileSync(assetPath, 'asset');
      const configPath = path.join(tmp, '.ossutilconfig');
      fs.writeFileSync(configPath, '[Credentials]\n');

      const restorePath = prependProcessPath(tmp);
      try {
        expect(() =>
          uploadAssets({
            assets: [assetPath],
            bucket: 'qwen-test-bucket',
            config: configPath,
            prefix: 'releases/qwen-code/v0.0.0',
          }),
        ).toThrow(/ossutil failed after 3 attempts/);
        const uploadAttempts = fs
          .readFileSync(logPath, 'utf8')
          .split(/\r?\n/)
          .filter((line) => line === assetPath);
        expect(uploadAttempts).toHaveLength(3);
      } finally {
        restorePath();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
