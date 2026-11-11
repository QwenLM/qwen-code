/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage, isAbortError, isNodeError } from './errors.js';
import { URL } from 'node:url';
import {
  Agent,
  Pool,
  ProxyAgent,
  buildConnector,
  fetch as undiciFetch,
  request as undiciRequest,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici/index.js';
import net from 'node:net';
import * as nodeStream from 'node:stream';
import { Readable } from 'node:stream';
import type { Transform } from 'node:stream';
import * as zlib from 'node:zlib';
import ipaddr from 'ipaddr.js';
import { lookup } from 'node:dns/promises';
import { normalizeProxyUrl, redactProxyUrl } from './proxy.js';
import { ensureUndiciDiagnosticsInstalled } from './undici-diagnostics.js';
import { runLogger } from './runLogger.js';
import {
  MAX_HTTP_RESPONSE_HEADER_BYTES,
  ProtocolLimitError,
} from './protocol-limits.js';
import { normalizePositiveTimeoutMs } from './timeouts.js';
import { raceWithAbortSignal } from './abort-race.js';
import { getCertificateAuthorities } from './certificate-store.js';

const CONNECTOR_OPTIONS = {
  keepAlive: true,
  keepAliveInitialDelay: 15_000,
} as const;

// Bun 1.3.14's node:http2 compatibility layer can leave npm undici response
// bodies pending and crash on GOAWAY cleanup. Keep npm undici on HTTP/1.1 in
// Bun. Outside Bun, omit the option so undici retains its own default instead
// of this compatibility workaround silently opting Node into HTTP/2.
function undiciH2Options(): { allowH2?: false } {
  return isBunRuntime() ? { allowH2: false } : {};
}

/** Connector options with an optional per-request TCP connect timeout applied. */
function connectorOptionsWithTimeout(connectTimeoutMs?: number) {
  const authorities = getCertificateAuthorities();
  return {
    ...CONNECTOR_OPTIONS,
    ...undiciH2Options(),
    ...(authorities ? { ca: [...authorities] } : {}),
    ...(connectTimeoutMs !== undefined ? { timeout: connectTimeoutMs } : {}),
  };
}

const AGENT_POOL_OPTIONS = {
  keepAliveTimeout: 55_000,
  keepAliveMaxTimeout: 60_000,
  maxHeaderSize: MAX_HTTP_RESPONSE_HEADER_BYTES,
} as const;

function agentPoolOptions() {
  return {
    ...AGENT_POOL_OPTIONS,
    ...undiciH2Options(),
  };
}

export class FetchError extends Error {
  constructor(
    message: string,
    public code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FetchError';
  }
}

export class PrivateIpError extends Error {
  constructor(message = 'Access to private network is blocked') {
    super(message);
    this.name = 'PrivateIpError';
  }
}

let defaultTimeout = 300000; // 5 minutes
let currentProxy: string | undefined = undefined;
let currentProxyAgent: ProxyAgent | undefined;
let directAgent: Agent | undefined;
const directAgentsByTimeout: Map<string, Agent> = new Map();
const proxyAgentsByTimeout: Map<string, ProxyAgent> = new Map();
const resolvedIpAgents: Map<string, Agent> = new Map();
let nativeFetchBeforeProxyPatch: typeof fetch | undefined;

type HttpDispatcher = Agent | Pool | ProxyAgent;

export interface CliFetchInit extends RequestInit {
  cliConnectTimeoutMs?: number;
  cliRequestTimeoutMs?: number;
  cliBodyIdleTimeoutMs?: number;
}

interface BunProxyFetchInit extends RequestInit {
  proxy?: string | URL | { url: string | URL; headers?: HeadersInit };
  tls?: unknown;
}

// Recycle all connection pools after a stale-pool ECONNRESET so retries open
// fresh TCP connections instead of reusing the dead pooled socket.
export function disableKeepAlive(): void {
  runLogger.warn(
    '[fetch] Stale connection detected, recycling all connection pools',
  );
  if (directAgent) {
    closeAgent(directAgent);
    directAgent = undefined;
  }
  closeCustomTimeoutAgents();
  closeResolvedIpAgents();
  if (isBunRuntime()) {
    runLogger.debug(
      '[fetch] Bun native fetch pools are runtime-managed; no undici dispatcher to reset',
    );
    return;
  }
  if (currentProxy) {
    setGlobalProxy(currentProxy);
  } else {
    installDirectGlobalDispatcher();
  }
}

/** @internal test-only */
export function _resetKeepAliveForTesting(): void {
  // no-op — kept for backward compatibility with existing tests
}

/** @internal test-only */
export function _resetProxyForTesting(): void {
  currentProxy = undefined;
  if (currentProxyAgent) {
    closeAgent(currentProxyAgent);
    currentProxyAgent = undefined;
  }
  if (directAgent) {
    closeAgent(directAgent);
    directAgent = undefined;
  }
  closeCustomTimeoutAgents();
  closeResolvedIpAgents();
  uninstallGlobalFetchProxy();
  installDirectGlobalDispatcher();
}

let _isBunRuntime: boolean | undefined;
function isBunRuntime(): boolean {
  if (_isBunRuntime === undefined) {
    const g = globalThis as { Bun?: unknown };
    const v = process.versions as Record<string, string | undefined>;
    _isBunRuntime =
      g.Bun !== undefined || (v['bun'] != null && v['bun'] !== '');
  }
  return _isBunRuntime;
}

// Install the default direct dispatcher as undici's global dispatcher.
// No-ops in Bun runtime: Bun's native fetch doesn't use undici dispatchers, and
// installing one can interfere with Bun's proxy handling.
function installDirectGlobalDispatcher(): void {
  if (!isBunRuntime()) {
    setGlobalDispatcher(getDirectAgent());
  }
}

/** @internal test-only */
export function _resetBunRuntimeCacheForTesting(): void {
  _isBunRuntime = undefined;
}

export const PROXY_ENV_VARS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
] as const;

export type ProxyEnvironmentVariable = (typeof PROXY_ENV_VARS)[number];

export interface EnvironmentProxyResolution {
  readonly proxy: string;
  readonly source: ProxyEnvironmentVariable;
}

export interface FetchWithResolvedIpOptions {
  ip: string;
  originalHostname: string;
  markerHeader?: string;
}

export interface ProxiedFetchOptions {
  proxyUrl?: string;
}

export interface UnmanagedRequestTimeouts {
  timeoutMs: number;
  connectTimeoutMs?: number;
  bodyIdleTimeoutMs?: number;
}

/**
 * Timeouts for a long-lived stream to a non-first-party origin. The response-header
 * and connection phases remain bounded, while the stream body has no total or
 * idle deadline and is controlled by the caller's AbortSignal.
 */
export interface UnmanagedStreamRequestTimeouts {
  connectTimeoutMs?: number;
  responseHeadersTimeoutMs?: number;
}

export function resolveProxyFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): EnvironmentProxyResolution | undefined {
  for (const source of PROXY_ENV_VARS) {
    const proxy = environment[source];
    if (proxy) return { proxy, source };
  }
  return undefined;
}

export function getProxyFromEnvironment(): string | undefined {
  return resolveProxyFromEnvironment()?.proxy;
}

function createDirectAgent(
  headersTimeoutMs = defaultTimeout,
  bodyTimeoutMs = headersTimeoutMs,
  connectTimeoutMs?: number,
): Agent {
  const agent = new Agent({
    headersTimeout: headersTimeoutMs,
    bodyTimeout: bodyTimeoutMs,
    ...agentPoolOptions(),
    connect: buildConnector(connectorOptionsWithTimeout(connectTimeoutMs)),
  });
  runLogger.log(
    `[fetch] Direct Agent created: headersTimeout=${headersTimeoutMs}ms, bodyTimeout=${bodyTimeoutMs}ms, ` +
      `keepAliveTimeout=${AGENT_POOL_OPTIONS.keepAliveTimeout}ms, allowH2=${isBunRuntime() ? 'false' : 'undici-default'}, ` +
      `tcpKeepAlive=${CONNECTOR_OPTIONS.keepAlive}, tcpKeepAliveDelay=${CONNECTOR_OPTIONS.keepAliveInitialDelay}ms`,
  );
  return agent;
}

function agentTimeoutKey(
  headersTimeoutMs: number,
  bodyTimeoutMs: number,
  connectTimeoutMs?: number,
): string {
  return `${headersTimeoutMs}|${bodyTimeoutMs}|${connectTimeoutMs ?? 'default'}`;
}

