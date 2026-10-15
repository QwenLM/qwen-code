/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseUploadArgs,
  resolveAttemptTimeoutMs,
  uploadAssets,
} from '../upload-aliyun-oss-assets.js';

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
  function makeOssutilShim(workDir, behavior = 'success') {
    fs.mkdirSync(workDir, { recursive: true });
    const ossutilPath = path.join(workDir, 'ossutil-shim.cjs');
    const logPath = path.join(workDir, 'ossutil.log');
    const exitLine =
      behavior === 'hang'
        ? 'setTimeout(() => {}, 60000);' // never exits on its own
        : `process.exit(${behavior === 'fail' ? 1 : 0});`;
    fs.writeFileSync(
      ossutilPath,
      [
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join('\\n') + '\\n');`,
        exitLine,
        '',
      ].join('\n'),
    );
    return {
      logPath,
      ossutilCommand: process.execPath,
      ossutilCommandArgs: [ossutilPath],
    };
  }

  it('spawns ossutil with the expected cp arguments per asset', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-upload-'));
    try {
      const { logPath, ossutilCommand, ossutilCommandArgs } =
        makeOssutilShim(tmp);
      const assets = ['a.tar.gz', 'b.zip'].map((name) => {
        const filePath = path.join(tmp, name);
        fs.writeFileSync(filePath, name);
        return filePath;
      });
      const configPath = path.join(tmp, '.ossutilconfig');
      fs.writeFileSync(configPath, '[Credentials]\n');

      uploadAssets(
        {
          assets,
          bucket: 'qwen-test-bucket',
          config: configPath,
          prefix: 'releases/qwen-code/v0.0.0',
        },
        { ossutilCommand, ossutilCommandArgs },
      );

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
      const { logPath, ossutilCommand, ossutilCommandArgs } = makeOssutilShim(
        tmp,
        'fail',
      );
      const assetPath = path.join(tmp, 'asset.tar.gz');
      fs.writeFileSync(assetPath, 'asset');
      const configPath = path.join(tmp, '.ossutilconfig');
      fs.writeFileSync(configPath, '[Credentials]\n');

      expect(() =>
        uploadAssets(
          {
            assets: [assetPath],
            bucket: 'qwen-test-bucket',
            config: configPath,
            prefix: 'releases/qwen-code/v0.0.0',
          },
          { ossutilCommand, ossutilCommandArgs },
        ),
      ).toThrow(/ossutil failed after 3 attempts/);
      const uploadAttempts = fs
        .readFileSync(logPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line === assetPath);
      expect(uploadAttempts).toHaveLength(3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('kills a stalled attempt and retries it when attemptTimeoutMs is set', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-upload-hang-'));
    try {
      const { logPath, ossutilCommand, ossutilCommandArgs } = makeOssutilShim(
        tmp,
        'hang',
      );
      const assetPath = path.join(tmp, 'asset.tar.gz');
      fs.writeFileSync(assetPath, 'asset');
      const configPath = path.join(tmp, '.ossutilconfig');
      fs.writeFileSync(configPath, '[Credentials]\n');

      // Without the bound this test would sit in the shim's 60s hang; the
      // kill turns the stall into an ordinary failed attempt, so all three
      // attempts happen and the uploader fails loudly instead of hanging.
      // The bound must stay above worst-case child-spawn latency: a SIGKILL
      // landing before the shim's first appendFileSync loses that attempt's
      // log line, so the count below reads short (or the log is never
      // created at all) even though all three attempts ran. 400ms did
      // exactly that under CPU contention; 2000ms keeps the worst case of
      // three kills plus 6s of backoff inside this test's 30s budget.
      expect(() =>
        uploadAssets(
          {
            assets: [assetPath],
            bucket: 'qwen-test-bucket',
            config: configPath,
            prefix: 'releases/qwen-code/v0.0.0',
          },
          { ossutilCommand, ossutilCommandArgs, attemptTimeoutMs: 2000 },
        ),
      ).toThrow(/ossutil failed after 3 attempts/);
      const uploadAttempts = fs
        .readFileSync(logPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line === assetPath);
      expect(uploadAttempts).toHaveLength(3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('succeeds within the attempt bound when the upload is fast', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-upload-fast-'));
    try {
      const { ossutilCommand, ossutilCommandArgs } = makeOssutilShim(tmp);
      const assetPath = path.join(tmp, 'asset.tar.gz');
      fs.writeFileSync(assetPath, 'asset');
      const configPath = path.join(tmp, '.ossutilconfig');
      fs.writeFileSync(configPath, '[Credentials]\n');

      expect(() =>
        uploadAssets(
          {
            assets: [assetPath],
            bucket: 'qwen-test-bucket',
            config: configPath,
            prefix: 'releases/qwen-code/v0.0.0',
          },
          { ossutilCommand, ossutilCommandArgs, attemptTimeoutMs: 5000 },
        ),
      ).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('resolveAttemptTimeoutMs', () => {
  const KEY = 'OSS_UPLOAD_ATTEMPT_TIMEOUT_MS';

  it('defaults to unbounded when the env var is unset', () => {
    delete process.env[KEY];
    expect(resolveAttemptTimeoutMs()).toBe(0);
  });

  it('reads a millisecond bound from the environment', () => {
    process.env[KEY] = '120000';
    try {
      expect(resolveAttemptTimeoutMs()).toBe(120000);
    } finally {
      delete process.env[KEY];
    }
  });

  it('rejects a non-integer or negative bound', () => {
    for (const bad of ['soon', '-5', '1.5']) {
      process.env[KEY] = bad;
      try {
        expect(() => resolveAttemptTimeoutMs()).toThrow(
          /non-negative integer of milliseconds/,
        );
      } finally {
        delete process.env[KEY];
      }
    }
  });
});
