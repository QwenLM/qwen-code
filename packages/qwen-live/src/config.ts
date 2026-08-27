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
  } catch {
    return {};
  }
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

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): LiveConfig {
  const dataDir =
    str(env['QWEN_LIVE_DATA_DIR']) ?? join(homedir(), '.qwen-live');
  const file = readConfigFile(join(dataDir, 'config.json'));

  const apiKey =
    str(env['DASHSCOPE_API_KEY']) ??
    str(env['QWEN_LIVE_REALTIME_API_KEY']) ??
    str(file['realtimeApiKey']);
  if (!apiKey) {
    throw new Error(
      'A DashScope realtime API key is required: set DASHSCOPE_API_KEY ' +
        `or put "realtimeApiKey" in ${join(dataDir, 'config.json')}.`,
    );
  }

  const portRaw = str(env['QWEN_LIVE_PORT']) ?? str(file['port']);
  const port = portRaw === undefined ? 0 : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid QWEN_LIVE_PORT: ${portRaw}`);
  }

  const voice = str(env['QWEN_LIVE_VOICE']) ?? str(file['voice']) ?? 'Tina';
  const defaultCwd = str(env['QWEN_LIVE_CWD']) ?? str(file['defaultCwd']);
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
      str(env['QWEN_LIVE_DISCOVERY_DIR']) ??
      str(file['discoveryDir']) ??
      join(homedir(), '.qwen'),
    ...(shortcut ? { shortcut } : {}),
    port,
  };
}