function getDirectAgent(
  headersTimeoutMs = defaultTimeout,
  bodyTimeoutMs = headersTimeoutMs,
  connectTimeoutMs?: number,
): Agent {
  if (
    headersTimeoutMs === defaultTimeout &&
    bodyTimeoutMs === defaultTimeout &&
    connectTimeoutMs === undefined
  ) {
    directAgent ??= createDirectAgent(headersTimeoutMs, bodyTimeoutMs);
    return directAgent;
  }
  const key = agentTimeoutKey(
    headersTimeoutMs,
    bodyTimeoutMs,
    connectTimeoutMs,
  );
  const cached = directAgentsByTimeout.get(key);
  if (cached) return cached;
  const agent = createDirectAgent(
    headersTimeoutMs,
    bodyTimeoutMs,
    connectTimeoutMs,
  );
  directAgentsByTimeout.set(key, agent);
  return agent;
}

let socks5ExperimentalWarningSuppressed = false;

/**
 * undici emits `SOCKS5 proxy support is experimental` once, the first time a
 * SOCKS5 tunnel connects. Someone who configured a SOCKS proxy on purpose has
 * nothing to act on, so drop that one line and leave every other warning
 * alone. Installed lazily so processes without a SOCKS proxy never patch
 * `process.emitWarning`.
 */
function suppressSocks5ExperimentalWarning(normalizedProxy: string): void {
  if (socks5ExperimentalWarningSuppressed) return;
  if (!normalizedProxy.startsWith('socks')) return;
  socks5ExperimentalWarningSuppressed = true;

  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const message =
      typeof warning === 'string'
        ? warning
        : ((warning as Error | undefined)?.message ?? '');
    if (message.includes('SOCKS5 proxy support is experimental')) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

/**
 * Connector options for the hop to the proxy itself.
 *
 * A SOCKS5 proxy is reached over plain TCP, but undici builds that hop's
 * connector from `proxyTls` and any value at all, even `{}`, makes it open a
 * TLS connection: the proxy then receives a ClientHello instead of the SOCKS5
 * greeting and the request hangs. Only `undefined` keeps the hop plain, so
 * SOCKS gives up the connect timeout that HTTP proxies still get.
 *
 * The hop is not left unbounded by that, it is bounded by values we do not
 * choose: undici's connector defaults to a 10s TCP connect, and its SOCKS5
 * agent hard-codes 5s around the greeting/auth exchange and 5s around
 * CONNECT. A caller asking for `connectTimeoutMs: 100` on a SOCKS proxy
 * silently gets those instead.
 */
function proxyHopConnectorOptions(
  normalizedProxy: string,
  connectTimeoutMs?: number,
): ReturnType<typeof connectorOptionsWithTimeout> | undefined {
  if (!isHttpProxyProtocol(new URL(normalizedProxy).protocol)) return undefined;
  return connectorOptionsWithTimeout(connectTimeoutMs);
}

function createProxyAgent(
  normalizedProxy: string,
  headersTimeoutMs: number,
  bodyTimeoutMs: number,
  connectTimeoutMs?: number,
): ProxyAgent {
  suppressSocks5ExperimentalWarning(normalizedProxy);
  return new ProxyAgent({
    uri: normalizedProxy,
    headersTimeout: headersTimeoutMs,
    bodyTimeout: bodyTimeoutMs,
    ...agentPoolOptions(),
    proxyTls: proxyHopConnectorOptions(normalizedProxy, connectTimeoutMs),
    requestTls: connectorOptionsWithTimeout(connectTimeoutMs),
  });
}

function getProxyAgentForTimeout(
  proxy: string,
  headersTimeoutMs: number,
  bodyTimeoutMs: number,
  connectTimeoutMs?: number,
): ProxyAgent {
  const normalizedProxy = normalizeProxyUrl(proxy);
  if (
    headersTimeoutMs === defaultTimeout &&
    bodyTimeoutMs === defaultTimeout &&
    currentProxyAgent &&
    currentProxy === normalizedProxy &&
    connectTimeoutMs === undefined
  ) {
    return currentProxyAgent;
  }
  const key = `${normalizedProxy}|${agentTimeoutKey(headersTimeoutMs, bodyTimeoutMs, connectTimeoutMs)}`;
  const cached = proxyAgentsByTimeout.get(key);
  if (cached) return cached;
  const agent = createProxyAgent(
    normalizedProxy,
    headersTimeoutMs,
    bodyTimeoutMs,
    connectTimeoutMs,
  );
  proxyAgentsByTimeout.set(key, agent);
  runLogger.log(
    `[fetch] ProxyAgent created: proxy=${redactProxyUrl(normalizedProxy)}, ` +
      `headersTimeout=${headersTimeoutMs}ms, bodyTimeout=${bodyTimeoutMs}ms`,
  );
  return agent;
}

export interface RequestScopedDispatcherOptions {
  connectTimeoutMs?: number;
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
}

/**
 * Creates an uncached dispatcher owned exclusively by the caller.
 */
export function createRequestScopedDispatcher(
  target: URL,
  options: RequestScopedDispatcherOptions,
): Dispatcher {
  const proxy = currentProxy;
  if (!proxy || !isProxyActiveForUrl(proxy, target)) {
    return createDirectAgent(
      options.headersTimeoutMs,
      options.bodyTimeoutMs,
      options.connectTimeoutMs,
    );
  }

  return createProxyAgent(
    normalizeProxyUrl(proxy),
    options.headersTimeoutMs,
    options.bodyTimeoutMs,
    options.connectTimeoutMs,
  );
}

function closeAgent(agent: HttpDispatcher): void {
  const close = (agent as { close?: () => unknown }).close;
  if (typeof close !== 'function') return;
  try {
    runLogger.debug(
      `[fetch] Closing ${
        agent instanceof ProxyAgent
          ? 'ProxyAgent'
          : agent instanceof Pool
            ? 'Pool'
            : 'Agent'
      }`,
    );
    const closeResult = close.call(agent) as
      | undefined
      | { catch?: (handler: (err: unknown) => void) => unknown };
    if (closeResult && typeof closeResult.catch === 'function') {
      closeResult.catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

function closeCustomTimeoutAgents(): void {
  for (const agent of directAgentsByTimeout.values()) {
    closeAgent(agent);
  }
  directAgentsByTimeout.clear();
  for (const agent of proxyAgentsByTimeout.values()) {
    closeAgent(agent);
  }
  proxyAgentsByTimeout.clear();
}

function getRequestTimeoutMs(init?: RequestInit): number | undefined {
  const timeoutMs = (init as CliFetchInit | undefined)?.cliRequestTimeoutMs;
  return normalizePositiveTimeoutMs(timeoutMs, { roundUp: true });
}

function getConnectTimeoutMs(init?: RequestInit): number | undefined {
  const timeoutMs = (init as CliFetchInit | undefined)?.cliConnectTimeoutMs;
  return normalizePositiveTimeoutMs(timeoutMs, { roundUp: true });
}

function getEffectiveRequestTimeoutMs(init?: RequestInit): number {
  return getRequestTimeoutMs(init) ?? defaultTimeout;
}

function getBodyIdleTimeoutMs(init?: RequestInit): number | undefined {
  const timeoutMs = (init as CliFetchInit | undefined)?.cliBodyIdleTimeoutMs;
  if (timeoutMs === 0) return 0;
  return normalizePositiveTimeoutMs(timeoutMs, { roundUp: true });
}

/**
 * Returns the body-idle timeout in ms for an undici Agent's bodyTimeout.
 * Explicit zero disables undici's body timeout for long-lived streams.
 * Otherwise this falls back to the request total for legacy callers.
 */
function getEffectiveBodyTimeoutMs(init?: RequestInit): number {
  return getBodyIdleTimeoutMs(init) ?? getEffectiveRequestTimeoutMs(init);
}

function stripFetchControlInit(init?: RequestInit): RequestInit | undefined {
  if (!init) return undefined;
  const {
    cliConnectTimeoutMs: _cliConnectTimeoutMs,
    cliRequestTimeoutMs: _cliRequestTimeoutMs,
    cliBodyIdleTimeoutMs: _cliBodyIdleTimeoutMs,
    ...rest
  } = init as CliFetchInit;
  return rest;
}

export function withFetchTimeouts(
  init: RequestInit | undefined,
  options: {
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
    bodyIdleTimeoutMs?: number;
  },
): CliFetchInit {
  return {
    ...(init ?? {}),
    ...(options.requestTimeoutMs !== undefined
      ? { cliRequestTimeoutMs: options.requestTimeoutMs }
      : {}),
    ...(options.connectTimeoutMs !== undefined
      ? { cliConnectTimeoutMs: options.connectTimeoutMs }
      : {}),
    ...(options.bodyIdleTimeoutMs !== undefined
      ? { cliBodyIdleTimeoutMs: options.bodyIdleTimeoutMs }
      : {}),
  };
}

function getResolvedIpAgent(
  originalHostname: string,
  ip: string,
  headersTimeoutMs = defaultTimeout,
  bodyTimeoutMs = headersTimeoutMs,
  connectTimeoutMs?: number,
): Agent {
  const key = `${originalHostname}|${ip}|${agentTimeoutKey(headersTimeoutMs, bodyTimeoutMs, connectTimeoutMs)}`;
  const cached = resolvedIpAgents.get(key);
  if (cached) return cached;

  const baseConnect = buildConnector(
    connectorOptionsWithTimeout(connectTimeoutMs),
  );
  const agent = new Agent({
    headersTimeout: headersTimeoutMs,
    bodyTimeout: bodyTimeoutMs,
    ...agentPoolOptions(),
    connect(options, callback) {
      baseConnect(
        {
          ...options,
          hostname: ip,
          servername: options.servername || originalHostname,
        },
        callback,
      );
    },
  });
  resolvedIpAgents.set(key, agent);
  runLogger.log(
    `[fetch] Resolved IP Agent created: ${originalHostname} -> ${ip}, ` +
      `headersTimeout=${headersTimeoutMs}ms, bodyTimeout=${bodyTimeoutMs}ms`,
  );
  return agent;
}

export function closeResolvedIpAgents(): void {
  for (const agent of resolvedIpAgents.values()) {
    closeAgent(agent);
  }
  resolvedIpAgents.clear();
}

// Configure default global dispatcher with higher timeouts.
installDirectGlobalDispatcher();

export function updateGlobalFetchTimeouts(timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `Invalid timeout value: ${timeoutMs}. Must be a positive finite number.`,
    );
  }
  defaultTimeout = timeoutMs;
  if (directAgent) {
    closeAgent(directAgent);
    directAgent = undefined;
  }
  closeCustomTimeoutAgents();
  closeResolvedIpAgents();
  if (currentProxy) {
    setGlobalProxy(currentProxy);
  } else {
    installDirectGlobalDispatcher();
  }
}

/**
 * Sanitizes a hostname by stripping IPv6 brackets if present.
 */
export function sanitizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Checks if a hostname is a local loopback address allowed for development/testing.
 */
export function isLoopbackHost(hostname: string): boolean {
  const sanitized = sanitizeHostname(hostname);
  return (
    sanitized === 'localhost' ||
    sanitized === '127.0.0.1' ||
    sanitized === '::1'
  );
}

export function isPrivateIp(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return isAddressPrivate(hostname);
  } catch {
    return false;
  }
}

/**
 * IANA Benchmark Testing Range (198.18.0.0/15).
 * Classified as 'unicast' by ipaddr.js but is reserved and should not be
 * accessible as public internet.
 */
const IANA_BENCHMARK_RANGE = ipaddr.parseCIDR('198.18.0.0/15');

/**
 * Checks if an address falls within the IANA benchmark testing range.
 */
function isBenchmarkAddress(addr: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  const [rangeAddr, rangeMask] = IANA_BENCHMARK_RANGE;
  return (
    addr instanceof ipaddr.IPv4 &&
    rangeAddr instanceof ipaddr.IPv4 &&
    addr.match(rangeAddr, rangeMask)
  );
}

/**
 * Internal helper to check if an IP address string is in a private or reserved range.
 */
export function isAddressPrivate(address: string): boolean {
  const sanitized = sanitizeHostname(address);

  if (sanitized === 'localhost') {
    return true;
  }

  try {
    if (!ipaddr.isValid(sanitized)) {
      return false;
    }

    const addr = ipaddr.parse(sanitized);

    // Special handling for IPv4-mapped IPv6 (::ffff:x.x.x.x)
    // We unmap it and check the underlying IPv4 address.
    if (addr instanceof ipaddr.IPv6 && addr.isIPv4MappedAddress()) {
      return isAddressPrivate(addr.toIPv4Address().toString());
    }

    // Explicitly block IANA benchmark testing range.
    if (isBenchmarkAddress(addr)) {
      return true;
    }

    return addr.range() !== 'unicast';
  } catch {
    // If parsing fails despite isValid(), we treat it as potentially unsafe.
    return true;
  }
}

/**
 * Checks if a URL resolves to a private IP address.
 */
export async function isPrivateIpAsync(url: string): Promise<boolean> {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;

    if (isLoopbackHost(hostname)) {
      return false;
    }

    const addresses = await lookup(hostname, { all: true });
    return addresses.some((addr) => isAddressPrivate(addr.address));
  } catch (error) {
    if (error instanceof TypeError) {
      return false;
    }
    throw new Error('Failed to verify if URL resolves to private IP', {
      cause: error,
    });
  }
}

