/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const QWEN_DIR = '.qwen';
const QWEN_CREDENTIAL_FILENAME = 'oauth_creds.json';

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0);
}

function parseOauthCreds(rawValue) {
  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(
      `Invalid OAuth credentials JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid OAuth credentials: expected a JSON object');
  }

  const requiredFields = ['access_token', 'refresh_token', 'token_type'];
  for (const field of requiredFields) {
    if (
      typeof parsed[field] !== 'string' ||
      parsed[field].trim().length === 0
    ) {
      throw new Error(`Invalid OAuth credentials: missing ${field}`);
    }
  }

  if (typeof parsed.expiry_date !== 'number') {
    throw new Error('Invalid OAuth credentials: missing expiry_date');
  }

  return parsed;
}

export function resolveOauthCredsFromEnv(env = process.env) {
  const inlineJson = firstNonEmpty(env.QWEN_TEST_OAUTH_CREDS_JSON);
  if (inlineJson) {
    return parseOauthCreds(inlineJson);
  }

  const encoded = firstNonEmpty(env.QWEN_TEST_OAUTH_CREDS_BASE64);
  if (!encoded) {
    throw new Error(
      'Missing OAuth credentials env. Set QWEN_TEST_OAUTH_CREDS_JSON or QWEN_TEST_OAUTH_CREDS_BASE64.',
    );
  }

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  return parseOauthCreds(decoded);
}

export function getOauthCredsPath(homeDir = os.homedir()) {
  return path.join(homeDir, QWEN_DIR, QWEN_CREDENTIAL_FILENAME);
}

export async function installOauthCredsFromEnv(
  env = process.env,
  homeDir = os.homedir(),
) {
  const creds = resolveOauthCredsFromEnv(env);
  const oauthDir = path.join(homeDir, QWEN_DIR);
  const oauthCredsPath = getOauthCredsPath(homeDir);

  await fs.mkdir(oauthDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(oauthCredsPath, `${JSON.stringify(creds, null, 2)}\n`, {
    mode: 0o600,
  });

  return oauthCredsPath;
}

async function main() {
  const installedPath = await installOauthCredsFromEnv();
  console.log(`[oauth-creds] Installed OAuth credentials at ${installedPath}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
const thisPath = fileURLToPath(import.meta.url);

if (invokedPath && invokedPath === thisPath) {
  main().catch((error) => {
    console.error(
      `[oauth-creds] Failed to install OAuth credentials: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
