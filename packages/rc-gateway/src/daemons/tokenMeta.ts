/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Identity sidecar for a stored daemon token (`add-multi-workspace-client`
 * task 1.3: `whoami` prints "token name, scope, expiry").
 *
 * The daemon never exposes a generic "who am I" for bearer tokens (`GET
 * /rc/tokens` is owner-scoped metadata WITHOUT the raw token, so a stored
 * token cannot be matched to a row). What IS known at pairing time — the
 * `POST /rc/pair/redeem` response `{ id, token, scopes }` — is persisted here
 * next to the token file, so `whoami` can render it later.
 *
 * Layout: `~/.qwen/rc/tokens/<sanitised-key>.meta.json` (mode 0600, sibling
 * of the `.tok` file). The meta is ENRICHMENT: a missing/corrupt file degrades
 * `whoami` to a scope probe, it never breaks other commands.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { defaultTokensDir, sanitizeKey } from './tokenStore.js';

export interface TokenMeta {
  /** The daemon-side token id (from the pair/redeem or mint response). */
  tokenId: string;
  scopes: string[];
  label: string;
  addedAt: string;
}

export function metaPath(dir: string, key: string): string {
  return join(dir, `${sanitizeKey(key)}.meta.json`);
}

export async function writeTokenMeta(
  dir: string,
  key: string,
  meta: TokenMeta,
): Promise<void> {
  await fs.mkdir(dir, { mode: 0o700, recursive: true });
  await fs.writeFile(metaPath(dir, key), JSON.stringify(meta, null, 2) + '\n', {
    mode: 0o600,
  });
}

/** Read + validate the sidecar; any missing/corrupt input yields `null`. */
export async function readTokenMeta(
  dir: string,
  key: string,
): Promise<TokenMeta | null> {
  let raw: string;
  try {
    raw = await fs.readFile(metaPath(dir, key), 'utf8');
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj['tokenId'] !== 'string' || !Array.isArray(obj['scopes'])) {
      return null;
    }
    return {
      tokenId: obj['tokenId'],
      scopes: (obj['scopes'] as unknown[]).map(String),
      label: typeof obj['label'] === 'string' ? obj['label'] : '',
      addedAt: typeof obj['addedAt'] === 'string' ? obj['addedAt'] : '',
    };
  } catch {
    return null;
  }
}

export async function deleteTokenMeta(dir: string, key: string): Promise<void> {
  await fs.rm(metaPath(dir, key), { force: true });
}

export { defaultTokensDir };