/**
 * Creates an undici ProxyAgent that incorporates safe DNS lookup.
 */
export function createSafeProxyAgent(proxyUrl: string): ProxyAgent {
  const normalized = normalizeProxyUrl(proxyUrl);
  suppressSocks5ExperimentalWarning(normalized);
  runLogger.log(
    `[fetch] Safe ProxyAgent created: proxy=${redactProxyUrl(normalized)}`,
  );
  return new ProxyAgent({
    uri: normalized,
    ...agentPoolOptions(),
    proxyTls: proxyHopConnectorOptions(normalized),
    requestTls: connectorOptionsWithTimeout(),
  });
}

export async function fetchWithTimeout(
  url: string,
  timeout: number,
  options?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  const upstreamSignal = options?.signal ?? undefined;
  const onUpstreamAbort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort(upstreamSignal.reason);
    } else {
      upstreamSignal.addEventListener('abort', onUpstreamAbort, {
        once: true,
      });
    }
  }

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (
      isAbortError(error) ||
      (isNodeError(error) && error.code === 'ABORT_ERR')
    ) {
      if (timedOut) {
        throw new FetchError(
          `Request timed out after ${timeout}ms`,
          'ETIMEDOUT',
          { cause: error },
        );
      }
      throw new FetchError('Request was aborted', 'ABORT_ERR', {
        cause: error,
      });
    }
    throw new FetchError(getErrorMessage(error), undefined, { cause: error });
  } finally {
    clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener('abort', onUpstreamAbort);
  }
}

/**
 * Send a request to a non-first-party origin with the shared proxy, cancellation,
 * and timeout semantics, but without HTTPDNS routing or automatic retries.
 */
export function unmanagedStreamRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeouts: UnmanagedStreamRequestTimeouts = {},
): Promise<Response> {
  const connectTimeoutMs = timeouts.connectTimeoutMs ?? 10_000;
  const responseHeadersTimeoutMs = timeouts.responseHeadersTimeoutMs ?? 30_000;
  if (
    !Number.isFinite(connectTimeoutMs) ||
    connectTimeoutMs <= 0 ||
    !Number.isFinite(responseHeadersTimeoutMs) ||
    responseHeadersTimeoutMs <= 0
  ) {
    throw new RangeError('stream timeouts must be positive finite numbers');
  }

  return proxiedFetch(
    input,
    withFetchTimeouts(init, {
      connectTimeoutMs,
      requestTimeoutMs: responseHeadersTimeoutMs,
      bodyIdleTimeoutMs: 0,
    }),
  );
}

export async function unmanagedRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeouts: UnmanagedRequestTimeouts,
): Promise<Response> {
  if (!Number.isFinite(timeouts.timeoutMs) || timeouts.timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }
  const totalSignal = AbortSignal.timeout(Math.ceil(timeouts.timeoutMs));
  const composed = composeAbortSignals(
    init?.signal ? [init.signal, totalSignal] : [totalSignal],
  );
  try {
    const response = await proxiedFetch(
      input,
      withFetchTimeouts(
        { ...(init ?? {}), signal: composed.signal },
        {
          connectTimeoutMs:
            timeouts.connectTimeoutMs ?? Math.min(10_000, timeouts.timeoutMs),
          requestTimeoutMs: timeouts.timeoutMs,
          bodyIdleTimeoutMs: timeouts.bodyIdleTimeoutMs ?? timeouts.timeoutMs,
        },
      ),
    );
    return wrapResponseBodyWithCleanup(
      response,
      composed.cleanup,
      composed.signal,
    );
  } catch (error) {
    const reason = composed.signal.aborted
      ? (composed.signal.reason ??
        new DOMException('Request aborted', 'AbortError'))
      : error;
    composed.cleanup();
    throw reason;
  }
}

export function composeAbortSignals(signals: readonly AbortSignal[]): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted) return { signal: aborted, cleanup() {} };
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([...signals]), cleanup() {} };
  }

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const cleanup = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener('abort', listener);
    }
    listeners.clear();
  };
  for (const signal of signals) {
    const listener = () => {
      cleanup();
      controller.abort(signal.reason);
    };
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }
  const racedAbort = signals.find((signal) => signal.aborted);
  if (racedAbort && !controller.signal.aborted) {
    cleanup();
    controller.abort(racedAbort.reason);
  }
  return { signal: controller.signal, cleanup };
}

/**
 * Normalize HeadersInit into a plain record.
 * Shared utility used by fetch transports and available for other modules.
 */
