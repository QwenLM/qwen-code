/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export function fail(message) {
  throw new Error(`ERROR: ${message}`);
}

export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Parse a SHA256SUMS file. Handles:
 *  - optional leading UTF-8 BOM (uploaded via Windows tools)
 *  - binary-prefix markers (`*` before filename)
 *  - empty lines and CRLF / LF line endings
 */
export function parseSha256Sums(content) {
  // Strip a leading UTF-8 BOM so a SHA256SUMS file uploaded via a Windows tool
  // that prepends one still reports a useful "Missing checksum entry" error
  // instead of "Malformed SHA256SUMS line 1".
  const normalized = content.replace(/^\uFEFF/, '');
  const checksums = new Map();
  for (const [index, line] of normalized.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) {
      fail(`Malformed SHA256SUMS line ${index + 1}: ${trimmed}`);
    }
    if (checksums.has(match[2])) {
      fail(`Duplicate SHA256SUMS entry for: ${match[2]}`);
    }
    checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}

export function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    fail(`${optionName} requires a value`);
  }
  return value;
}

export function isMainModule(importMetaUrl) {
  const filename = fileURLToPath(importMetaUrl);
  return process.argv[1] && path.resolve(process.argv[1]) === filename;
}

/**
 * Parse CLI arguments. Supports:
 *  - --flag           → args[def.key] = true
 *  - --key value      → args[def.key] = value
 *  - --key=value      → args[def.key] = value
 *  - -h, --help       → args.help = true (always recognised)
 *
 * @param {string[]} argv
 * @param {Record<string, {key: string, type: 'flag'|'value'}>} definitions
 * @returns {{help: false} & Record<string, any>}
 */
export function parseArgs(argv, definitions) {
  const args = { help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--help' || raw === '-h') {
      args.help = true;
      continue;
    }

    // --key=value form
    const eqIndex = raw.indexOf('=');
    if (eqIndex >= 0) {
      const key = raw.slice(0, eqIndex);
      const value = raw.slice(eqIndex + 1);
      if (key === '--help' || key === '-h') {
        fail(`${key} does not accept a value`);
      }
      const def = definitions[key];
      if (!def) {
        fail(`Unknown option: ${key}`);
      }
      if (def.type === 'flag') {
        fail(`${key} does not accept a value`);
      }
      if (!value || value.startsWith('-')) {
        fail(`${key} requires a value`);
      }
      args[def.key] = value;
      continue;
    }

    const def = definitions[raw];
    if (!def) {
      fail(`Unknown option: ${raw}`);
    }

    if (def.type === 'flag') {
      args[def.key] = true;
      continue;
    }

    args[def.key] = readOptionValue(argv, index, raw);
    index += 1;
  }

  return args;
}
