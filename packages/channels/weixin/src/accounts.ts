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
  chmodSync,
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
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
  chmodSync(p, 0o600);
}

export function clearAccount(): void {
  const p = accountPath();
  if (existsSync(p)) {
    unlinkSync(p);
  }
}
