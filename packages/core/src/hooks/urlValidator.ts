/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('URL_VALIDATOR');

/**
 * Private IP address ranges that should be blocked for SSRF protection
 */
const PRIVATE_IP_RANGES = [
  { start: '10.0.0.0', end: '10.255.255.255' },
  { start: '172.16.0.0', end: '172.31.255.255' },
  { start: '192.168.0.0', end: '192.168.255.255' },
  { start: '127.0.0.0', end: '127.255.255.255' },
  { start: '169.254.0.0', end: '169.254.255.255' },
  { start: '0.0.0.0', end: '0.255.255.255' },
];

/**
 * Hostnames that should be blocked for SSRF protection
 */
const BLOCKED_HOSTS = [
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal', // GCP metadata
  '169.254.169.254', // Cloud metadata (AWS, GCP, Azure)
  'metadata.azure.internal', // Azure metadata
];

/**
 * URL validator for HTTP hooks with whitelist and SSRF protection
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
   * Compile a URL pattern with wildcards into a RegExp
   */
  private compilePattern(pattern: string): RegExp {
    // Escape special regex characters except *
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
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
   * Check if a URL should be blocked for security reasons (SSRF protection)
   * @param url - The URL to check
   * @returns True if the URL should be blocked
   */
  isBlocked(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      // Check blocked hostnames
      if (BLOCKED_HOSTS.includes(hostname)) {
        debugLogger.debug(`URL blocked: hostname ${hostname} is in blocklist`);
        return true;
      }

      // Check if hostname is an IP address
      if (this.isIpAddress(hostname)) {
        if (this.isPrivateIp(hostname)) {
          debugLogger.debug(`URL blocked: IP ${hostname} is in private range`);
          return true;
        }
      }

      // Check for IPv6 localhost
      if (hostname === '::1' || hostname === '[::1]') {
        debugLogger.debug(`URL blocked: IPv6 localhost`);
        return true;
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
   * Check if a string is an IP address
   */
  private isIpAddress(hostname: string): boolean {
    // IPv4 pattern
    const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    // IPv6 pattern (simplified)
    const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

    return ipv4Pattern.test(hostname) || ipv6Pattern.test(hostname);
  }

  /**
   * Check if an IP address is in a private range
   */
  private isPrivateIp(ip: string): boolean {
    const ipNum = this.ipToNumber(ip);
    if (ipNum === null) {
      return false;
    }

    for (const range of PRIVATE_IP_RANGES) {
      const startNum = this.ipToNumber(range.start);
      const endNum = this.ipToNumber(range.end);
      if (startNum !== null && endNum !== null) {
        if (ipNum >= startNum && ipNum <= endNum) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Convert an IPv4 address to a number for range comparison
   */
  private ipToNumber(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      return null;
    }

    let result = 0;
    for (const part of parts) {
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 0 || num > 255) {
        return null;
      }
      result = result * 256 + num;
    }

    return result;
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
