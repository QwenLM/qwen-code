/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration: environment first, `~/.qwen-live/config.json` as fallback,
 * built-in defaults last. Hand-rolled validation — the surface is small and
 * a schema library would be the package's only heavy dependency.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getStableLiveDiscoveryBaseDir } from './host/discovery.js';

export interface LiveConfig {
  realtime: {
    endpoint: string;
    apiKey: string;
    model: string;
    voice?: string;
  };
  serve: {
    baseUrl: string;
    token?: string;
  };
  /** Default working directory for handoff-created sessions. */
  defaultCwd?: string;
  /** Data root: session logs live in `<dataDir>/sessions`. */
  dataDir: string;
  /** Where the Host discovery file lives (`~/.qwen` for the shipped Host). */
  discoveryDir: string;
  /** Global shortcut advertised to the Host. */
  shortcut?: string;
  /** Fixed listen port; 0 (default) lets the kernel pick. */
  port: number;
}

const DEFAULT_REALTIME_ENDPOINT = 'https://dashscope.aliyuncs.com';
const DEFAULT_REALTIME_MODEL = 'qwen3.5-omni-plus-realtime';
const DEFAULT_SERVE_URL = 'http://127.0.0.1:4170';

function readConfigFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // Only a genuinely missing file means "no config". Anything else
    // (EACCES, EISDIR, EIO) must surface, or the later missing-key error
    // would point the user at a file that already contains the key.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `Could not read config file ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  // Editors commonly save JSON with a UTF-8 BOM; JSON.parse rejects it.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
    throw new Error('not an object');
  } catch (error) {
    throw new Error(
      `Invalid config file ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Shell-style expansion of a leading `~` to the user's home directory. */
function expandTilde(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function pathStr(value: unknown): string | undefined {
  const trimmed = str(value);
  return trimmed === undefined ? undefined : expandTilde(trimmed);
}

function resolvePort(
  env: Record<string, string | undefined>,
  file: Record<string, unknown>,
  configPath: string,
): number {
  const envPort = str(env['QWEN_LIVE_PORT']);
  if (envPort !== undefined) {
    const port = Number(envPort);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error(`Invalid QWEN_LIVE_PORT: ${envPort}`);
    }
    return port;
  }
  const filePort = file['port'];
  if (filePort === undefined) return 0;
  // Accept the natural JSON spelling ("port": 4171) as well as a string.
  // Any other type (true, [4171], {}) is a config mistake and must not
  // silently boot on a kernel-picked ephemeral port.
  const portRaw =
    typeof filePort === 'number'
      ? String(filePort)
      : typeof filePort === 'string'
        ? filePort.trim()
        : undefined;
  const port = portRaw ? Number(portRaw) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(
      `Invalid "port" in ${configPath}: ${JSON.stringify(filePort)}`,
    );
  }
  return port;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): LiveConfig {
  const dataDir =
    pathStr(env['QWEN_LIVE_DATA_DIR']) ?? join(homedir(), '.qwen-live');
  const configPath = join(dataDir, 'config.json');
  const file = readConfigFile(configPath);

  const apiKey =
    str(env['DASHSCOPE_API_KEY']) ??
    str(env['QWEN_LIVE_REALTIME_API_KEY']) ??
    str(file['realtimeApiKey']);
  if (!apiKey) {
    throw new Error(
      'A DashScope realtime API key is required: set DASHSCOPE_API_KEY ' +
        `or put "realtimeApiKey" in ${configPath}.`,
    );
  }

  const port = resolvePort(env, file, configPath);

  const voice = str(env['QWEN_LIVE_VOICE']) ?? str(file['voice']) ?? 'Tina';
  const defaultCwd =
    pathStr(env['QWEN_LIVE_CWD']) ?? pathStr(file['defaultCwd']);
  const serveToken = str(env['QWEN_SERVER_TOKEN']) ?? str(file['serveToken']);
  const shortcut = str(env['QWEN_LIVE_SHORTCUT']) ?? str(file['shortcut']);

  return {
    realtime: {
      endpoint:
        str(env['QWEN_LIVE_REALTIME_ENDPOINT']) ??
        str(file['realtimeEndpoint']) ??
        DEFAULT_REALTIME_ENDPOINT,
      apiKey,
      model:
        str(env['QWEN_LIVE_REALTIME_MODEL']) ??
        str(file['realtimeModel']) ??
        DEFAULT_REALTIME_MODEL,
      ...(voice ? { voice } : {}),
    },
    serve: {
      baseUrl:
        str(env['QWEN_LIVE_SERVE_URL']) ??
        str(file['serveUrl']) ??
        DEFAULT_SERVE_URL,
      ...(serveToken ? { token: serveToken } : {}),
    },
    ...(defaultCwd ? { defaultCwd } : {}),
    dataDir,
    discoveryDir:
      pathStr(env['QWEN_LIVE_DISCOVERY_DIR']) ??
      pathStr(file['discoveryDir']) ??
      getStableLiveDiscoveryBaseDir(),
    ...(shortcut ? { shortcut } : {}),
    port,
  };
}
