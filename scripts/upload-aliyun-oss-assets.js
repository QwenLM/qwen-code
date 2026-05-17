#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fail, isMainModule, readOptionValue } from './release-script-utils.js';

if (isMainModule(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

async function main(argv) {
  const args = parseUploadArgs(argv);
  if (args.help) {
    printUsage();
    return;
  }
  await uploadAssets(args);
}

function printUsage() {
  console.log(`Usage: node scripts/upload-aliyun-oss-assets.js [options] ASSET...

Uploads local release assets to a public Aliyun OSS prefix via ossutil.

Options:
  --bucket NAME       OSS bucket name.
  --config PATH       ossutil config path.
  --prefix PREFIX     Destination object prefix.
  -h, --help          Show this help message.
`);
}

function parseUploadArgs(argv) {
  const args = {
    assets: [],
    bucket: '',
    config: '',
    help: false,
    prefix: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--bucket') {
      args.bucket = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--config') {
      args.config = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--prefix') {
      args.prefix = readOptionValue(argv, index, arg).replace(/\/+$/, '');
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      fail(`Unknown option: ${arg}`);
    }
    args.assets.push(arg);
  }

  if (args.help) {
    return args;
  }
  if (!args.bucket) {
    fail('--bucket requires a value');
  }
  if (!args.config) {
    fail('--config requires a value');
  }
  if (!args.prefix) {
    fail('--prefix requires a value');
  }
  if (args.assets.length === 0) {
    fail('At least one ASSET path is required');
  }

  return args;
}

const MAX_UPLOAD_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 2000;

async function uploadAssets({ assets, bucket, config, prefix }) {
  // Upload assets in parallel; each asset has its own retry budget. Failures
  // are collected and reported together so a flaky run is not masked by a
  // later failure aborting earlier ones.
  const failures = [];
  await Promise.all(
    assets.map(async (asset) => {
      const key = `${prefix}/${path.basename(asset)}`;
      try {
        await uploadWithRetry(asset, bucket, key, config);
      } catch (error) {
        failures.push({ asset, error });
      }
    }),
  );
  if (failures.length > 0) {
    for (const { asset, error } of failures) {
      console.error(
        `Upload failed for ${asset}: ${error instanceof Error ? error.message : error}`,
      );
    }
    fail(`${failures.length} of ${assets.length} asset uploads failed.`);
  }
}

async function uploadWithRetry(asset, bucket, key, config) {
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    const exitInfo = await runOssutilCp(asset, bucket, key, config);

    if (exitInfo.status === 0) {
      return;
    }
    if (attempt < MAX_UPLOAD_ATTEMPTS) {
      const delayMs = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
      console.warn(
        `Upload attempt ${attempt}/${MAX_UPLOAD_ATTEMPTS} failed for ${path.basename(asset)}, retrying in ${delayMs / 1000}s...`,
      );
      await delay(delayMs);
    }
  }
  throw new Error(
    `ossutil failed after ${MAX_UPLOAD_ATTEMPTS} attempts while uploading ${asset}`,
  );
}

function runOssutilCp(asset, bucket, key, config) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ossutil',
      [
        'cp',
        asset,
        `oss://${bucket}/${key}`,
        '-c',
        config,
        '-f',
        '--acl',
        'public-read',
      ],
      { stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('close', (status) => resolve({ status: status ?? 1 }));
  });
}

export { parseUploadArgs, uploadAssets };
