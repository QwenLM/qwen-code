/**
 * Network proxy utility functions (pure — no Electron deps).
 *
 * Parses NO_PROXY rules and determines whether a given URL should bypass the proxy.
 */

/** Split a comma-separated string into trimmed, non-empty entries. */
export function splitCommaSeparated(str: string | undefined): string[] {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

export interface NoProxyRule {
  /** Exact hostname or domain suffix (without leading dot). */
  host: string;
  /** Optional port restriction. */
  port?: number;
  /** If true, matches any hostname (wildcard `*`). */
  wildcard: boolean;
}

/**
 * Parse a comma-separated NO_PROXY string into structured rules.
 *
 * Supported formats per entry:
 *   - `*`                 → wildcard, bypass everything
 *   - `example.com`       → exact host match
 *   - `.example.com`      → suffix match (subdomain)
 *   - `example.com:8080`  → host + port
 *   - `192.168.1.1`       → exact IP literal
 */
export function parseNoProxyRules(noProxy: string | undefined): NoProxyRule[] {
  if (!noProxy) return [];

  return splitCommaSeparated(noProxy)
    .map(entry => entry.toLowerCase())
    .map(entry => {
      if (entry === '*') {
        return { host: '*', wildcard: true };
      }

      // Strip leading dot (treated as suffix match — same result as without dot)
      let cleaned = entry.startsWith('.') ? entry.slice(1) : entry;

      // Handle IPv6: strip brackets, optionally extract trailing port ([::1]:8080)
      if (cleaned.startsWith('[')) {
        const closeBracket = cleaned.indexOf(']');
        if (closeBracket > 0) {
          const ipv6Host = cleaned.slice(1, closeBracket);
          const afterBracket = cleaned.slice(closeBracket + 1);
          if (afterBracket.startsWith(':')) {
            const port = parseInt(afterBracket.slice(1), 10);
            if (!isNaN(port)) {
              return { host: ipv6Host, port, wildcard: false };
            }
          }
          return { host: ipv6Host, wildcard: false };
        }
      }

      // Check for port (non-IPv6)
      const lastColon = cleaned.lastIndexOf(':');
      if (lastColon > 0) {
        const host = cleaned.slice(0, lastColon);
        const port = parseInt(cleaned.slice(lastColon + 1), 10);
        if (!isNaN(port)) {
          return { host, port, wildcard: false };
        }
      }

      return { host: cleaned, wildcard: false };
    });
}

/**
 * Determine whether a URL should bypass the proxy based on NO_PROXY rules.
 */
/** Default ports by protocol, used when URL omits an explicit port. */
const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

export function shouldBypassProxy(url: string | URL, rules: NoProxyRule[]): boolean {
  if (rules.length === 0) return false;

  const parsed = typeof url === 'string' ? new URL(url) : url;
  const hostname = parsed.hostname.toLowerCase();
  // Strip brackets from IPv6
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : DEFAULT_PORTS[parsed.protocol];

  for (const rule of rules) {
    if (rule.wildcard) return true;

    // Port-scoped rule: only match when port matches
    if (rule.port !== undefined && rule.port !== port) {
      continue;
    }

    // Exact match
    if (host === rule.host) return true;

    // Suffix match (subdomain): host ends with .rule.host
    if (host.endsWith(`.${rule.host}`)) return true;
  }

  return false;
}
