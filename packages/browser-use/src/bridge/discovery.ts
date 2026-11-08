/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { lstat, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultChromeBridgeSocketPath } from './protocol.js';
import { prepareSocketDirectory, verifySocketPeerPath } from './socket-path.js';

export interface ChromeProfileEndpoint {
  extensionInstanceId: string;
  hostInstanceId: string;
  protocolVersion: number;
  extensionProtocolVersion: number;
  socketPath: string;
  pid: number;
  /** Display name such as `Chrome · Work`, when the runtime can map the id. */
  profileName?: string;
  /** Whether Chrome recorded this profile as last used. */
  lastUsed?: boolean;
}

export type ChromeProfileDescriber = (
  extensionInstanceIds: string[],
) => Promise<Map<string, { name: string; lastUsed: boolean }>>;

// A dedicated directory: the socket base may be the user's whole
// /run/user/<uid>, which other programs share. The name stays short because
// macOS limits a socket path to 103 bytes and its base already spends up to
// 40 of them on /private/tmp/qwen-browser-use-<uid>.
export const DISCOVERY_DIRECTORY_NAME = 'qwen-hosts';

export function chromeDiscoveryDirectory(): string {
  return (
    process.env['QWEN_BROWSER_USE_DISCOVERY_DIR']?.trim() ||
    (process.platform === 'win32'
      ? join(homedir(), '.qwen', 'browser-use', 'profiles')
      : join(
          dirname(defaultChromeBridgeSocketPath()),
          DISCOVERY_DIRECTORY_NAME,
        ))
  );
}

export function profileSocketPath(directory: string, hostId: string): string {
  return process.platform === 'win32'
    ? `${defaultChromeBridgeSocketPath()}-${hostId}`
    : join(directory, `${hostId}.sock`);
}

export async function prepareDiscoveryDirectory(
  directory: string,
): Promise<void> {
  if (process.platform === 'win32') {
    await mkdir(directory, { recursive: true });
    return;
  }
  // The per-user socket base may not exist yet (macOS, or Linux without
  // /run/user); create both levels private, then verify every ancestor.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await prepareSocketDirectory(join(directory, 'discovery'));
}

export async function discoverChromeProfiles(
  directory = chromeDiscoveryDirectory(),
): Promise<ChromeProfileEndpoint[]> {
  await prepareDiscoveryDirectory(directory);
  const entries = await readdir(directory);
  const candidates = await Promise.all(
    entries
      .filter((entry) => /^[0-9a-f-]{36}\.json$/.test(entry))
      .map(async (entry) => {
        try {
          const file = join(directory, entry);
          const info = await lstat(file);
          if (
            !info.isFile() ||
            (process.platform !== 'win32' &&
              (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0))
          )
            return;
          const value: unknown = JSON.parse(await readFile(file, 'utf8'));
          if (
            !isEndpoint(value) ||
            value.hostInstanceId + '.json' !== entry ||
            value.socketPath !==
              profileSocketPath(directory, value.hostInstanceId)
          )
            return;
          await verifySocketPeerPath(value.socketPath);
          if (!(await socketIsLive(value.socketPath))) {
            // A Host killed before its guarded cleanup leaves both files.
            if (!processIsAlive(value.pid))
              await removeDeadHost(file, value.socketPath);
            return;
          }
          return { endpoint: value, timestamp: info.mtimeMs };
        } catch {
          return;
        }
      }),
  );
  const profiles = new Map<string, ChromeProfileEndpoint>();
  for (const candidate of candidates
    .filter((entry) => entry !== undefined)
    .sort((a, b) => b.timestamp - a.timestamp)) {
    if (!profiles.has(candidate.endpoint.extensionInstanceId))
      profiles.set(candidate.endpoint.extensionInstanceId, candidate.endpoint);
  }
  return [...profiles.values()];
}

function isEndpoint(value: unknown): value is ChromeProfileEndpoint {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['extensionInstanceId'] === 'string' &&
    entry['extensionInstanceId'].length > 0 &&
    entry['extensionInstanceId'].length <= 128 &&
    typeof entry['hostInstanceId'] === 'string' &&
    /^[0-9a-f-]{36}$/.test(entry['hostInstanceId']) &&
    typeof entry['socketPath'] === 'string' &&
    typeof entry['protocolVersion'] === 'number' &&
    typeof entry['extensionProtocolVersion'] === 'number' &&
    typeof entry['pid'] === 'number'
  );
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function removeDeadHost(record: string, socketPath: string) {
  await unlink(record).catch(() => undefined);
  const info = await lstat(socketPath).catch(() => undefined);
  if (info?.isSocket() && info.uid === process.getuid!())
    await unlink(socketPath).catch(() => undefined);
}

async function socketIsLive(path: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => finish(false), 200);
    const finish = (live: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
