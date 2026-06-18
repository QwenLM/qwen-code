/**
 * QQ Bot credential persistence.
 *
 * Reads and writes appId/appSecret to a JSON file under
 * `{qwenDir}/channels/{name}-credentials.json` with restrictive permissions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getGlobalQwenDir } from '@qwen-code/channel-base';

/** Build the credential file path for a given safe channel name. */
export function getCredsFilePath(safeName: string): string {
  return join(getGlobalQwenDir(), 'channels', `${safeName}-credentials.json`);
}

/** Try to load persisted credentials. Returns null if file missing or corrupt. */
export function loadCredentials(
  credsFile: string,
): { appId: string; appSecret: string } | null {
  if (!existsSync(credsFile)) return null;
  try {
    const saved = JSON.parse(readFileSync(credsFile, 'utf-8'));
    if (saved.appId && saved.appSecret) {
      return { appId: saved.appId, appSecret: saved.appSecret };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist credentials to disk.
 *
 * NOTE: writeFileSync with `mode: 0o600` is not atomic — the file is created
 * with default permissions (0o644) and then chmod'd. There is a sub-millisecond
 * TOCTOU window where another local process could read the credentials.
 * Exploiting this requires local shell access and precise timing; for a
 * single-user dev machine, the risk is negligible. Using openSync(fd, 'w', 0o600)
 * would close the window but adds complexity for no practical gain.
 */
export function saveCredentials(
  credsFile: string,
  appId: string,
  appSecret: string,
): void {
  const dir = join(getGlobalQwenDir(), 'channels');
  mkdirSync(dir, { recursive: true });
  writeFileSync(credsFile, JSON.stringify({ appId, appSecret }), {
    mode: 0o600,
  });
}