export function headersInitToRecord(
  headers?: HeadersInit,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      result[k] = v;
    });
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) {
      result[k] = v;
    }
  } else {
    Object.assign(result, headers);
  }
  return result;
}

/**
 * Extract a URL string from the various input types accepted by fetch().
 */
function toUrlString(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function getNativeFetch(): typeof fetch {
  return (nativeFetchBeforeProxyPatch ?? globalThis.fetch).bind(globalThis);
}

function installGlobalFetchProxy(): void {
  if (!nativeFetchBeforeProxyPatch) {
    nativeFetchBeforeProxyPatch = globalThis.fetch;
    globalThis.fetch = proxiedFetch as typeof fetch;
  }
}

// Symmetric counterpart of installGlobalFetchProxy: restore the captured native
// fetch and clear the saved handle so a later re-enable can re-capture it.
function uninstallGlobalFetchProxy(): void {
  if (nativeFetchBeforeProxyPatch) {
    globalThis.fetch = nativeFetchBeforeProxyPatch;
  }
  nativeFetchBeforeProxyPatch = undefined;
}

function getNoProxyFromEnvironment(): string | undefined {
  return process.env['NO_PROXY'] || process.env['no_proxy'];
}

function parseNoProxyRule(rule: string): { host: string; port?: string } {
  if (rule.startsWith('[')) {
    const bracketEnd = rule.indexOf(']');
    if (bracketEnd > 0) {
      const host = rule.slice(1, bracketEnd);
      const port =
        rule[bracketEnd + 1] === ':' ? rule.slice(bracketEnd + 2) : undefined;
      return { host, port };
    }
  }

  const firstColon = rule.indexOf(':');
  if (firstColon !== -1 && rule.indexOf(':', firstColon + 1) === -1) {
    const host = rule.slice(0, firstColon);
    const port = rule.slice(firstColon + 1);
    if (port && /^\d+$/.test(port)) {
      return { host, port };
    }
  }

  return { host: rule };
}

function hostMatchesNoProxyRule(
  host: string,
  port: string,
  rule: string,
): boolean {
  if (rule === '*') return true;

  const normalizedHost = sanitizeHostname(host).toLowerCase();
  const parsedRule = parseNoProxyRule(rule.toLowerCase());
  const ruleHost = sanitizeHostname(parsedRule.host);
  const rulePort = parsedRule.port;

  if (rulePort && rulePort !== port) {
    return false;
  }

  if (!ruleHost) {
    return false;
  }

  if (ruleHost.startsWith('.')) {
    return normalizedHost.endsWith(ruleHost);
  }

  return normalizedHost === ruleHost || normalizedHost.endsWith(`.${ruleHost}`);
}

export function shouldBypassProxy(target: URL): boolean {
  const noProxy = getNoProxyFromEnvironment();
  if (!noProxy) return false;

  const port = target.port || (target.protocol === 'https:' ? '443' : '80');

  return noProxy
    .split(',')
    .map((rule) => rule.trim())
    .filter(Boolean)
    .some((rule) => hostMatchesNoProxyRule(target.hostname, port, rule));
}

/**
 * Returns whether an HTTP(S) target will use the configured shared proxy.
 * Keep this in sync with proxiedFetchImpl so callers can make route-aware
 * security decisions without reimplementing NO_PROXY handling.
 */
export function isProxyActiveForUrl(
  proxy: string | undefined,
  target: URL,
): boolean {
  return (
    proxy !== undefined &&
    isHttpProxyProtocol(target.protocol) &&
    !shouldBypassProxy(target)
  );
}

/**
 * Returns whether an HTTP(S) target will use the currently installed shared
 * proxy. This reflects the route unmanagedRequest will actually take.
 */
export function isGlobalProxyActiveForUrl(target: URL): boolean {
  return isProxyActiveForUrl(currentProxy, target);
}

function isHttpProxyProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

function isNativeBunProxyProtocol(protocol: string): boolean {
  // Bun's native fetch proxies the same protocols undici's ProxyAgent handles.
  return isHttpProxyProtocol(protocol);
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      delete headers[key];
    }
  }
}

export function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function isReplayableBody(body: BodyInit | null | undefined): boolean {
  return (
    body == null ||
    typeof body === 'string' ||
    Buffer.isBuffer(body) ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    body instanceof URLSearchParams ||
    body instanceof FormData ||
    body instanceof Blob
  );
}

function normalizeFetchInput(
  input: RequestInfo | URL,
  init?: RequestInit,
): { url: URL; init: RequestInit } {
  if (input instanceof Request) {
    return {
      url: new URL(input.url),
      init: {
        ...init,
        method: init?.method ?? input.method,
        headers: init?.headers ?? input.headers,
        body:
          init && 'body' in init
            ? init.body
            : ((input.body as BodyInit | null) ?? undefined),
        signal: init?.signal ?? input.signal,
        redirect: init?.redirect ?? input.redirect,
      },
    };
  }

  return {
    url: new URL(toUrlString(input)),
    init: init ?? {},
  };
}

type UndiciFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;
type UndiciRequestInit = NonNullable<Parameters<typeof undiciRequest>[1]>;

function fetchViaUndici(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  dispatcher: HttpDispatcher,
): Promise<Response> {
  const normalized = normalizeFetchInput(input, init);
  const requestInit = stripFetchControlInit(normalized.init);
  const undiciInit = {
    ...(requestInit ?? {}),
    dispatcher,
    ...(requestInit?.body instanceof ReadableStream
      ? { duplex: 'half' as const }
      : {}),
  } as UndiciFetchInit;
  return undiciFetch(
    normalized.url,
    undiciInit,
  ) as unknown as Promise<Response>;
}

/**
 * Bun 1.3.14 can receive npm undici fetch() response headers while leaving its
 * WHATWG response body pending forever. undici.request() does not use that
 * fetch adapter: it exposes the working Node BodyReadable directly. Convert
 * that stream into a standards-compatible Response while keeping the real
 * undici Agent responsible for fixed-IP connection, Host, SNI, and certificate
 * validation.
 */
async function fetchViaUndiciRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  dispatcher: HttpDispatcher,
  options?: {
    headersTimeoutMs: number;
    bodyTimeoutMs: number;
    onTransportBodySettled?: () => void;
  },
): Promise<Response> {
  const normalized = normalizeFetchInput(input, init);
  const requestInit = stripFetchControlInit(normalized.init);
  const method = (requestInit?.method ?? 'GET').toUpperCase();
  const preparedBody = prepareUndiciRequestBody(
    requestInit?.body,
    requestInit?.headers,
    normalized.url,
    method,
  );
  const requestPromise = undiciRequest(normalized.url, {
    dispatcher,
    method,
    headers: preparedBody.headers,
    body: preparedBody.body,
    signal: requestInit?.signal ?? undefined,
    ...(options
      ? {
          headersTimeout: options.headersTimeoutMs,
          bodyTimeout: options.bodyTimeoutMs,
        }
      : {}),
  } as UndiciRequestInit);
  const result = await raceWithAbortSignal(
    requestPromise,
    requestInit?.signal ?? undefined,
  );

  const headers = new Headers();
  for (const [name, value] of Object.entries(result.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, String(value));
    }
  }

  const hasNullBody =
    method === 'HEAD' ||
    result.statusCode === 204 ||
    result.statusCode === 205 ||
    result.statusCode === 304;
  if (hasNullBody) {
    destroyResponseBodyQuietly(result.body);
    options?.onTransportBodySettled?.();
    return new Response(null, {
      status: result.statusCode,
      statusText: result.statusText,
      headers,
    });
  }

  try {
    const decodedBody = decodeUndiciResponseBody(
      result.body,
      headers.get('content-encoding'),
    );
    attachReadableCleanup(decodedBody, options?.onTransportBodySettled);
    const bodyStream = readableToWebWithoutLateEnqueue(decodedBody);
    return new Response(bodyStream, {
      status: result.statusCode,
      statusText: result.statusText,
      headers,
    });
  } catch (error) {
    destroyResponseBodyQuietly(
      result.body,
      error instanceof Error ? error : undefined,
    );
    throw error;
  }
}

/**
 * Convert an undici Node response body without relying on Bun's
 * Readable.toWeb() adapter.
 *
 * Bun 1.3.14 may deliver a queued Node `data` event after Web-stream
 * cancellation has already closed the controller. Its adapter then calls
 * enqueue() on that closed controller and raises a process-level exception.
 * This pull-based bridge marks cancellation terminal before destroying the
 * producer and checks that state again before every enqueue.
 *
 * Only reachable via fetchViaUndiciRequest, whose callers are all gated on
 * isBunRuntime(); Node never runs this bridge.
 */
