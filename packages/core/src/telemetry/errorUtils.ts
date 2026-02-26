/**
 * Utilities for normalizing error messages and HTTP status codes for telemetry.
 */
export function normalizeStatusCode(
  value?: number | string | null,
): number | string | null {
  if (value === null || typeof value === 'undefined') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  const asNum = parseInt(s, 10);
  if (!Number.isNaN(asNum) && /^\s*-?\d+\s*$/.test(s)) return asNum;
  // Preserve non-numeric status codes (legacy strings) so tests and
  // downstream consumers that expect string codes don't break.
  return s || null;
}

export function normalizeErrorMessage(raw?: string | null): string {
  if (!raw) return '';
  let msg = String(raw).trim();

  // Remove common noisy prefixes
  msg = msg.replace(/^error:\s*/i, '');
  msg = msg.replace(/^request failed:\s*/i, '');
  msg = msg.replace(/^http error:\s*/i, '');

  const low = msg.toLowerCase();

  // Normalize HTTP-status-like messages to a short token
  const statusMatch = low.match(
    /\b(status(?: code)?[:=]?\s*)(\d{3})\b|\b(\d{3})\b/,
  );
  if (statusMatch) {
    const code = statusMatch[2] ?? statusMatch[3];
    if (code) return `http_${code}`;
  }

  // Common network/connectivity error patterns
  if (/(econrefused|connection refused)/i.test(low))
    return 'connection_refused';
  if (/(enotfound|getaddrinfo|dns)/i.test(low)) return 'dns_not_found';
  if (/(etimedout|timeout)/i.test(low)) return 'timeout';
  if (/(econnreset|socket hang up)/i.test(low)) return 'connection_reset';
  if (/(certificate|cert|tls|ssl)/i.test(low)) return 'tls_error';
  if (/(aborted|request aborted)/i.test(low)) return 'request_aborted';

  // Collapse whitespace and truncate to reasonable length for telemetry
  msg = msg.replace(/\s+/g, ' ');
  if (msg.length > 200) msg = msg.substring(0, 200);
  return msg;
}
