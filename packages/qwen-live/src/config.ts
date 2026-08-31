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

/**
 * One backend the live call can drive. `name` is what the voice model sees
 * (session_create's `backend` arg); it becomes the scoping prefix for
 * jobRefs and permission requestIds, so it must not contain ':'.
 */
export type BackendConfig =
  | {
      name: string;
      kind: 'qwen-code';
      baseUrl: string;
      token?: string;
      isDefault: boolean;
    }
  | {
      name: string;
      kind: 'acp';
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
      isDefault: boolean;
    };

export interface LiveConfig {
  realtime: {
    endpoint: string;
    apiKey: string;
    model: string;
    voice?: string;
  };
  /** Every configured backend; exactly one is the default. */
  backends: BackendConfig[];
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
const BACKEND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

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

/**
 * Validate one raw backend entry (already known to be an object) from the
 * named source. Kind-mismatched keys fail loud: a silently ignored
 * `command` on a qwen-code entry is a config mistake, not a default.
 */
function parseBackend(
  raw: Record<string, unknown>,
  source: string,
  index: number,
): BackendConfig {
  const where = `${source} entry #${index + 1}`;
  const name = str(raw['name']);
  if (!name || !BACKEND_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid backend name in ${where}: ${JSON.stringify(raw['name'])} ` +
        '(expected up to 32 chars of letters, digits, "_" or "-", no ":")',
    );
  }
  const kind = raw['kind'];
  if (kind === 'qwen-code') {
    for (const banned of ['command', 'args', 'env', 'cwd']) {
      if (raw[banned] !== undefined) {
        throw new Error(
          `"${banned}" is not valid for kind qwen-code (${where})`,
        );
      }
    }
    const baseUrl = str(raw['serveUrl'] ?? raw['baseUrl']) ?? DEFAULT_SERVE_URL;
    const token = str(raw['token']);
    return {
      name,
      kind,
      baseUrl,
      ...(token ? { token } : {}),
      isDefault: raw['default'] === true,
    };
  }
  if (kind === 'acp') {
    for (const banned of ['serveUrl', 'baseUrl', 'token']) {
      if (raw[banned] !== undefined) {
        throw new Error(`"${banned}" is not valid for kind acp (${where})`);
      }
    }
    const command = str(raw['command']);
    if (!command) {
      throw new Error(`Invalid acp backend "command" in ${where}`);
    }
    const rawArgs = raw['args'] ?? [];
    if (
      !Array.isArray(rawArgs) ||
      rawArgs.some((arg) => typeof arg !== 'string')
    ) {
      throw new Error(
        `Invalid acp backend "args" in ${where}: expected string[]`,
      );
    }
    const rawEnv = raw['env'] ?? {};
    if (!isRecordLike(rawEnv)) {
      throw new Error(
        `Invalid acp backend "env" in ${where}: expected an object`,
      );
    }
    for (const [key, value] of Object.entries(rawEnv)) {
      if (typeof value !== 'string') {
        throw new Error(
          `Invalid acp backend "env" value for "${key}" in ${where}: expected a string`,
        );
      }
    }
    const cwd = pathStr(raw['cwd']);
    return {
      name,
      kind,
      command,
      args: rawArgs as string[],
      env: rawEnv as Record<string, string>,
      ...(cwd ? { cwd } : {}),
      isDefault: raw['default'] === true,
    };
  }
  throw new Error(
    `Invalid backend "kind" in ${where}: ${JSON.stringify(kind)} ` +
      '(expected "qwen-code" or "acp")',
  );
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBackends(
  env: Record<string, string | undefined>,
  file: Record<string, unknown>,
  configPath: string,
): BackendConfig[] {
  let entries: unknown;
  let source: string;
  const envBackends = str(env['QWEN_LIVE_BACKENDS']);
  if (envBackends !== undefined) {
    try {
      entries = JSON.parse(envBackends);
    } catch (error) {
      throw new Error(
        `Invalid QWEN_LIVE_BACKENDS: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    source = 'QWEN_LIVE_BACKENDS';
  } else if (file['backends'] !== undefined) {
    entries = file['backends'];
    source = configPath;
  } else {
    // Legacy single-backend spellings synthesize the implicit qwen-code
    // backend so existing configs (and the e2e harness) keep working.
    const baseUrl =
      str(env['QWEN_LIVE_SERVE_URL']) ??
      str(file['serveUrl']) ??
      DEFAULT_SERVE_URL;
    const token = str(env['QWEN_SERVER_TOKEN']) ?? str(file['serveToken']);
    return [
      {
        name: 'qwen-code',
        kind: 'qwen-code',
        baseUrl,
        ...(token ? { token } : {}),
        isDefault: true,
      },
    ];
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(
      `${source}: "backends" must be a non-empty array, got ${JSON.stringify(entries)}`,
    );
  }
  const backends = entries.map((entry, index) => {
    if (!isRecordLike(entry)) {
      throw new Error(`${source} entry #${index + 1} must be an object`);
    }
    return parseBackend(entry, source, index);
  });
  const names = new Set<string>();
  for (const backend of backends) {
    const lower = backend.name.toLowerCase();
    if (names.has(lower)) {
      throw new Error(`duplicate backend name '${backend.name}' in ${source}`);
    }
    names.add(lower);
  }
  const defaults = backends.filter((backend) => backend.isDefault);
  if (defaults.length > 1) {
    throw new Error(`${source}: at most one backend may set "default": true`);
  }
  if (defaults.length === 0 && backends.length > 1) {
    throw new Error(
      `${source}: mark one backend "default": true (a single entry is implicitly the default)`,
    );
  }
  return backends;
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
  const backends = parseBackends(env, file, configPath);

  const voice = str(env['QWEN_LIVE_VOICE']) ?? str(file['voice']) ?? 'Tina';
  const defaultCwd =
    pathStr(env['QWEN_LIVE_CWD']) ?? pathStr(file['defaultCwd']);
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
    backends,
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