function readableToWebWithoutLateEnqueue(
  body: Readable,
): ReadableStream<Uint8Array> {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let settled = false;
  let pumping = false;

  const detach = () => {
    body.removeListener('readable', onReadable);
    body.removeListener('end', onEnd);
    body.removeListener('error', onError);
    body.removeListener('close', onClose);
  };

  // Record terminal state and stop listening, without touching the controller.
  // Callers that need to close/error the controller must capture it first.
  const markTerminal = () => {
    settled = true;
    controller = undefined;
    detach();
  };

  const settle = (error?: unknown) => {
    if (settled) return;
    const currentController = controller;
    markTerminal();
    if (!currentController) return;
    try {
      if (error === undefined) {
        currentController.close();
      } else {
        currentController.error(error);
      }
    } catch {
      // The consumer may have closed the Web stream before a queued Node
      // terminal event ran. Terminal state is already recorded above.
    }
  };

  const pump = () => {
    if (settled || pumping || !controller) return;
    pumping = true;
    try {
      while (!settled && controller) {
        const desiredSize = controller.desiredSize;
        if (desiredSize !== null && desiredSize <= 0) return;

        const chunk = body.read() as unknown;
        if (settled || !controller) return;
        if (chunk === null) {
          if (body.readableEnded) settle();
          return;
        }
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError(
            'Undici response body emitted a non-binary stream chunk',
          );
        }
        controller.enqueue(chunk);
      }
    } catch (error) {
      settle(error);
      destroyResponseBodyQuietly(body);
    } finally {
      pumping = false;
    }
  };

  const onReadable = () => pump();
  const onEnd = () => settle();
  const onError = (error: Error) => settle(error);
  const onClose = () => settle();

  return new ReadableStream<Uint8Array>({
    start(readableController) {
      controller = readableController;
      body.on('readable', onReadable);
      body.once('end', onEnd);
      body.once('error', onError);
      body.once('close', onClose);

      if (body.readableEnded || body.destroyed) {
        queueMicrotask(() => settle());
      }
    },
    pull() {
      pump();
    },
    cancel() {
      if (settled) return;

      // Mark the bridge terminal before destroying the producer. Destruction
      // can synchronously or asynchronously trigger more Node stream events.
      markTerminal();
      destroyResponseBodyQuietly(body);
    },
  });
}

/**
 * Destroy an undici response body without leaking a process-level exception.
 *
 * undici's `BodyReadable._destroy()` synthesizes `AbortError: Request aborted`
 * whenever the body is destroyed before it ended, and Node emits that error as
 * an `'error'` event on the stream. Cancelling a response we deliberately
 * abandoned (first-payload timeout, caller cancellation, decode failure) is a
 * normal outcome, but the stream usually has no `'error'` listener left at that
 * point — the bridge detaches its own listeners first, and the lease cleanup
 * listener is only installed on the SOCKS-proxy path. Without a sink the event
 * escapes as an `uncaughtException`. Attach a no-op sink before destroying.
 */
function destroyResponseBodyQuietly(body: Readable, error?: Error): void {
  // The sink is attached even when the body is already destroyed: `destroyed`
  // flips synchronously inside `destroy()` while the synthesized error is
  // emitted a tick later, so a caller reaching an already-destroyed body may
  // still be ahead of the event.
  body.once('error', () => {});
  if (!body.destroyed) body.destroy(error);
}

function attachReadableCleanup(
  body: Readable,
  cleanup: (() => void) | undefined,
): void {
  if (!cleanup) return;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    body.removeListener('end', settle);
    body.removeListener('error', settle);
    body.removeListener('close', settle);
    cleanup();
  };
  body.once('end', settle);
  body.once('error', settle);
  body.once('close', settle);
  if (body.readableEnded || body.destroyed) {
    queueMicrotask(settle);
  }
}

interface PreparedUndiciRequestBody {
  body: UndiciRequestInit['body'];
  headers: HeadersInit | undefined;
}

function withDefaultContentType(
  headers: HeadersInit | undefined,
  contentType: string,
): HeadersInit {
  const record = headersInitToRecord(headers);
  if (
    !Object.keys(record).some((name) => name.toLowerCase() === 'content-type')
  ) {
    record['Content-Type'] = contentType;
  }
  return record;
}

function prepareUndiciRequestBody(
  body: BodyInit | null | undefined,
  headers: HeadersInit | undefined,
  url: string | URL,
  method: string,
): PreparedUndiciRequestBody {
  if (body == null) return { body: undefined, headers };
  if (body instanceof URLSearchParams) {
    return {
      body: body.toString(),
      headers: withDefaultContentType(
        headers,
        'application/x-www-form-urlencoded;charset=UTF-8',
      ),
    };
  }
  if (typeof body === 'string') {
    return {
      body,
      headers: withDefaultContentType(headers, 'text/plain;charset=UTF-8'),
    };
  }
  if (body instanceof FormData) {
    // npm undici.request() does not recognize Bun's native FormData class.
    // Let the runtime's Request implementation encode it, then hand the
    // resulting byte stream and matching multipart boundary to undici.
    const encodedRequest = new Request(url, { method, body });
    const encodedBody = encodedRequest.body;
    return {
      body: encodedBody
        ? Readable.fromWeb(
            encodedBody as unknown as import('node:stream/web').ReadableStream,
          )
        : undefined,
      headers: encodedRequest.headers.has('content-type')
        ? withDefaultContentType(
            headers,
            encodedRequest.headers.get('content-type')!,
          )
        : headers,
    };
  }
  if (
    Buffer.isBuffer(body) ||
    body instanceof Uint8Array ||
    body instanceof Blob
  ) {
    return { body: body as unknown as UndiciRequestInit['body'], headers };
  }
  if (body instanceof ArrayBuffer) {
    return { body: Buffer.from(body), headers };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      body: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
      headers,
    };
  }
  if (body instanceof ReadableStream) {
    return {
      body: Readable.fromWeb(
        body as unknown as import('node:stream/web').ReadableStream,
      ),
      headers,
    };
  }
  return { body: body as UndiciRequestInit['body'], headers };
}

function createContentDecoder(encoding: string): Transform | null {
  const flushOptions = {
    flush: zlib.constants.Z_SYNC_FLUSH,
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
  };
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip(flushOptions);
    case 'deflate':
      return zlib.createInflate(flushOptions);
    case 'br':
      return zlib.createBrotliDecompress({
        flush: zlib.constants.BROTLI_OPERATION_FLUSH,
        finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
      });
    case 'zstd': {
      const zstd = zlib as typeof zlib & {
        createZstdDecompress?: (options: {
          flush: number;
          finishFlush: number;
        }) => Transform;
        constants: typeof zlib.constants & {
          ZSTD_e_continue?: number;
          ZSTD_e_end?: number;
        };
      };
      if (
        !zstd.createZstdDecompress ||
        zstd.constants.ZSTD_e_continue === undefined ||
        zstd.constants.ZSTD_e_end === undefined
      ) {
        return null;
      }
      return zstd.createZstdDecompress({
        flush: zstd.constants.ZSTD_e_continue,
        finishFlush: zstd.constants.ZSTD_e_end,
      });
    }
    default:
      return null;
  }
}

function decodeUndiciResponseBody(
  body: Readable,
  contentEncoding: string | null,
): Readable {
  if (!contentEncoding) return body;
  const encodings = contentEncoding
    .toLowerCase()
    .split(',')
    .map((encoding) => encoding.trim());
  if (encodings.length > 5) {
    const error = new Error(
      `too many content-encodings in response: ${encodings.length}, maximum allowed is 5`,
    );
    destroyResponseBodyQuietly(body, error);
    throw error;
  }

  const decoders: Transform[] = [];
  for (let index = encodings.length - 1; index >= 0; index--) {
    const decoder = createContentDecoder(encodings[index]);
    if (!decoder) {
      for (const createdDecoder of decoders) createdDecoder.destroy();
      return body;
    }
    decoders.push(decoder);
  }
  if (decoders.length === 0) return body;
  return (
    nodeStream as typeof nodeStream & {
      compose(
        stream: NodeJS.ReadableStream,
        ...streams: NodeJS.ReadWriteStream[]
      ): Readable;
    }
  ).compose(body, ...decoders);
}

interface ManualRedirectOptions {
  dispatch: (url: URL, init: RequestInit) => Promise<Response>;
  headersToStripOnRedirect?: readonly string[];
  handoffRedirect?: (
    nextUrl: URL,
    nextInit: RequestInit,
  ) => Promise<Response | undefined>;
}

