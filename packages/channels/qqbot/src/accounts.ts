/**
 * QQ Bot credential persistence.
 *
 * Reads and writes appId/appSecret to a JSON file under
 * `{qwenDir}/channels/{name}-credentials.json` with restrictive permissions.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { getGlobalQwenDir } from '@qwen-code/channel-base';

/** Build the credential file path for a given safe channel name. */
export function getCredsFilePath(safeName: string, stateDir?: string): string {
  return stateDir
    ? join(stateDir, 'credentials.json')
    : join(getGlobalQwenDir(), 'channels', `${safeName}-credentials.json`);
}

export interface LoadCredentialsOptions {
  allowLegacyFallback?: boolean;
  legacyFile?: string;
}

export interface QQCredentials {
  appId: string;
  appSecret: string;
}

function readCredentials(credsFile: string): QQCredentials | null {
  if (!existsSync(credsFile)) return null;
  try {
    const saved = JSON.parse(readFileSync(credsFile, 'utf-8')) as {
      appId?: unknown;
      appSecret?: unknown;
    };
    if (
      typeof saved.appId === 'string' &&
      saved.appId.length > 0 &&
      typeof saved.appSecret === 'string' &&
      saved.appSecret.length > 0
    ) {
      return { appId: saved.appId, appSecret: saved.appSecret };
    }
    return null;
  } catch {
    return null;
  }
}

/** Try to load persisted credentials. Returns null if file missing or corrupt. */
export function loadCredentials(
  credsFile: string,
  options: LoadCredentialsOptions = {},
): QQCredentials | null {
  const scoped = readCredentials(credsFile);
  if (scoped || !options.allowLegacyFallback || !options.legacyFile) {
    return scoped;
  }
  return readCredentials(options.legacyFile);
}

/**
 * Persist credentials to disk.
 *
 * The temporary file is unique, created exclusively with mode 0600, and then
 * renamed over the destination so readers never observe a partial write.
 */
export function saveCredentials(
  credsFile: string,
  appId: string,
  appSecret: string,
): void {
  const dir = dirname(credsFile);
  mkdirSync(dir, { recursive: true });
  const temporaryPath = `${credsFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify({ appId, appSecret }), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporaryPath, credsFile);
  } catch (error) {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    throw error;
  }
}
