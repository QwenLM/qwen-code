/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Talks to the desktop relay on the viewer's own computer: a loopback socket
 * that `node-repl-mcp desktop-relay install` registers with launchd. The port
 * is fixed on both sides (`packages/node-repl/src/desktop-relay/constants.ts`).
 */

export const DESKTOP_RELAY_URL = 'http://127.0.0.1:47821';

export const DESKTOP_RELAY_INSTALL_COMMAND =
  'npx -y @qwen-code/node-repl-mcp@latest desktop-relay install';

export type DesktopRelayRemotePhase =
  | 'connecting'
  | 'registering'
  | 'connected'
  | 'stopped'
  | 'failed';

export interface DesktopRelayActive {
  sessionId: string;
  daemonUrl: string;
  phase: DesktopRelayRemotePhase;
  message?: string;
}

export type DesktopRelayProbe =
  | { kind: 'missing' }
  | { kind: 'ready'; version: string; active?: DesktopRelayActive };

export interface DesktopRelayConnectRequest {
  daemonUrl: string;
  sessionId: string;
  token?: string;
  workspace?: { kind: 'id' | 'cwd'; value: string };
}

export type DesktopRelayConnectResult =
  | { ok: true }
  | { ok: false; code: string; message?: string };

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

const REMOTE_PHASES: ReadonlySet<string> = new Set([
  'connecting',
  'registering',
  'connected',
  'stopped',
  'failed',
]);

async function withTimeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function parseActive(value: unknown): DesktopRelayActive | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const active = value as Record<string, unknown>;
  const phase = active['phase'];
  if (
    typeof active['sessionId'] !== 'string' ||
    typeof active['daemonUrl'] !== 'string' ||
    typeof phase !== 'string' ||
    !REMOTE_PHASES.has(phase)
  ) {
    return undefined;
  }
  return {
    sessionId: active['sessionId'],
    daemonUrl: active['daemonUrl'],
    phase: phase as DesktopRelayRemotePhase,
    ...(typeof active['message'] === 'string'
      ? { message: active['message'] }
      : {}),
  };
}

/** Any failure reads as "not set up": there is nothing else to tell apart. */
export async function probeDesktopRelay(
  fetchImpl: FetchLike = defaultFetch,
  timeoutMs = 2_000,
): Promise<DesktopRelayProbe> {
  try {
    const response = await withTimeout(timeoutMs, (signal) =>
      fetchImpl(`${DESKTOP_RELAY_URL}/status`, { cache: 'no-store', signal }),
    );
    if (!response.ok) return { kind: 'missing' };
    const body = (await response.json()) as Record<string, unknown>;
    if (body['ok'] !== true) return { kind: 'missing' };
    const active = parseActive(body['active']);
    return {
      kind: 'ready',
      version: typeof body['version'] === 'string' ? body['version'] : '',
      ...(active === undefined ? {} : { active }),
    };
  } catch {
    return { kind: 'missing' };
  }
}

/** Resolves once the person at the computer has answered its dialog. */
export async function connectDesktopRelay(
  request: DesktopRelayConnectRequest,
  fetchImpl: FetchLike = defaultFetch,
): Promise<DesktopRelayConnectResult> {
  try {
    // The dialog waits up to a minute for an answer.
    const response = await withTimeout(90_000, (signal) =>
      fetchImpl(`${DESKTOP_RELAY_URL}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        cache: 'no-store',
        signal,
      }),
    );
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return {
      ok: false,
      code:
        typeof body['code'] === 'string'
          ? body['code']
          : `http_${response.status}`,
      ...(typeof body['message'] === 'string'
        ? { message: body['message'] }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      code: 'unreachable',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function disconnectDesktopRelay(
  fetchImpl: FetchLike = defaultFetch,
): Promise<void> {
  try {
    await withTimeout(5_000, (signal) =>
      fetchImpl(`${DESKTOP_RELAY_URL}/disconnect`, {
        method: 'POST',
        cache: 'no-store',
        signal,
      }),
    );
  } catch {
    // The next status probe shows whatever state is left.
  }
}