async function fetchWithManualRedirects(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: ManualRedirectOptions,
): Promise<Response> {
  const normalized = normalizeFetchInput(input, init);
  let targetUrl = normalized.url;
  let requestInit = normalized.init;
  const redirectMode = requestInit.redirect ?? 'follow';
  let redirected = false;

  for (let redirectCount = 0; redirectCount < 20; redirectCount++) {
    const response = await options.dispatch(targetUrl, {
      ...requestInit,
      redirect: 'manual',
    });
    patchResolvedResponseMetadata(response, targetUrl, redirected);

    if (!isRedirectStatus(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || redirectMode === 'manual') return response;
    if (redirectMode === 'error') {
      cancelResponseBody(response);
      throw new TypeError(`Redirect encountered for ${targetUrl.href}`);
    }

    const nextUrl = new URL(location, targetUrl);
    const currentMethod = (requestInit.method ?? 'GET').toUpperCase();
    const shouldSwitchToGet =
      (response.status === 303 && currentMethod !== 'HEAD') ||
      ((response.status === 301 || response.status === 302) &&
        currentMethod === 'POST');
    if (
      !shouldSwitchToGet &&
      requestInit.body &&
      !isReplayableBody(requestInit.body)
    ) {
      cancelResponseBody(response);
      throw new TypeError(
        'Cannot follow redirect with a non-replayable request body',
      );
    }

    const nextHeaders = headersInitToRecord(requestInit.headers);
    if (nextUrl.origin !== targetUrl.origin) {
      deleteHeader(nextHeaders, 'authorization');
      deleteHeader(nextHeaders, 'cookie');
    }
    for (const header of options.headersToStripOnRedirect ?? []) {
      deleteHeader(nextHeaders, header);
    }

    cancelResponseBody(response);
    const nextRequestInit = shouldSwitchToGet
      ? {
          ...requestInit,
          method: 'GET',
          body: undefined,
          headers: removeBodyHeaders(nextHeaders),
        }
      : { ...requestInit, headers: nextHeaders };
    const handedOffResponse = await options.handoffRedirect?.(
      nextUrl,
      nextRequestInit,
    );
    if (handedOffResponse) {
      return patchRedirectedFallbackMetadata(handedOffResponse, nextUrl);
    }

    redirected = true;
    requestInit = nextRequestInit;
    targetUrl = nextUrl;
  }

  throw new TypeError('Maximum redirect count exceeded');
}

function removeBodyHeaders(headers?: HeadersInit): Record<string, string> {
  const record = headersInitToRecord(headers);
  deleteHeader(record, 'content-length');
  deleteHeader(record, 'content-type');
  deleteHeader(record, 'transfer-encoding');
  return record;
}

function withResolvedIpHeaders(
  init: RequestInit | undefined,
  options: FetchWithResolvedIpOptions,
): RequestInit {
  const headers = headersInitToRecord(init?.headers);
  if (options.markerHeader) {
    headers[options.markerHeader] = options.ip;
  }
  return {
    ...init,
    headers,
  };
}

/**
 * Perform an HTTP(S) request to a pre-resolved IP while preserving the original
 * URL host for HTTP Host, TLS SNI, and certificate validation.
 */
function fetchViaResolvedIp(
  targetUrl: string,
  init: RequestInit | undefined,
  options: FetchWithResolvedIpOptions,
): Promise<Response> {
  const requestInit = withResolvedIpHeaders(init, options);
  const requestTimeoutMs = getEffectiveRequestTimeoutMs(requestInit);
  const bodyTimeoutMs = getEffectiveBodyTimeoutMs(requestInit);
  const connectTimeoutMs = getConnectTimeoutMs(requestInit);
  const dispatcher = getResolvedIpAgent(
    options.originalHostname,
    options.ip,
    requestTimeoutMs,
    bodyTimeoutMs,
    connectTimeoutMs,
  );
  if (isBunRuntime()) {
    const dispatcherFetch = ((
      nextInput: RequestInfo | URL,
      nextInit?: RequestInit,
    ) =>
      fetchViaUndiciRequest(nextInput, nextInit, dispatcher)) as typeof fetch;
    return invokeWithFetchTimeout(
      dispatcherFetch,
      targetUrl,
      requestInit,
      getRequestTimeoutMs(requestInit),
      getBodyIdleTimeoutMs(requestInit),
    );
  }
  return fetchViaUndici(
    targetUrl,
    {
      ...requestInit,
      // Redirect routing is handled by fetchViaResolvedIpWithRedirects so a
      // cross-host redirect cannot inherit the current hostname's pinned IP.
      redirect: 'manual',
    },
    dispatcher,
  );
}

type ResponseMetadata = Pick<Response, 'url' | 'redirected' | 'type'>;

function patchResolvedResponseMetadata(
  response: Response,
  url: URL,
  redirected: boolean,
): Response {
  patchResponseMetadata(response, {
    url: url.href,
    redirected,
    type: 'basic',
  });
  return response;
}

function patchRedirectedFallbackMetadata(
  response: Response,
  fallbackUrl: URL,
): Response {
  patchResponseMetadata(response, {
    url: response.url || fallbackUrl.href,
    redirected: true,
    type: response.type,
  });
  return response;
}

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    /* body may already be locked or consumed */
  }
}

