/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isIPv4, isIPv6 } from 'net';
import { isBlockedAddress, isMetadataAddress } from './ssrfGuard.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('URL_VALIDATOR');

/**
 * Hostnames that should be blocked for SSRF protection
 * Note: 'localhost' is intentionally ALLOWED for local dev hooks (matches Claude Code behavior)
 */
const BLOCKED_HOSTS = [
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal', // GCP metadata
  '169.254.169.254', // Cloud metadata (AWS, GCP, Azure)
  'metadata.azure.internal', // Azure metadata
];

/**
 * URL validator for HTTP hooks with whitelist and SSRF protection.
 *
 * SSRF protection uses the authoritative ssrfGuard.ts module for IP blocking.
 * This module focuses on URL whitelist validation and hostname blocklist.
 */
export class UrlValidator {
  private readonly allowedPatterns: string[];
  private readonly compiledPatterns: RegExp[];
  private readonly allowPrivateNetworkHosts: boolean;

  /**
   * Create a new URL validator
   * @param allowedPatterns - Array of allowed URL patterns (supports * wildcard)
   * @param allowPrivateNetworkHosts - When true, skip the private/link-local
   *   IP-range check (the metadata endpoint checks — BLOCKED_HOSTS and the
   *   metadata IPs — still apply). Only enable from trusted settings scopes.
   */
  constructor(
    allowedPatterns: string[] = [],
    allowPrivateNetworkHosts: boolean = false,
  ) {
    this.allowedPatterns = allowedPatterns;
    this.allowPrivateNetworkHosts = allowPrivateNetworkHosts;
    this.compiledPatterns = allowedPatterns.map((pattern) =>
      this.compilePattern(pattern),
    );
  }

  /**
   * Compile a URL pattern with wildcards into a RegExp.
   * Supports both pre-escaped patterns (e.g., 'https://api\\.example\\.com/*')
   * and unescaped patterns (e.g., 'https://api.example.com/*').
   */
  private compilePattern(pattern: string): RegExp {
    // Check if pattern is already escaped (contains \. sequence)
    const isPreEscaped = pattern.includes('\\.');

    let escaped: string;
    if (isPreEscaped) {
      // Pattern is already escaped, only convert * to .*
      escaped = pattern.replace(/\*/g, '.*');
    } else {
      // Escape special regex characters except *
      escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
    }
    return new RegExp(`^${escaped}$`, 'i');
  }

  /**
   * Check if a URL is allowed by the whitelist
   * @param url - The URL to check
   * @returns True if the URL matches any allowed pattern
   */
  isAllowed(url: string): boolean {
    // If no patterns configured, allow all (but still check for blocked)
    if (this.allowedPatterns.length === 0) {
      return true;
    }

    return this.compiledPatterns.some((pattern) => pattern.test(url));
  }

