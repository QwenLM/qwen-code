/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isValidAdmissibleOrigin,
  secFetchSiteAllowsRecording,
  resolveOwnUiOrigin,
  evaluateAdmission,
  CorsAllowlist,
  allowlistFromRecords,
  evaluatePreflight,
  corsHeadersForActualRequest,
} from './cors.js';
import type { CorsOriginRecord } from './types.js';

// ---------------------------------------------------------------------------
// isValidAdmissibleOrigin
// ---------------------------------------------------------------------------

describe('isValidAdmissibleOrigin', () => {
  it('accepts https origins with any host', () => {
    expect(isValidAdmissibleOrigin('https://example.com')).toBe(true);
    expect(isValidAdmissibleOrigin('https://qwen.local:4170')).toBe(true);
    expect(isValidAdmissibleOrigin('https://sub.example.com:8443')).toBe(true);
  });

  it('accepts http on loopback hosts', () => {
    expect(isValidAdmissibleOrigin('http://localhost')).toBe(true);
    expect(isValidAdmissibleOrigin('http://localhost:3000')).toBe(true);
    expect(isValidAdmissibleOrigin('http://127.0.0.1')).toBe(true);
    expect(isValidAdmissibleOrigin('http://127.0.0.1:8080')).toBe(true);
    expect(isValidAdmissibleOrigin('http://127.1.2.3')).toBe(true);
    expect(isValidAdmissibleOrigin('http://[::1]')).toBe(true);
    expect(isValidAdmissibleOrigin('http://[::1]:4170')).toBe(true);
  });

  it('rejects http on non-loopback hosts', () => {
    expect(isValidAdmissibleOrigin('http://example.com')).toBe(false);
    expect(isValidAdmissibleOrigin('http://192.168.1.1')).toBe(false);
    expect(isValidAdmissibleOrigin('http://sub.localhost')).toBe(false);
  });

  it('rejects non-http/https schemes', () => {
    expect(isValidAdmissibleOrigin('ftp://example.com')).toBe(false);
    expect(isValidAdmissibleOrigin('ws://example.com')).toBe(false);
    expect(isValidAdmissibleOrigin('file:///foo')).toBe(false);
  });

  it('rejects origins with paths, trailing slashes, or extra components', () => {
    expect(isValidAdmissibleOrigin('https://example.com/')).toBe(false);
    expect(isValidAdmissibleOrigin('https://example.com/path')).toBe(false);
    expect(isValidAdmissibleOrigin('https://user@example.com')).toBe(false);
    expect(isValidAdmissibleOrigin('https://example.com?q=1')).toBe(false);
  });

  it('rejects empty string, null-like, wildcard', () => {
    expect(isValidAdmissibleOrigin('')).toBe(false);
    expect(isValidAdmissibleOrigin('null')).toBe(false);
    expect(isValidAdmissibleOrigin('*')).toBe(false);
  });

  it('rejects non-canonical casing', () => {
    // URL parser lowercases scheme; if input has upper scheme it round-trips to
    // lowercase and origin !== input.
    expect(isValidAdmissibleOrigin('HTTPS://example.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// secFetchSiteAllowsRecording
// ---------------------------------------------------------------------------

describe('secFetchSiteAllowsRecording', () => {
  it('allows recording when header is absent', () => {
    expect(secFetchSiteAllowsRecording(undefined)).toBe(true);
  });

  it('allows recording for same-origin and none', () => {
    expect(secFetchSiteAllowsRecording('same-origin')).toBe(true);
    expect(secFetchSiteAllowsRecording('none')).toBe(true);
  });

  it('blocks recording for same-site and cross-site', () => {
    expect(secFetchSiteAllowsRecording('same-site')).toBe(false);
    expect(secFetchSiteAllowsRecording('cross-site')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveOwnUiOrigin
// ---------------------------------------------------------------------------

describe('resolveOwnUiOrigin', () => {
  it('returns origin of externalUrl when provided', () => {
    expect(
      resolveOwnUiOrigin({
        externalUrl: 'https://proxy.example.com/prefix/',
        listenScheme: 'http',
        listenHost: '127.0.0.1',
        listenPort: 4170,
      }),
    ).toBe('https://proxy.example.com');
  });

  it('builds from listen scheme/host/port when no externalUrl', () => {
    expect(
      resolveOwnUiOrigin({
        listenScheme: 'http',
        listenHost: '127.0.0.1',
        listenPort: 4170,
      }),
    ).toBe('http://127.0.0.1:4170');
  });

  it('brackets IPv6 listen hosts', () => {
    expect(
      resolveOwnUiOrigin({
        listenScheme: 'http',
        listenHost: '::1',
        listenPort: 4170,
      }),
    ).toBe('http://[::1]:4170');
  });
});

// ---------------------------------------------------------------------------
// evaluateAdmission
// ---------------------------------------------------------------------------

describe('evaluateAdmission', () => {
  const ownUiOrigin = 'http://localhost:4170';

  it('admits when all conditions pass (codeAllowOrigin=true)', () => {
    const result = evaluateAdmission({
      origin: 'https://myapp.example.com',
      secFetchSite: undefined,
      codeAllowOrigin: true,
      ownUiOrigin,
    });
    expect(result).toEqual({ admit: true, reason: 'admitted' });
  });

  it('admits the own UI origin even when codeAllowOrigin=false', () => {
    const result = evaluateAdmission({
      origin: ownUiOrigin,
      secFetchSite: 'same-origin',
      codeAllowOrigin: false,
      ownUiOrigin,
    });
    expect(result).toEqual({ admit: true, reason: 'admitted' });
  });

  it('denies when origin is absent', () => {
    expect(
      evaluateAdmission({
        origin: undefined,
        secFetchSite: undefined,
        codeAllowOrigin: true,
        ownUiOrigin,
      }),
    ).toEqual({ admit: false, reason: 'missing_origin' });
  });

  it('denies when origin is invalid', () => {
    expect(
      evaluateAdmission({
        origin: 'http://192.168.1.1',
        secFetchSite: undefined,
        codeAllowOrigin: true,
        ownUiOrigin,
      }),
    ).toEqual({ admit: false, reason: 'invalid_origin' });
  });

  it('denies when codeAllowOrigin=false and origin does not match ownUiOrigin', () => {
    expect(
      evaluateAdmission({
        origin: 'https://other.example.com',
        secFetchSite: undefined,
        codeAllowOrigin: false,
        ownUiOrigin,
      }),
    ).toEqual({ admit: false, reason: 'origin_not_permitted' });
  });

  it('denies when Sec-Fetch-Site is cross-site', () => {
    expect(
      evaluateAdmission({
        origin: 'https://myapp.example.com',
        secFetchSite: 'cross-site',
        codeAllowOrigin: true,
        ownUiOrigin,
      }),
    ).toEqual({ admit: false, reason: 'sec_fetch_site_blocked' });
  });

  it('denies when Sec-Fetch-Site is same-site', () => {
    expect(
      evaluateAdmission({
        origin: 'https://myapp.example.com',
        secFetchSite: 'same-site',
        codeAllowOrigin: true,
        ownUiOrigin,
      }),
    ).toEqual({ admit: false, reason: 'sec_fetch_site_blocked' });
  });
});

// ---------------------------------------------------------------------------
// CorsAllowlist
// ---------------------------------------------------------------------------

describe('CorsAllowlist', () => {
  it('allows an initial origin', () => {
    const al = new CorsAllowlist(['https://example.com']);
    expect(al.isAllowed('https://example.com')).toBe(true);
  });

  it('rejects an unlisted origin', () => {
    const al = new CorsAllowlist(['https://example.com']);
    expect(al.isAllowed('https://other.example.com')).toBe(false);
  });

  it('add() adds to the effective set', () => {
    const al = new CorsAllowlist();
    al.add('https://new.example.com');
    expect(al.isAllowed('https://new.example.com')).toBe(true);
  });

  it('remove() removes from both paired and overrides', () => {
    const al = new CorsAllowlist(['https://example.com']);
    al.remove('https://example.com');
    expect(al.isAllowed('https://example.com')).toBe(false);
  });

  it('setPairedOrigins() refreshes paired set; overrides are preserved', () => {
    const al = new CorsAllowlist(['https://old.example.com']);
    al.add('https://override.example.com');
    al.setPairedOrigins(['https://new.example.com']);
    expect(al.isAllowed('https://old.example.com')).toBe(false);
    expect(al.isAllowed('https://new.example.com')).toBe(true);
    expect(al.isAllowed('https://override.example.com')).toBe(true);
  });

  it('origins() returns current effective set', () => {
    const al = new CorsAllowlist(['https://a.com'], ['https://b.com']);
    const set = new Set(al.origins());
    expect(set.has('https://a.com')).toBe(true);
    expect(set.has('https://b.com')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('rejects undefined/null/empty origins', () => {
    const al = new CorsAllowlist(['https://example.com']);
    expect(al.isAllowed(undefined)).toBe(false);
    expect(al.isAllowed(null)).toBe(false);
    expect(al.isAllowed('')).toBe(false);
    expect(al.isAllowed('null')).toBe(false);
    expect(al.isAllowed('*')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// allowlistFromRecords
// ---------------------------------------------------------------------------

describe('allowlistFromRecords', () => {
  it('builds an allowlist from CorsOriginRecord[]', () => {
    const records: CorsOriginRecord[] = [
      {
        origin: 'https://example.com',
        admittedByTokenId: 'tok1',
        admittedAt: '2025-01-01T00:00:00.000Z',
        source: 'db',
      },
      {
        origin: 'https://config.example.com',
        admittedByTokenId: null,
        admittedAt: null,
        source: 'config',
      },
    ];
    const al = allowlistFromRecords(records);
    expect(al.isAllowed('https://example.com')).toBe(true);
    expect(al.isAllowed('https://config.example.com')).toBe(true);
    expect(al.isAllowed('https://unlisted.example.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluatePreflight
// ---------------------------------------------------------------------------

describe('evaluatePreflight', () => {
  const allowlist = new CorsAllowlist(['https://app.example.com']);

  it('allows a preflight from an allowlisted origin', () => {
    const result = evaluatePreflight(
      {
        method: 'OPTIONS',
        origin: 'https://app.example.com',
        requestMethod: 'POST',
        requestHeaders: 'Authorization, Content-Type',
      },
      allowlist,
    );
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.headers['Access-Control-Allow-Origin']).toBe(
        'https://app.example.com',
      );
      expect(result.headers['Access-Control-Allow-Credentials']).toBe('true');
      expect(result.headers['Access-Control-Allow-Methods']).toContain('POST');
      expect(result.headers['Access-Control-Allow-Headers']).toBe(
        'Authorization, Content-Type',
      );
      expect(result.headers['Access-Control-Max-Age']).toBe('600');
      expect(result.headers['Vary']).toBe('Origin');
    }
  });

  it('uses default headers when Access-Control-Request-Headers is absent', () => {
    const result = evaluatePreflight(
      { method: 'OPTIONS', origin: 'https://app.example.com' },
      allowlist,
    );
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.headers['Access-Control-Allow-Headers']).toContain(
        'Authorization',
      );
    }
  });

  it('denies a preflight from an unlisted origin', () => {
    const result = evaluatePreflight(
      { method: 'OPTIONS', origin: 'https://evil.example.com' },
      allowlist,
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denied).toBe(true);
      expect(result.auditSignal).toBe('cors_denied');
      expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
    }
  });

  it('denies a preflight with no origin', () => {
    const result = evaluatePreflight({ method: 'OPTIONS' }, allowlist);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.origin).toBeNull();
    }
  });

  it('never emits wildcard with credentials', () => {
    const result = evaluatePreflight(
      { method: 'OPTIONS', origin: 'https://app.example.com' },
      allowlist,
    );
    if (result.allowed) {
      expect(result.headers['Access-Control-Allow-Origin']).not.toBe('*');
    }
  });
});

// ---------------------------------------------------------------------------
// corsHeadersForActualRequest
// ---------------------------------------------------------------------------

describe('corsHeadersForActualRequest', () => {
  const allowlist = new CorsAllowlist(['https://app.example.com']);

  it('returns ACAO + credentials + Vary for an allowlisted origin', () => {
    const result = corsHeadersForActualRequest(
      'https://app.example.com',
      allowlist,
    );
    expect(result.denied).toBe(false);
    expect(result.headers['Access-Control-Allow-Origin']).toBe(
      'https://app.example.com',
    );
    expect(result.headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(result.headers['Vary']).toBe('Origin');
  });

  it('returns empty headers and denied=true for an unlisted origin', () => {
    const result = corsHeadersForActualRequest(
      'https://evil.example.com',
      allowlist,
    );
    expect(result.denied).toBe(true);
    expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(result.auditSignal).toBe('cors_denied');
  });

  it('denies when origin is null or undefined', () => {
    expect(corsHeadersForActualRequest(null, allowlist).denied).toBe(true);
    expect(corsHeadersForActualRequest(undefined, allowlist).denied).toBe(true);
  });

  it('never emits wildcard with credentials', () => {
    const result = corsHeadersForActualRequest(
      'https://app.example.com',
      allowlist,
    );
    expect(result.headers['Access-Control-Allow-Origin']).not.toBe('*');
  });
});
