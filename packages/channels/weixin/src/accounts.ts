/**
 * Credential storage for WeChat account.
 * Stores account data in ~/.qwen/channels/weixin/
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
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
  // The temp path must not be pre-creatable. A fixed `${p}.tmp` can be planted
  // in advance by anyone able to write to the directory, and a plain write
  // follows a symlink found there — which would send the token wherever it
  // points. `randomBytes` rather than a `Date.now()`/pid/`Math.random()` suffix
  // because those are guessable and V8's `Math.random` is not a CSPRNG; this
  // matches `ChannelLoopStore`, the sibling store with the same requirement.
  const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    // `wx` is `O_CREAT|O_EXCL`: it refuses an existing path, and the kernel
    // fails it on a symlink at the final component rather than following it.
    // The unguessable name makes a plant unlikely; the flag makes it
    // ineffective — so this does not rest on the name alone.
    //
    // `O_EXCL` also guarantees this call is the one that creates the file,
    // which is what makes `mode` take effect: it is silently ignored for a path
    // that already exists. Writing first and narrowing afterwards would leave
    // the token readable at the umask default (0644 under the usual 022) for
    // the window between the two calls.
    writeFileSync(tmp, JSON.stringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
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
  const dir = getStateDir();
  const p = join(dir, 'account.json');
  if (existsSync(p)) {
    unlinkSync(p);
  }
  // A save killed between the write and the rename leaves a temp file holding a
  // live token. The name is never reused, so nothing else would ever remove it:
  // without this sweep the credential outlives the logout meant to revoke it.
  for (const f of readdirSync(dir)) {
    if (f.startsWith('account.json.') && f.endsWith('.tmp')) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