  /**
   * Check if a URL should be blocked for security reasons (SSRF protection).
   * Uses ssrfGuard.ts for IP address blocking (authoritative implementation).
   * @param url - The URL to check
   * @returns True if the URL should be blocked
   */
  isBlocked(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      // Check blocked hostnames (metadata endpoints, etc.)
      if (BLOCKED_HOSTS.includes(hostname)) {
        debugLogger.debug(`URL blocked: hostname ${hostname} is in blocklist`);
        return true;
      }

      // Check if hostname is an IP address
      if (this.isIpAddress(hostname)) {
        // Remove brackets from IPv6 addresses for the IP checks
        const cleanHostname = hostname.replace(/^\[|\]$/g, '');

        // Cloud metadata endpoints (169.254.169.254, 100.100.100.200, in
        // any serialized form including IPv4-mapped IPv6) stay blocked in
        // every configuration — this check is never relaxed.
        if (isMetadataAddress(cleanHostname)) {
          debugLogger.debug(
            `URL blocked: IP ${hostname} is a cloud metadata endpoint`,
          );
          return true;
        }

        // General private/link-local range check - use ssrfGuard for the
        // authoritative implementation. Skipped when private-network hooks
        // are explicitly allowed (trusted scopes only).
        if (!this.allowPrivateNetworkHosts && isBlockedAddress(cleanHostname)) {
          debugLogger.debug(`URL blocked: IP ${hostname} is blocked`);
          return true;
        }
      }

      return false;
    } catch {
      // Invalid URL, block it
      debugLogger.debug(`URL blocked: invalid URL format`);
      return true;
    }
  }

  /**
   * Validate a URL for use in HTTP hooks
   * @param url - The URL to validate
   * @returns Validation result with allowed status and reason
   */
  validate(url: string): { allowed: boolean; reason?: string } {
    // First check if blocked for security
    if (this.isBlocked(url)) {
      return {
        allowed: false,
        reason: 'URL is blocked for security reasons (SSRF protection)',
      };
    }

    // Then check whitelist
    if (!this.isAllowed(url)) {
      return {
        allowed: false,
        reason: `URL does not match any allowed pattern. Allowed patterns: ${this.allowedPatterns.join(', ')}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if a string is an IP address (IPv4 or IPv6)
   * Uses Node.js net module for accurate validation of all IP formats
   * including ::1, ::ffff:192.168.1.1, 2001:db8::1, etc.
   */
  private isIpAddress(hostname: string): boolean {
    // Remove brackets from IPv6 addresses (e.g., [::1] -> ::1)
    const cleanHostname = hostname.replace(/^\[|\]$/g, '');
    return isIPv4(cleanHostname) || isIPv6(cleanHostname);
  }
}

/**
 * Create a URL validator from configuration
 * @param allowedUrls - Array of allowed URL patterns from config
 * @returns Configured URL validator
 */
export function createUrlValidator(
  allowedUrls?: string[],
  allowPrivateNetworkHosts?: boolean,
): UrlValidator {
  return new UrlValidator(allowedUrls || [], allowPrivateNetworkHosts);
}

/**
 * Returns true when every URL matched by the `inner` hook URL pattern is
 * also matched by the `outer` pattern (both support `*` wildcards, like
 * `security.allowedHttpHookUrls` entries). Used to intersect a
 * workspace-scope whitelist with the higher-scope one: a workspace entry
 * may only survive the merge when it merely narrows what a higher scope
 * already allows.
 *
 * Both patterns are read as literal text plus `*` wildcards — the language
 * `compilePattern` assigns to a pattern carrying no regex content beyond
 * the `\.` escape, which is normalized first so both spellings of the same
 * pattern cover each other. Any other escape or regex metacharacter makes
 * coverage unprovable (the pre-escaped `compilePattern` branch would read
 * it as raw regex — including a bare `.` that survives the unescaping,
 * which acts as a wildcard), so such patterns fail closed (return false).
 * Non-ASCII patterns fail closed too: the runtime's non-Unicode `/i` case
 * folding diverges from the `toLowerCase()` used here for some of them, so
 * coverage is unprovable (hook URLs are realistically ASCII — punycode and
 * percent-encoded forms are unaffected).
 *
 * The comparison is a linear chunk scan — split `outer` on `*` and require
 * the chunks in `inner` in order, anchored at both ends — never a regex
 * test, because this runs on every startup merge and must stay O(n+m) on
 * arbitrary-length workspace input (no catastrophic backtracking).
 */
export function hookUrlPatternCovers(
  outerPattern: string,
  innerPattern: string,
): boolean {
  const unescape = (pattern: string) => pattern.replace(/\\\./g, '.');
  // The runtime matches with `compilePattern`'s non-Unicode `/i` RegExp,
  // whose case folding is a different equivalence relation from
  // toLowerCase() for some non-ASCII characters (e.g. ẞ U+1E9E lowers
  // to ß U+00DF, so the two hosts fold equal here, but the runtime regex
  // never matches them across). A covers verdict built on toLowerCase()
  // would let such an inner entry survive the merge while its runtime
  // regex admits hosts the outer pattern rejects, so fail closed on any
  // non-ASCII input.
  const nonAscii = /[\u0080-\uFFFF]/;
  if (nonAscii.test(outerPattern) || nonAscii.test(innerPattern)) {
    return false;
  }
  const outer = unescape(outerPattern).toLowerCase();
  const inner = unescape(innerPattern).toLowerCase();
  // `compilePattern` treats everything but `*` as raw regex once a pattern
  // contains `\.`, so any remaining regex-active character could widen the
  // runtime language past the literal reading used here. A bare `.` is
  // regex-active in that branch too, but only after unescaping: the `\.`
  // sequences it came from are literal dots, so strip them before checking.
  const regexActive = /[+?^${}()|[\]\\]/;
  const bareDotAfterUnescape = (pattern: string) =>
    pattern.includes('\\.') && pattern.replace(/\\\./g, '').includes('.');
  if (
    regexActive.test(outer) ||
    regexActive.test(inner) ||
    bareDotAfterUnescape(outerPattern) ||
    bareDotAfterUnescape(innerPattern)
  ) {
    return false;
  }
  const chunks = outer.split('*');
  if (chunks.length === 1) {
    return inner === outer;
  }
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  if (!inner.startsWith(first) || !inner.endsWith(last)) {
    return false;
  }
  let position = first.length;
  const end = inner.length - last.length;
  for (const chunk of chunks.slice(1, -1)) {
    const found = inner.indexOf(chunk, position);
    if (found === -1 || found + chunk.length > end) {
      return false;
    }
    position = found + chunk.length;
  }
  return position <= end;
}
