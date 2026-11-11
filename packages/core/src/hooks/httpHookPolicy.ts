/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match an HTTP hook URL against a settings pattern. `*` is the only wildcard.
 * URL components are compared independently so hostname matching follows DNS
 * semantics (case-insensitive and ignoring a trailing FQDN dot).
 */
export function urlMatchesHttpHookPattern(
  url: string,
  pattern: string,
): boolean {
  if (pattern === '*') return true;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }

  // A per-match marker keeps literal URL text from being restored as a wildcard.
  const wildcardPlaceholder = `httpwildcard${randomUUID().replaceAll('-', '')}`;
  const placeholderPattern = pattern.replaceAll('*', wildcardPlaceholder);
  let wildcardPort = false;
  let parsedPattern: URL | undefined;

  try {
    parsedPattern = new URL(placeholderPattern);
  } catch {
    const withPlaceholderPort = placeholderPattern.replace(
      new RegExp(`:${wildcardPlaceholder}(?=[/?#]|$)`),
      ':0',
    );
    if (withPlaceholderPort !== placeholderPattern) {
      try {
        parsedPattern = new URL(withPlaceholderPort);
        wildcardPort = true;
      } catch {
        // Fall through to the conservative string matcher below.
      }
    }
  }

  if (!parsedPattern) {
    const targetWithoutHash = `${target.protocol}//${target.host}${target.pathname}${target.search}`;
    const escaped = escapeRegExp(pattern).replaceAll('*', '[^/]*');
    return new RegExp(`^${escaped}$`).test(targetWithoutHash);
  }

  const patternProtocol = parsedPattern.protocol.replaceAll(
    wildcardPlaceholder,
    '*',
  );
  if (patternProtocol !== '*:' && patternProtocol !== target.protocol) {
    return false;
  }

  const targetHostname = target.hostname.replace(/\.$/, '').toLowerCase();
  const patternHostname = parsedPattern.hostname
    .replace(/\.$/, '')
    .toLowerCase()
    .replaceAll(wildcardPlaceholder, '*');
  const hostnameRegex = escapeRegExp(patternHostname).replaceAll('*', '[^/]*');
  if (!new RegExp(`^${hostnameRegex}$`).test(targetHostname)) {
    return false;
  }

  if (!wildcardPort && parsedPattern.port !== target.port) {
    return false;
  }

  // An origin-only pattern applies to every path on that origin.
  if (
    (parsedPattern.pathname === '/' || parsedPattern.pathname === '') &&
    parsedPattern.search === '' &&
    !placeholderPattern.endsWith('/')
  ) {
    return true;
  }

  const patternPathAndQuery = (
    parsedPattern.pathname + parsedPattern.search
  ).replaceAll(wildcardPlaceholder, '*');
  const pathRegex = escapeRegExp(patternPathAndQuery).replaceAll('*', '.*');
  return new RegExp(`^${pathRegex}$`).test(target.pathname + target.search);
}

/** Undefined means no restriction; an empty list blocks every HTTP hook. */
export function isHttpHookUrlAllowed(
  url: string,
  allowedPatterns: readonly string[] | undefined,
): boolean {
  return (
    allowedPatterns === undefined ||
    allowedPatterns.some((pattern) => urlMatchesHttpHookPattern(url, pattern))
  );
}
