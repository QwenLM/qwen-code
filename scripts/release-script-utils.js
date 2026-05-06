/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

function isMainModule(importMetaUrl) {
  const filename = fileURLToPath(importMetaUrl);
  return process.argv[1] && path.resolve(process.argv[1]) === filename;
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    fail(`${optionName} requires a value`);
  }
  return value;
}

function parseCliArgs(argv, options, defaults = {}) {
  const args = { ...defaults };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    let key = arg;
    let inlineValue;
    if (arg.startsWith('--')) {
      const equalsIndex = arg.indexOf('=');
      if (equalsIndex > -1) {
        key = arg.slice(0, equalsIndex);
        inlineValue = arg.slice(equalsIndex + 1);
      }
    }

    const option = options[key];
    if (!option) {
      fail(`Unknown option: ${arg}`);
    }

    if (option.type === 'boolean') {
      if (inlineValue !== undefined) {
        fail(`${key} does not accept a value`);
      }
      args[option.name] = true;
      continue;
    }

    let value;
    if (inlineValue !== undefined) {
      if (inlineValue === '') {
        fail(`${key} requires a value`);
      }
      value = inlineValue;
    } else {
      value = readOptionValue(argv, index, key);
      index += 1;
    }
    if (option.validate) {
      option.validate(value);
    }
    args[option.name] = value;
  }

  return args;
}

function parseSha256Sums(content) {
  const checksums = new Map();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (match) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function fail(message) {
  throw new Error(`ERROR: ${message}`);
}

export {
  fail,
  isMainModule,
  parseCliArgs,
  parseSha256Sums,
  readOptionValue,
  sha256File,
};
