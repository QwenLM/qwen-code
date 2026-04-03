/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isIPv4, isIPv6 } from 'net';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('URL_VALIDATOR');

/**
 * Private IP address ranges that should be blocked for SSRF protection
 * - 127.0.0.0/8 (loopback) is intentionally ALLOWED for local dev hooks
 * - 100.64.0.0/10 (CGNAT) blocked (some cloud metadata use this, e.g. Alibaba 100.100.100.200)
 */
const PRIVATE_IP_RANGES = [
  { start: '10.0.0.0', end: '10.255.255.255' },
  { start: '100.64.0.0', end: '100.127.255.255' }, // CGNAT (RFC 6598)
  { start: '172.16.0.0', end: '172.31.255.255' },
  { start: '192.168.0.0', end: '192.168.255.255' },
  { start: '169.254.0.0', end: '169.254.255.255' },
  { start: '0.0.0.0', end: '0.255.255.255' },
];

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

      // Allow IPv6 loopback (::1) for local dev (matches Claude Code behavior)
      if (hostname === '::1' || hostname === '[::1]') {
        return false;
      }

      // Check if hostname is an IP address
      if (this.isIpAddress(hostname)) {
        if (this.isPrivateIp(hostname)) {
          debugLogger.debug(`URL blocked: IP ${hostname} is in private range`);
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

  /**
   * Validate that a hostname's resolved IP addresses are not private.
   * This provides protection against DNS rebinding attacks where a domain
   * initially resolves to a public IP but later resolves to a private IP.
   *
   * @param hostname - The hostname to validate
   * @returns Promise that resolves to true if all resolved IPs are safe, false otherwise
   */
  async validateResolvedIp(hostname: string): Promise<boolean> {
    // Skip validation for IP addresses (already checked in isBlocked)
    if (this.isIpAddress(hostname)) {
      return true;
    }

    try {
      const dns = await import('dns');
      const dnsPromises = dns.promises;

      // Check IPv4 addresses
      const ipv4Addresses = await dnsPromises
        .resolve4(hostname)
        .catch(() => []);
      for (const ip of ipv4Addresses) {
        if (this.isPrivateIp(ip)) {
          debugLogger.debug(
            `DNS rebinding protection: ${hostname} resolves to private IPv4 ${ip}`,
          );
          return false;
        }
      }

      // Check IPv6 addresses
      const ipv6Addresses = await dnsPromises
        .resolve6(hostname)
        .catch(() => []);
      for (const ip of ipv6Addresses) {
        // Check for IPv6 private addresses
        const cleanIp = ip.replace(/^\[|\]$/g, '').toLowerCase();
        if (
          cleanIp === '::1' ||
          cleanIp.startsWith('fe8') ||
          cleanIp.startsWith('fe9') ||
          cleanIp.startsWith('fea') ||
          cleanIp.startsWith('feb') ||
          cleanIp.startsWith('fc') ||
          cleanIp.startsWith('fd')
        ) {
          debugLogger.debug(
            `DNS rebinding protection: ${hostname} resolves to private IPv6 ${ip}`,
          );
          return false;
        }
      }

      return true;
    } catch {
      // If DNS resolution fails, allow the request to proceed
      // The actual HTTP request will fail if the hostname is invalid
      debugLogger.debug(
        `DNS resolution failed for ${hostname}, allowing request to proceed`,
      );
      return true;
    }
  }

  /**
   * Validate a URL for use in HTTP hooks with DNS rebinding protection.
   * This is an async version of validate() that also checks resolved IPs.
   *
   * @param url - The URL to validate
   * @returns Promise with validation result including allowed status and reason
   */
  async validateWithDnsCheck(
    url: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    // First perform standard validation
    const basicResult = this.validate(url);
    if (!basicResult.allowed) {
      return basicResult;
    }

    // Then check DNS resolution for rebinding attacks
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;

      const dnsValid = await this.validateResolvedIp(hostname);
      if (!dnsValid) {
        return {
          allowed: false,
          reason: `DNS rebinding protection: ${hostname} resolves to a private IP address`,
        };
      }

      return { allowed: true };
    } catch {
      return {
        allowed: false,
        reason: 'Invalid URL format',
      };
    }
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
