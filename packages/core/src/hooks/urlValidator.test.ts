/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  UrlValidator,
  createUrlValidator,
  hookUrlPatternCovers,
} from './urlValidator.js';

describe('UrlValidator', () => {
  describe('isBlocked', () => {
    it('should ALLOW 127.0.0.1 for local dev hooks', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('http://127.0.0.1:8080/api')).toBe(false);
      expect(validator.isBlocked('http://127.0.0.1/api')).toBe(false);
      expect(validator.isBlocked('http://127.0.0.1:9876/hook')).toBe(false);
    });

    it('should ALLOW localhost for local dev hooks', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('http://localhost:8080/api')).toBe(false);
      expect(validator.isBlocked('http://localhost:9876/hook')).toBe(false);
    });

    it('should block private IP 192.168.x.x', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('http://192.168.1.1/api')).toBe(true);
      expect(validator.isBlocked('http://192.168.0.100:8080/api')).toBe(true);
    });

    it('should block private IP 10.x.x.x', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('http://10.0.0.1/api')).toBe(true);
      expect(validator.isBlocked('http://10.255.255.255/api')).toBe(true);
    });

    it('should block private IP 172.16.x.x - 172.31.x.x', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('http://172.16.0.1/api')).toBe(true);
      expect(validator.isBlocked('http://172.31.255.255/api')).toBe(true);
    });

    it('should block cloud metadata endpoints', () => {
      const validator = new UrlValidator([]);
      expect(
        validator.isBlocked('http://169.254.169.254/latest/meta-data'),
      ).toBe(true);
      expect(
        validator.isBlocked('http://metadata.google.internal/computeMetadata'),
      ).toBe(true);
    });

    it('should allow public URLs', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('https://api.example.com/hook')).toBe(false);
      expect(validator.isBlocked('https://hooks.example.com/test')).toBe(false);
    });

    it('should block invalid URLs', () => {
      const validator = new UrlValidator([]);
      expect(validator.isBlocked('not-a-url')).toBe(true);
      expect(validator.isBlocked('')).toBe(true);
    });

    describe('with allowPrivateNetworkHosts', () => {
      it('should allow private IP ranges', () => {
        const validator = new UrlValidator([], true);
        expect(validator.isBlocked('http://192.168.1.1/api')).toBe(false);
        expect(validator.isBlocked('http://10.0.0.1/api')).toBe(false);
        expect(validator.isBlocked('http://172.16.0.1/api')).toBe(false);
      });

      it('should still block cloud metadata endpoints', () => {
        const validator = new UrlValidator([], true);
        expect(
          validator.isBlocked('http://169.254.169.254/latest/meta-data'),
        ).toBe(true);
        expect(
          validator.isBlocked(
            'http://metadata.google.internal/computeMetadata',
          ),
        ).toBe(true);
      });

      it('should still block the Alibaba Cloud metadata IP (CGNAT range)', () => {
        const validator = new UrlValidator([], true);
        expect(
          validator.isBlocked('http://100.100.100.200/latest/meta-data'),
        ).toBe(true);
      });

      it('should still block IPv4-mapped IPv6 forms of metadata IPs', () => {
        const validator = new UrlValidator([], true);
        // ::ffff:169.254.169.254 (mixed dotted form)
        expect(
          validator.isBlocked(
            'http://[::ffff:169.254.169.254]/latest/meta-data',
          ),
        ).toBe(true);
        // ::ffff:a9fe:a9fe = 169.254.169.254
        expect(
          validator.isBlocked('http://[::ffff:a9fe:a9fe]/latest/meta-data'),
        ).toBe(true);
        // ::ffff:6464:64c8 = 100.100.100.200
        expect(
          validator.isBlocked('http://[::ffff:6464:64c8]/latest/meta-data'),
        ).toBe(true);
      });

      it('should allow IPv4-mapped IPv6 forms of ordinary private IPs', () => {
        const validator = new UrlValidator([], true);
        // ::ffff:ac10:1 = 172.16.0.1 — private, but not a metadata endpoint
        expect(validator.isBlocked('http://[::ffff:ac10:1]/api')).toBe(false);
      });
    });
  });

  describe('isAllowed', () => {
    it('should allow all URLs when no patterns configured', () => {
      const validator = new UrlValidator([]);
      expect(validator.isAllowed('https://any.example.com/api')).toBe(true);
    });

    it('should match exact URL pattern', () => {
      const validator = new UrlValidator(['https://api\\.example\\.com/hook']);
      expect(validator.isAllowed('https://api.example.com/hook')).toBe(true);
      expect(validator.isAllowed('https://api.example.com/other')).toBe(false);
    });

    it('should match wildcard pattern', () => {
      const validator = new UrlValidator(['https://api\\.example\\.com/*']);
      expect(validator.isAllowed('https://api.example.com/hook')).toBe(true);
      expect(validator.isAllowed('https://api.example.com/v1/hook')).toBe(true);
      expect(validator.isAllowed('https://other.example.com/hook')).toBe(false);
    });

    it('should match multiple patterns', () => {
      const validator = new UrlValidator([
        'https://api\\.example\\.com/*',
        'https://hooks\\.example\\.com/*',
      ]);
      expect(validator.isAllowed('https://api.example.com/hook')).toBe(true);
      expect(validator.isAllowed('https://hooks.example.com/test')).toBe(true);
      expect(validator.isAllowed('https://other.com/hook')).toBe(false);
    });

    it('should be case insensitive', () => {
      const validator = new UrlValidator(['https://API\\.Example\\.COM/*']);
      expect(validator.isAllowed('https://api.example.com/hook')).toBe(true);
    });
  });

  describe('validate', () => {
    it('should return allowed for valid public URL matching whitelist', () => {
      const validator = new UrlValidator(['https://api\\.example\\.com/*']);
      const result = validator.validate('https://api.example.com/hook');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should return not allowed for blocked URL (private IP)', () => {
      const validator = new UrlValidator(['*']);
      const result = validator.validate('http://192.168.1.1:8080/api');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('SSRF');
    });

    it('should return allowed for localhost/loopback URLs', () => {
      const validator = new UrlValidator(['*']);
      const result1 = validator.validate('http://localhost:8080/api');
      expect(result1.allowed).toBe(true);
      const result2 = validator.validate('http://127.0.0.1:9876/hook');
      expect(result2.allowed).toBe(true);
    });

    it('should return not allowed for URL not matching whitelist', () => {
      const validator = new UrlValidator(['https://api\\.example\\.com/*']);
      const result = validator.validate('https://other.com/hook');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('does not match');
    });
  });

  describe('createUrlValidator', () => {
    it('should create validator with allowed URLs', () => {
      const validator = createUrlValidator(['https://api\\.example\\.com/*']);
      expect(validator.isAllowed('https://api.example.com/hook')).toBe(true);
    });

    it('should create validator with empty array', () => {
      const validator = createUrlValidator([]);
      expect(validator.isAllowed('https://any.com/hook')).toBe(true);
    });

    it('should create validator with undefined', () => {
      const validator = createUrlValidator(undefined);
      expect(validator.isAllowed('https://any.com/hook')).toBe(true);
    });
  });
});