/** Cancel a response body, optionally bounding how long cancellation may delay progress. */
export async function discardResponseBody(
  response: Response | undefined,
  options?: { timeoutMs?: number },
): Promise<void> {
  if (!response?.body) return;

  const cancel = response.body.cancel().catch(() => undefined);
  const timeoutMs = options?.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) {
    await cancel;
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([cancel, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a response body into memory under a hard byte cap.
 *
 * The `content-length` header is only a hint, so the cap is also enforced while
 * streaming: a response that lies about its size is aborted mid-body rather
 * than buffered in full.
 */
export async function readLimitedResponseBody(
  response: Response,
  maxBytes: number,
  options?: { subject?: string; logTag?: string },
): Promise<Buffer> {
  const subject = options?.subject ?? 'Response';
  const logTag = options?.logTag ?? 'Fetch';
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    runLogger.warn(
      `[${logTag}] content-length ${contentLength} exceeds max ${maxBytes} bytes, rejecting`,
    );
    await discardResponseBody(response);
    throw new Error(
      `${subject} too large: ${contentLength} bytes (max ${maxBytes})`,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${subject} has no body`);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel();
        runLogger.warn(
          `[${logTag}] streaming body exceeded max ${maxBytes} bytes at ${totalBytes}, aborting`,
        );
        throw new Error(`${subject} too large: exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function fetchViaBunNativeProxy(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  proxyUrl: string,
  requestTimeoutMs: number | undefined,
  bodyIdleTimeoutMs: number | undefined,
): Promise<Response> {
  const nativeInit = stripFetchControlInit(init) as
    | BunProxyFetchInit
    | undefined;
  const proxiedInit: BunProxyFetchInit = {
    ...(nativeInit ?? {}),
    proxy: proxyUrl,
  };
  return invokeWithFetchTimeout(
    getNativeFetch(),
    input,
    proxiedInit,
    requestTimeoutMs,
    bodyIdleTimeoutMs,
  );
}

/**
 * SOCKS traffic on Bun. Bun's native fetch ignores undici's `dispatcher`
 * option, so pointing it at a ProxyAgent would silently connect direct; the
 * request has to be dispatched through npm undici itself. undici.request does
 * not follow redirects, hence the manual walk.
 */
function fetchViaUndiciProxy(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  proxyUrl: string,
  headersTimeoutMs: number,
  bodyTimeoutMs: number,
  connectTimeoutMs: number | undefined,
  requestTimeoutMs: number | undefined,
  bodyIdleTimeoutMs: number | undefined,
): Promise<Response> {
  const dispatcher = getProxyAgentForTimeout(
    proxyUrl,
    headersTimeoutMs,
    bodyTimeoutMs,
    connectTimeoutMs,
  );
  const dispatcherFetch = ((
    nextInput: RequestInfo | URL,
    nextInit?: RequestInit,
  ) => {
    assertSupportedProxyInit(nextInit);
    return fetchViaUndiciRequest(nextInput, nextInit, dispatcher, {
      headersTimeoutMs,
      bodyTimeoutMs,
    });
  }) as typeof fetch;
  return invokeWithFetchTimeout(
    ((nextInput, nextInit) =>
      fetchWithManualRedirects(nextInput, nextInit, {
        dispatch: dispatcherFetch,
      })) as typeof fetch,
    input,
    init,
    requestTimeoutMs ?? headersTimeoutMs,
    bodyIdleTimeoutMs,
  );
}

function assertSupportedProxyInit(init: RequestInit | undefined): void {
  if ((init as BunProxyFetchInit | undefined)?.tls === undefined) return;
  throw new TypeError(
    'Per-request tls options are not supported with SOCKS proxies; configure target trust through the process TLS environment instead',
  );
}

async function fetchViaResolvedIpWithRedirects(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: FetchWithResolvedIpOptions,
): Promise<Response> {
  return fetchWithManualRedirects(input, init, {
    dispatch: (url, requestInit) =>
      fetchViaResolvedIp(url.href, requestInit, options),
    headersToStripOnRedirect: options.markerHeader
      ? [options.markerHeader]
      : undefined,
    handoffRedirect: (nextUrl, nextInit) =>
      nextUrl.hostname !== options.originalHostname
        ? proxiedFetch(nextUrl.href, nextInit)
        : Promise.resolve(undefined),
  });
}

export function fetchWithResolvedIp(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: FetchWithResolvedIpOptions,
): Promise<Response> {
  if (!net.isIPv4(options.ip)) {
    throw new TypeError(`Invalid resolved IP: ${options.ip}`);
  }

  if (isBunRuntime()) {
    return enforceResponseHeaderLimit(
      fetchViaResolvedIpWithRedirects(input, init, options),
    );
  }

  const requestTimeoutMs = getEffectiveRequestTimeoutMs(init);
  const bodyTimeoutMs = getEffectiveBodyTimeoutMs(init);
  const connectTimeoutMs = getConnectTimeoutMs(init);
  return proxiedFetch(input, {
    ...withResolvedIpHeaders(init, options),
    dispatcher: getResolvedIpAgent(
      options.originalHostname,
      options.ip,
      requestTimeoutMs,
      bodyTimeoutMs,
      connectTimeoutMs,
    ),
  } as RequestInit);
}

export function proxiedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: ProxiedFetchOptions = {},
): Promise<Response> {
  // Enforce the response-header byte limit once at the boundary so no return
  // path can silently skip the guard.
  return enforceResponseHeaderLimit(proxiedFetchImpl(input, init, options));
}

function fetchWithDispatcher(
  input: RequestInfo | URL,
  nativeInit: RequestInit | undefined,
  dispatcher: unknown,
): Promise<Response> {
  return fetchViaUndici(
    input,
    nativeInit,
    dispatcher as HttpDispatcher,
  );
}

function proxiedFetchImpl(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: ProxiedFetchOptions = {},
): Promise<Response> {
  ensureUndiciDiagnosticsInstalled();

  const requestTimeoutMs = getRequestTimeoutMs(init);
  const bodyIdleTimeoutMs = getBodyIdleTimeoutMs(init);
  const connectTimeoutMs = getConnectTimeoutMs(init);
  const headersTimeoutMs = requestTimeoutMs ?? defaultTimeout;
  const bodyTimeoutMs = bodyIdleTimeoutMs ?? headersTimeoutMs;
  const nativeInit = stripFetchControlInit(init);
  const existingDispatcher = (
    nativeInit as RequestInit & {
      dispatcher?: unknown;
    }
  )?.dispatcher;
  const hasCustomTimeout =
    requestTimeoutMs !== undefined ||
    bodyIdleTimeoutMs !== undefined ||
    connectTimeoutMs !== undefined;
  const selectedProxy = options.proxyUrl ?? currentProxy;
  const proxyPinnedToRoute = options.proxyUrl !== undefined;
  if (selectedProxy) {
    const targetUrl = normalizeFetchInput(input, init).url;
    if (
      !isHttpProxyProtocol(targetUrl.protocol) ||
      (!proxyPinnedToRoute && !isProxyActiveForUrl(selectedProxy, targetUrl))
    ) {
      if (!isBunRuntime()) {
        return fetchWithDispatcher(
          input,
          nativeInit,
          existingDispatcher ??
            getDirectAgent(headersTimeoutMs, bodyTimeoutMs, connectTimeoutMs),
        );
      }
      return invokeWithFetchTimeout(
        getNativeFetch(),
        input,
        nativeInit,
        requestTimeoutMs,
        bodyIdleTimeoutMs,
      );
    }

    const normalizedProxy = normalizeProxyUrl(selectedProxy);

    if (!isBunRuntime()) {
      // Respect a caller-provided dispatcher (e.g. resolved-IP agent) instead
      // of silently overriding it with the proxy agent.
      const dispatcher =
        existingDispatcher ??
        getProxyAgentForTimeout(
          normalizedProxy,
          headersTimeoutMs,
          bodyTimeoutMs,
          connectTimeoutMs,
        );
      return fetchWithDispatcher(input, nativeInit, dispatcher);
    }

    if (isNativeBunProxyProtocol(new URL(normalizedProxy).protocol)) {
      return fetchViaBunNativeProxy(
        input,
        init,
        normalizedProxy,
        requestTimeoutMs,
        bodyIdleTimeoutMs,
      );
    }

    // Bun's native fetch only understands HTTP(S) proxies, so SOCKS goes
    // through npm undici's ProxyAgent, the same one the Node path builds.
    return fetchViaUndiciProxy(
      input,
      init,
      normalizedProxy,
      headersTimeoutMs,
      bodyTimeoutMs,
      connectTimeoutMs,
      requestTimeoutMs,
      bodyIdleTimeoutMs,
    );
  }

  if (
    !isBunRuntime() &&
    (hasCustomTimeout || existingDispatcher !== undefined)
  ) {
    return fetchWithDispatcher(
      input,
      nativeInit,
      existingDispatcher ??
        getDirectAgent(headersTimeoutMs, bodyTimeoutMs, connectTimeoutMs),
    );
  }

  // Bun does not honor undici dispatcher timeouts — synthesize them via
  // AbortSignal so cli*TimeoutMs still applies on Bun. On Node with an
  // existing dispatcher, that dispatcher already carries timeouts, so don't
  // wrap.
  if (
    isBunRuntime() &&
    (requestTimeoutMs !== undefined || bodyIdleTimeoutMs !== undefined)
  ) {
    return invokeWithFetchTimeout(
      getNativeFetch(),
      input,
      nativeInit,
      requestTimeoutMs,
      bodyIdleTimeoutMs,
    );
  }

  return getNativeFetch()(input, nativeInit);
}

function enforceResponseHeaderLimit(
  responsePromise: Promise<Response>,
): Promise<Response> {
  return responsePromise.then((response) => {
    let headerBytes = 2; // Final CRLF terminating the header field section.
    for (const [name, value] of response.headers) {
      headerBytes +=
        Buffer.byteLength(name, 'utf8') +
        2 +
        Buffer.byteLength(value, 'utf8') +
        2;
      if (headerBytes > MAX_HTTP_RESPONSE_HEADER_BYTES) {
        cancelResponseBody(response);
        throw new ProtocolLimitError(
          `HTTP response headers exceed ${MAX_HTTP_RESPONSE_HEADER_BYTES} bytes`,
          'http_response_headers',
          MAX_HTTP_RESPONSE_HEADER_BYTES,
          headerBytes,
        );
      }
    }
    return response;
  });
}

function invokeWithFetchTimeout(
  fetchFn: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number | undefined,
  bodyIdleTimeoutMs?: number,
): Promise<Response> {
  const effectiveBodyIdleTimeoutMs =
    bodyIdleTimeoutMs === 0 ? undefined : bodyIdleTimeoutMs;
  if (timeoutMs === undefined && effectiveBodyIdleTimeoutMs === undefined) {
    return fetchFn(input, init);
  }
  const controller = new AbortController();
  const upstream = init?.signal;
  const onUpstreamAbort = () => controller.abort(upstream?.reason);
  if (upstream) {
    if (upstream.aborted) {
      controller.abort(upstream.reason);
    } else {
      upstream.addEventListener('abort', onUpstreamAbort, { once: true });
    }
  }
  const timeoutId =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(
            Object.assign(
              new DOMException(
                `Request timed out after ${timeoutMs}ms`,
                'TimeoutError',
              ),
              { phase: 'response_headers' as const },
            ),
          );
        }, timeoutMs);
  timeoutId?.unref?.();

  // clearTimeout and removeEventListener are both idempotent, so these can be
  // called repeatedly without a guard flag.
  const cleanupTimeout = () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  };

  const cleanupUpstream = () => {
    if (upstream) {
      upstream.removeEventListener('abort', onUpstreamAbort);
    }
  };

  const cleanup = () => {
    cleanupTimeout();
    cleanupUpstream();
  };

  return fetchFn(input, { ...init, signal: controller.signal }).then(
    (response) => {
      if (!response.body) {
        cleanup();
        return response;
      }
      if (effectiveBodyIdleTimeoutMs === undefined) {
        cleanupTimeout();
        if (!upstream) {
          return response;
        }
        try {
          return wrapResponseBodyWithCleanup(
            response,
            cleanupUpstream,
            upstream,
          );
        } catch (error) {
          cleanup();
          throw error;
        }
      }
      try {
        cleanupTimeout();
        return wrapResponseBodyWithIdleTimeout(
          response,
          controller,
          effectiveBodyIdleTimeoutMs,
          cleanup,
        );
      } catch (error) {
        cleanup();
        throw error;
      }
    },
    (error) => {
      const timeoutReason =
        controller.signal.aborted && !upstream?.aborted
          ? controller.signal.reason
          : undefined;
      cleanup();
      if (timeoutReason !== undefined) {
        throw timeoutReason;
      }
      throw error;
    },
  );
}

function copyResponseMetadata(target: Response, source: ResponseMetadata) {
  for (const key of ['url', 'redirected', 'type'] as const) {
    try {
      Object.defineProperty(target, key, {
        value: source[key],
        configurable: true,
        enumerable: true,
      });
    } catch {
      /* native response property is not configurable in some runtimes */
    }
  }
}

function responseWithBody(
  response: Response,
  body: ReadableStream<Uint8Array>,
) {
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  patchResponseMetadata(wrapped, response);

  return wrapped;
}

function patchResponseMetadata(target: Response, source: ResponseMetadata) {
  copyResponseMetadata(target, source);
  try {
    const clone = target.clone.bind(target);
    Object.defineProperty(target, 'clone', {
      value() {
        const cloned = clone();
        patchResponseMetadata(cloned, source);
        return cloned;
      },
      configurable: true,
      enumerable: false,
    });
  } catch {
    /* native response clone is not configurable in some runtimes */
  }
}

export function wrapResponseBodyWithCleanup(
  response: Response,
  cleanup: () => void,
  upstream?: AbortSignal,
): Response {
  const body = response.body;
  if (!body) {
    cleanup();
    return response;
  }

  const reader = body.getReader();
  let finished = false;

  const finish = () => {
    if (finished) return false;
    finished = true;
    cleanup();
    return true;
  };

  const upstreamAbortReason = (): unknown => {
    const reason = upstream?.reason as unknown;
    return reason ?? new DOMException('Request aborted', 'AbortError');
  };

  const fail = (
    readableController: ReadableStreamDefaultController<Uint8Array>,
    reason: unknown,
  ) => {
    if (!finish()) return;
    try {
      readableController.error(reason);
    } finally {
      void reader.cancel(reason).catch(() => {});
    }
  };

  const wrappedBody = new ReadableStream<Uint8Array>({
    async pull(readableController) {
      if (upstream?.aborted) {
        fail(readableController, upstreamAbortReason());
        return;
      }

      let removeUpstreamAbort: (() => void) | undefined;
      try {
        const abortPromise = upstream
          ? new Promise<never>((_, reject) => {
              const onAbort = () => reject(upstreamAbortReason());
              upstream.addEventListener('abort', onAbort, { once: true });
              removeUpstreamAbort = () =>
                upstream.removeEventListener('abort', onAbort);
            })
          : undefined;
        if (upstream?.aborted) {
          throw upstreamAbortReason();
        }
        const readPromise = reader.read();
        const result = abortPromise
          ? await Promise.race([readPromise, abortPromise])
          : await readPromise;
        removeUpstreamAbort?.();
        if (finished) return;
        if (result.done) {
          finish();
          readableController.close();
          return;
        }
        readableController.enqueue(result.value);
      } catch (error) {
        removeUpstreamAbort?.();
        const reason = upstream?.aborted ? upstreamAbortReason() : error;
        fail(readableController, reason);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });

  return responseWithBody(response, wrappedBody);
}

function wrapResponseBodyWithIdleTimeout(
  response: Response,
  fetchController: AbortController,
  bodyIdleTimeoutMs: number,
  cleanup: () => void,
): Response {
  const body = response.body;
  if (!body) {
    cleanup();
    return response;
  }

  const reader = body.getReader();
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const clearIdleTimeout = () => {
    if (idleTimeout !== undefined) {
      clearTimeout(idleTimeout);
      idleTimeout = undefined;
    }
  };

  const finish = () => {
    if (finished) return false;
    finished = true;
    clearIdleTimeout();
    cleanup();
    return true;
  };

  const failBody = (error: Error) => {
    if (!finish()) return;
    try {
      streamController?.error(error);
    } catch {
      /* stream already closed */
    }
    reader.cancel(error).catch(() => {});
    fetchController.abort(error);
  };

  const startIdleTimeout = () => {
    clearIdleTimeout();
    idleTimeout = setTimeout(() => {
      failBody(
        new DOMException(
          `Response body idle timeout after ${bodyIdleTimeoutMs}ms`,
          'TimeoutError',
        ),
      );
    }, bodyIdleTimeoutMs);
    idleTimeout.unref?.();
  };

  const wrappedBody = new ReadableStream<Uint8Array>({
    start(readableController) {
      streamController = readableController;
    },
    async pull(readableController) {
      try {
        startIdleTimeout();
        const result = await reader.read();
        if (finished) return;
        clearIdleTimeout();
        if (result.done) {
          finish();
          readableController.close();
          return;
        }
        readableController.enqueue(result.value);
      } catch (error) {
        if (finish()) {
          readableController.error(error);
        }
      }
    },
    cancel(reason) {
      finish();
      // Close the reader before abort can error the native fetch body. Abort
      // immediately after starting cancellation, even if it is still pending.
      const cancellation = reader.cancel(reason);
      fetchController.abort(reason);
      return cancellation;
    },
  });

  return responseWithBody(response, wrappedBody);
}

/**
 * SOCKS5 sends the username and password as one unit, so half a credential is
 * a configuration mistake rather than an anonymous connection. Reject it here
 * so the proxy is never swapped for one that cannot authenticate.
 */
function assertCompleteSocks5Credentials(normalizedProxy: string): void {
  const parsed = new URL(normalizedProxy);
  if (isNativeBunProxyProtocol(parsed.protocol)) return;
  if (parsed.username.length === 0 === (parsed.password.length === 0)) return;
  throw new TypeError(
    'SOCKS5 proxy credentials must include both a non-empty username and password',
  );
}

/**
 * Routing through undici's SOCKS5 support costs three things a caller would
 * otherwise expect, none of which we can express through `ProxyAgent`:
 *
 * - `connectTimeoutMs` never reaches the proxy hop (see
 *   `proxyHopConnectorOptions`); undici's fixed 10s connect and 5s
 *   greeting/CONNECT bounds apply instead.
 * - The TLS handshake to an https target *through* the tunnel has no timeout
 *   at all — undici awaits `secureConnect`/`error` on a bare `tls.connect`.
 * - A request that times out or is aborted does not take its proxy socket
 *   with it. The transport this replaced destroyed pending SOCKS sockets
 *   explicitly; nothing does now, so those sockets are held until the process
 *   exits or the proxy is reset.
 *
 * Log the configuration once so those show up as a known SOCKS caveat in the
 * run log instead of an unexplained stall. Both runtimes are affected.
 */
function warnOnSocksProxyCaveats(normalizedProxy: string): void {
  if (isHttpProxyProtocol(new URL(normalizedProxy).protocol)) return;
  runLogger.warn(
    `[fetch] SOCKS proxy configured: ${redactProxyUrl(normalizedProxy)}. ` +
      'Connect timeouts are fixed by undici (10s connect, 5s handshake), the ' +
      'TLS handshake to an https target is unbounded, and sockets from ' +
      'timed-out or aborted requests are not reclaimed.',
  );
}

export function setGlobalProxy(proxy: string) {
  const normalizedProxy = normalizeProxyUrl(proxy);
  assertCompleteSocks5Credentials(normalizedProxy);
  warnOnSocksProxyCaveats(normalizedProxy);
  // In Bun, proxy is handled per-request in proxiedFetch(), which is also
  // installed as global fetch so direct fetch() calls respect the proxy.
  // HTTP(S) proxies use Bun's native proxy support; SOCKS proxies go through
  // undici's ProxyAgent, the same path the Node build uses.
  if (isBunRuntime()) {
    closeCustomTimeoutAgents();
    currentProxy = normalizedProxy;
    installGlobalFetchProxy();
    return;
  }

  // Construct before replacing the current state so a failed hot update keeps
  // the last known-good proxy instead of silently opening a direct path.
  const proxyAgent = createProxyAgent(
    normalizedProxy,
    defaultTimeout,
    defaultTimeout,
  );
  closeCustomTimeoutAgents();
  if (currentProxyAgent) {
    closeAgent(currentProxyAgent);
  }
  currentProxy = normalizedProxy;
  currentProxyAgent = proxyAgent;
  runLogger.log(
    `[fetch] Global ProxyAgent created: proxy=${redactProxyUrl(normalizedProxy)}, timeout=${defaultTimeout}ms`,
  );
  installGlobalFetchProxy();
}

/**
 * Clear the globally configured proxy, reverting to direct connections.
 * This is the production counterpart of _resetProxyForTesting — allows
 * runtime mode transitions (e.g. proxy → direct/httpdns) without restarting.
 */
export function clearGlobalProxy(): void {
  closeCustomTimeoutAgents();
  if (currentProxyAgent) {
    closeAgent(currentProxyAgent);
    currentProxyAgent = undefined;
  }
  uninstallGlobalFetchProxy();
  currentProxy = undefined;
  installDirectGlobalDispatcher();
}
