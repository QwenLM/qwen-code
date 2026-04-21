/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isIPv4, isIPv6 } from 'net';
import { isBlockedAddress } from './ssrfGuard.js';
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

  /**
   * Create a new URL validator
   * @param allowedPatterns - Array of allowed URL patterns (supports * wildcard)
   */
  constructor(allowedPatterns: string[] = []) {
    this.allowedPatterns = allowedPatterns;
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

      // Check if hostname is an IP address - use ssrfGuard for authoritative check
      if (this.isIpAddress(hostname)) {
        // Remove brackets from IPv6 addresses for isBlockedAddress
        const cleanHostname = hostname.replace(/^\[|\]$/g, '');
        if (isBlockedAddress(cleanHostname)) {
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
export function createUrlValidator(allowedUrls?: string[]): UrlValidator {
  return new UrlValidator(allowedUrls || []);
}