describe('hookUrlPatternCovers', () => {
  it('treats identical patterns as covering', () => {
    expect(
      hookUrlPatternCovers('https://corp.com/*', 'https://corp.com/*'),
    ).toBe(true);
  });

  it('lets a wildcard-suffix entry narrow its parent pattern', () => {
    expect(
      hookUrlPatternCovers('https://corp.com/*', 'https://corp.com/hooks/*'),
    ).toBe(true);
  });

  it('lets an exact URL narrow a wildcard pattern', () => {
    expect(
      hookUrlPatternCovers('https://corp.com/*', 'https://corp.com/ci'),
    ).toBe(true);
  });

  it('rejects entries outside the higher-scope pattern', () => {
    expect(
      hookUrlPatternCovers('https://corp.com/*', 'https://evil.com/*'),
    ).toBe(false);
  });

  it('rejects a lookalike host that extends a literal chunk', () => {
    expect(
      hookUrlPatternCovers('https://corp.com/*', 'https://corp.com.evil.com/*'),
    ).toBe(false);
  });

  it('rejects the catch-all "*" against a bounded pattern', () => {
    expect(hookUrlPatternCovers('https://corp.com/*', '*')).toBe(false);
  });

  it('lets the catch-all "*" cover any entry', () => {
    expect(hookUrlPatternCovers('*', 'https://corp.com/hooks/*')).toBe(true);
  });

  it('matches case-insensitively like the URL validator', () => {
    expect(
      hookUrlPatternCovers('https://CORP.com/*', 'https://corp.com/hooks/*'),
    ).toBe(true);
  });

  it('fails closed on non-ASCII patterns whose case folding diverges at runtime', () => {
    // toLowerCase() folds ẞ (U+1E9E) to ß (U+00DF), equating these
    // hosts, but the runtime's non-Unicode /i regex never matches the two
    // across — a "covers" verdict would let the inner entry survive the
    // merge while its runtime regex admits a host the outer pattern
    // rejects. Hook URLs are realistically ASCII, so anything else is
    // unprovable and dropped.
    expect(
      hookUrlPatternCovers(
        'https://fuß.example.com/*',
        'https://fuẞ.example.com/*',
      ),
    ).toBe(false);
    // Identical non-ASCII patterns fail closed too — the runtime matching
    // relation is unprovable for them regardless of spelling.
    expect(
      hookUrlPatternCovers(
        'https://bücher.example.com/*',
        'https://bücher.example.com/*',
      ),
    ).toBe(false);
    // Why this must fail closed: the runtime regex compiled from the
    // outer pattern rejects the host that toLowerCase() calls equal.
    const runtime = new UrlValidator(['https://fuß.example.com/*']);
    expect(runtime.isAllowed('https://fuẞ.example.com/hook')).toBe(false);
  });

  it('treats pre-escaped and unescaped spellings as equivalent', () => {
    expect(
      hookUrlPatternCovers(
        'https://api\\.example\\.com/*',
        'https://api.example.com/hooks/*',
      ),
    ).toBe(true);
    expect(
      hookUrlPatternCovers(
        'https://api.example.com/*',
        'https://api\\.example\\.com/hooks/*',
      ),
    ).toBe(true);
  });

  it('rejects entries that add a wildcard outside the higher-scope literals', () => {
    expect(
      hookUrlPatternCovers('https://corp.com/*', 'https://*/corp.com/*'),
    ).toBe(false);
  });

  it('does not let escapes other than \\. widen coverage (fails closed)', () => {
    // `\*` is not the documented `\.` escape; normalizing it into a
    // catch-all would widen the higher-scope policy.
    expect(hookUrlPatternCovers('\\*', 'https://corp.com/*')).toBe(false);
  });

  it('fails closed on alternation inside a pre-escaped entry', () => {
    // The literal reading covers, but the runtime compiles a pre-escaped
    // pattern's non-* text as raw regex: the ungrouped alternation would
    // match hosts outside the higher-scope pattern.
    expect(
      hookUrlPatternCovers('https://corp\\.com/*', 'https://corp\\.com/x|y/*'),
    ).toBe(false);
  });

  it('fails closed when a pattern carries regex classes beyond \\.', () => {
    // `\d` reads literally here, but the runtime treats it as the digit
    // class, so the literal comparison cannot prove coverage.
    expect(
      hookUrlPatternCovers(
        'https://hooks\\.corp\\.com/status/\\d+/*',
        'https://hooks.corp.com/status/1/exfil',
      ),
    ).toBe(false);
    expect(
      hookUrlPatternCovers('https://corp.com/*', 'https://corp.com/a+b'),
    ).toBe(false);
  });

  it('fails closed when a pre-escaped entry keeps a bare dot', () => {
    // `compilePattern` takes the pre-escaped branch once a pattern carries
    // `\.`, reading every non-* character as raw regex: a surviving bare
    // dot is a wildcard there, so the literal comparison cannot prove
    // coverage — the runtime regex matches lookalike hosts the outer
    // pattern excludes.
    expect(
      hookUrlPatternCovers(
        'https://hooks.corp.com/*',
        'https://hooks\\.corp.com/*',
      ),
    ).toBe(false);
    expect(
      hookUrlPatternCovers(
        'https://hooks.example.co.uk/*',
        'https://hooks\\.example.co.uk/*',
      ),
    ).toBe(false);
    // Why this must fail closed: the pre-escaped runtime regex treats the
    // bare dots as wildcards and matches a different public host.
    const runtime = new UrlValidator(['https://hooks\\.example.co.uk/*']);
    expect(runtime.isAllowed('https://hooks.example.co/uk/exfil')).toBe(true);
  });

  it('stays linear on long near-miss entries instead of backtracking', () => {
    const start = Date.now();
    // The input passes the startsWith/endsWith anchors, so the chunk-scan
    // loop itself must walk the ~200 KB body before rejecting it: a
    // quadratic rescan or regex-based containment would blow the bound.
    expect(
      hookUrlPatternCovers(
        'https://hooks.corp.com/*/*/*/done',
        `https://hooks.corp.com/${'a'.repeat(200_000)}/done`,
      ),
    ).toBe(false);
    // The regex this replaced measured seconds at ~1000 separators and
    // scaled ~cubically; a linear scan finishes in milliseconds even on
    // 200 KB entries. The generous bound only guards against regressions.
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
