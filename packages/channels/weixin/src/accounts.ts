/**
 * Credential storage for WeChat account.
 * Stores account data in ~/.qwen/channels/weixin/
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
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

function accountPath(stateDir: string): string {
  return join(stateDir, 'account.json');
}

export function loadAccount(stateDir = getStateDir()): AccountData | null {
  const p = accountPath(stateDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as AccountData;
  } catch {
    return null;
  }
}

export function saveAccount(data: AccountData, stateDir = getStateDir()): void {
  mkdirSync(stateDir, { recursive: true });
  const p = accountPath(stateDir);
  const temporaryPath = `${p}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(data, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporaryPath, p);
  } catch (error) {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    throw error;
  }
}

export function clearAccount(stateDir = getStateDir()): void {
  const p = accountPath(stateDir);
  if (existsSync(p)) {
    unlinkSync(p);
  }
}
