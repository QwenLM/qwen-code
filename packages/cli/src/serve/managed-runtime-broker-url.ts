/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isLoopbackBind } from './loopback-binds.js';

// The Harness and the control-plane preflight both require a canonical
// http(s)://host[:port][/] spelling: no userinfo, query or fragment, no
// dot-segment or extra-slash path, no inet_aton shorthand/octal/hex IPv4,
// and no empty or out-of-range port. WHATWG URL parsing still normalizes
// the host (IPv6 serialization, IDNA) once the spelling is canonical.
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const CANONICAL =
  /^(https?):\/\/(\[[^\]/?#@\s]+\]|[^:/?#@[\]\s]+)(?::(\d+))?(\/.*)?$/i;
const DECIMAL_OCTET = /^(?:0|[1-9]\d{0,2})$/;
const INVALID = 'Managed Runtime Broker URL is invalid.';
const NOT_ORIGIN = 'Managed Runtime Broker URL must be an HTTP(S) origin.';

function parseOrNull(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function canonicalHost(rawHost: string, parsedHostname: string): boolean {
  if (rawHost.startsWith('[')) {
    const inner = rawHost.slice(1, -1).toLowerCase();
    return /^[0-9a-f:.]+$/.test(inner) && inner.includes(':');
  }
  const lower = rawHost.toLowerCase();
  if (lower.endsWith('.')) {
    return false;
  }
  const labels = lower.split('.');
  if (labels.some((label) => label.length === 0)) {
    return false;
  }
  const last = labels[labels.length - 1] ?? '';
  // A numeric or hex final label means an IPv4 address: require the full
  // four-octet decimal form without leading zeros.
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/i.test(last)) {
    return (
      labels.length === 4 &&
      labels.every(
        (octet) => DECIMAL_OCTET.test(octet) && Number(octet) <= 255,
      ) &&
      lower === parsedHostname
    );
  }
  // An xn-- label is left to the URL parser's IDNA, which may keep or refuse
  // it; a kept punycode label still has to match the raw spelling, so a
  // U-label elsewhere in the same host is not smuggled through.
  return lower === parsedHostname;
}

export function resolveManagedRuntimeBrokerBaseUrl(
  raw: string,
  requireTls?: boolean,
): URL {
  const scheme = SCHEME.exec(raw);
  if (!scheme) {
    throw new Error(INVALID);
  }
  const protocol = (scheme[1] ?? '').toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') {
    if (parseOrNull(raw) === null) {
      throw new Error(INVALID);
    }
    throw new Error(NOT_ORIGIN);
  }
  const match = CANONICAL.exec(raw);
  if (!match) {
    throw new Error(INVALID);
  }
  const rawHost = match[2] ?? '';
  const portDigits = match[3];
  const rawPath = match[4];
  if (portDigits !== undefined) {
    const port = Number(portDigits);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(INVALID);
    }
  }
  // Parse first: a host the running parser's IDNA refuses is invalid, not a
  // path problem, and the verdict must not depend on path-before-parse order.
  const url = parseOrNull(raw);
  if (url === null) {
    throw new Error(INVALID);
  }
  if (!canonicalHost(rawHost, url.hostname)) {
    throw new Error(INVALID);
  }
  if (rawPath !== undefined && rawPath !== '/') {
    throw new Error(NOT_ORIGIN);
  }
  if (
    requireTls !== false &&
    url.protocol === 'http:' &&
    !isLoopbackBind(url.hostname)
  ) {
    throw new Error(
      'Managed Runtime Broker URL must use HTTPS outside the loopback interface.',
    );
  }
  url.pathname = '/';
  return url;
}
