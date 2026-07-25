/**
 * Credential storage for WeChat account.
 * Stores account data in ~/.qwen/channels/weixin/
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { getGlobalQwenDir } from '@qwen-code/channel-base';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

export interface AccountData {
  token: string;
  baseUrl: string;
  userId?: string;
  savedAt: string;
}

export function getStateDir(): string {
  const dir =
    process.env['WEIXIN_STATE_DIR'] ||
    join(getGlobalQwenDir(), 'channels', 'weixin');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function accountPath(): string {
  return join(getStateDir(), 'account.json');
}

export function loadAccount(): AccountData | null {
  const p = accountPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as AccountData;
  } catch {
    return null;
  }
}

export function saveAccount(data: AccountData): void {
  const p = accountPath();
  // The temp path must not be guessable. A fixed `${p}.tmp` can be pre-created
  // by anyone with write access to the directory, and `writeFileSync` follows a
  // symlink found there — which would send the token wherever it points. A
  // unique name also stops two concurrent saves from interleaving their writes
  // into one file. Same shape `channel-base` uses for its own atomic stores.
  const tmp = `${p}.${Date.now()}-${process.pid}-${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  try {
    // Create the file already private. Writing first and narrowing afterwards
    // leaves the token readable at the umask default (0644 under the usual 022)
    // for the window between the two calls. `mode` is honoured here only
    // because the unique name guarantees this call creates the file — it is
    // silently ignored when the path already exists.
    writeFileSync(tmp, JSON.stringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    // Rename carries the 0600 mode onto the destination, so an account.json
    // written by an older version is narrowed rather than left as it was.
    renameSync(tmp, p);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

export function clearAccount(): void {
  const p = accountPath();
  if (existsSync(p)) {
    unlinkSync(p);
  }
}
