import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { LIVE_PROTOCOL_VERSION } from '../shared/protocol.ts';

const MAX_DISCOVERY_BYTES = 16 * 1024;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

export type LiveDiscoveryRecord = {
  url: string;
  token?: string;
  protocolVersion: number;
  pid: number;
  instanceNonce: string;
};

export type DiscoveryResult =
  | { kind: 'ready'; record: LiveDiscoveryRecord; signature: string }
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveDiscoveryPath(environment = process.env): string {
  const configured = environment.QWEN_LIVE_DISCOVERY_FILE;
  if (!configured) return join(homedir(), '.qwen', 'live', 'daemon.json');
  return isAbsolute(configured) ? configured : resolve(configured);
}

export function buildHostWebSocketUrl(value: string): string {
  const url = new URL(value);
  const ipv4Loopback =
    isIP(url.hostname) === 4 && url.hostname.startsWith('127.');
  const loopback =
    ipv4Loopback ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (!loopback) throw new Error('daemon URL is not loopback');

  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('daemon URL has an unsupported scheme');
  }

  url.username = '';
  url.password = '';
  url.pathname = '/live/host';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function buildWebShellSessionUrl(
  record: LiveDiscoveryRecord,
  target: { workspaceId: string; sessionId: string },
): string {
  buildHostWebSocketUrl(record.url);
  const url = new URL(record.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('daemon URL is not HTTP');
  }
  url.username = '';
  url.password = '';
  url.pathname = `/session/${encodeURIComponent(target.sessionId)}`;
  url.search = '';
  url.searchParams.set('workspace', target.workspaceId);
  url.hash = record.token
    ? new URLSearchParams({ token: record.token }).toString()
    : '';
  return url.toString();
}

export async function readDiscoveryFile(
  path: string,
): Promise<DiscoveryResult> {
  let fileStat;
  try {
    fileStat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { kind: 'missing' };
    return { kind: 'invalid', reason: 'discovery_unreadable' };
  }

  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    return { kind: 'invalid', reason: 'discovery_not_regular_file' };
  }
  if ((fileStat.mode & 0o777) !== 0o600) {
    return { kind: 'invalid', reason: 'discovery_permissions' };
  }
  if (
    typeof process.getuid === 'function' &&
    fileStat.uid !== process.getuid()
  ) {
    return { kind: 'invalid', reason: 'discovery_owner' };
  }
  if (fileStat.size <= 0 || fileStat.size > MAX_DISCOVERY_BYTES) {
    return { kind: 'invalid', reason: 'discovery_size' };
  }

  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { kind: 'invalid', reason: 'discovery_json' };
  }
  if (!isRecord(value)) return { kind: 'invalid', reason: 'discovery_shape' };

  const protocolVersion = value.protocolVersion;
  const instanceNonce = value.instanceNonce;
  if (
    typeof value.url !== 'string' ||
    value.url.length > 4_096 ||
    !Number.isSafeInteger(protocolVersion) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    typeof instanceNonce !== 'string' ||
    !NONCE_PATTERN.test(instanceNonce) ||
    (value.token !== undefined &&
      (typeof value.token !== 'string' || value.token.length > 4_096))
  ) {
    return { kind: 'invalid', reason: 'discovery_shape' };
  }
  if (Number(protocolVersion) !== LIVE_PROTOCOL_VERSION) {
    return { kind: 'invalid', reason: 'discovery_protocol' };
  }

  try {
    buildHostWebSocketUrl(value.url);
  } catch {
    return { kind: 'invalid', reason: 'discovery_url' };
  }

  const record: LiveDiscoveryRecord = {
    url: value.url,
    protocolVersion: Number(protocolVersion),
    pid: Number(value.pid),
    instanceNonce,
  };
  if (typeof value.token === 'string' && value.token)
    record.token = value.token;
  return {
    kind: 'ready',
    record,
    signature: `${record.pid}:${record.instanceNonce}:${record.url}:${createHash(
      'sha256',
    )
      .update(record.token ?? '')
      .digest('hex')}`,
  };
}

export class DiscoveryMonitor {
  private timer: NodeJS.Timeout | undefined;
  private lastIdentity = '';
  private pollInFlight: Promise<void> | undefined;
  private lifecycleGeneration = 0;

  constructor(
    readonly path: string,
    private readonly listener: (result: DiscoveryResult) => void,
    private readonly intervalMs = 1_000,
    private readonly reader = readDiscoveryFile,
  ) {}

  start(): void {
    if (this.timer) return;
    this.lifecycleGeneration += 1;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.lifecycleGeneration += 1;
    this.pollInFlight = undefined;
    this.lastIdentity = '';
  }

  async poll(): Promise<void> {
    if (this.pollInFlight) return await this.pollInFlight;
    const generation = this.lifecycleGeneration;
    const operation = this.pollOnce(generation);
    this.pollInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.pollInFlight === operation) this.pollInFlight = undefined;
    }
  }

  private async pollOnce(generation: number): Promise<void> {
    const result = await this.reader(this.path);
    if (generation !== this.lifecycleGeneration) return;
    const identity =
      result.kind === 'ready'
        ? `ready:${result.signature}`
        : `${result.kind}:${result.kind === 'invalid' ? result.reason : ''}`;
    if (identity === this.lastIdentity) return;
    this.lastIdentity = identity;
    this.listener(result);
  }
}
