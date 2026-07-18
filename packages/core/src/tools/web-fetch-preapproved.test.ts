/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isPreapprovedHost,
  isPreapprovedUrl,
} from './web-fetch-preapproved.js';

describe('isPreapprovedHost', () => {
  it('matches hostname-only entries on any path', () => {
    expect(isPreapprovedHost('docs.python.org', '/3/library/json.html')).toBe(
      true,
    );
    expect(isPreapprovedHost('developer.mozilla.org', '/')).toBe(true);
  });

  it('is case-insensitive on hostname', () => {
    expect(isPreapprovedHost('Docs.Python.org', '/x')).toBe(true);
  });

  it('does not match subdomains of listed hosts', () => {
    expect(isPreapprovedHost('evil.docs.python.org', '/')).toBe(false);
  });

  it('treats www and apex as the same site, in both directions', () => {
    // Apex entries whose sites 301 to www (cypress.io, selenium.dev)…
    expect(isPreapprovedHost('www.cypress.io', '/app')).toBe(true);
    expect(isPreapprovedHost('www.selenium.dev', '/documentation')).toBe(true);
    // …and www entries whose apex serves the same site.
    expect(isPreapprovedHost('php.net', '/manual/en/')).toBe(true);
    expect(isPreapprovedHost('www.php.net', '/manual/en/')).toBe(true);
  });

  it('www-equivalence does not loosen matching otherwise', () => {
    expect(isPreapprovedHost('wwwx.cypress.io', '/')).toBe(false);
    expect(isPreapprovedHost('www.evil-cypress.io', '/')).toBe(false);
    expect(isPreapprovedHost('www.example.com', '/')).toBe(false);
  });

  it('does not match unknown hosts', () => {
    expect(isPreapprovedHost('example.com', '/')).toBe(false);
  });

  it('matches path-scoped entries only within the path prefix', () => {
    expect(isPreapprovedHost('github.com', '/QwenLM')).toBe(true);
    expect(isPreapprovedHost('github.com', '/QwenLM/qwen-code')).toBe(true);
    expect(isPreapprovedHost('github.com', '/other-org/repo')).toBe(false);
  });

  it('enforces path segment boundaries', () => {
    expect(isPreapprovedHost('github.com', '/QwenLM-evil/malware')).toBe(false);
  });
});

describe('isPreapprovedUrl', () => {
  it('parses URLs and delegates to host matching', () => {
    expect(isPreapprovedUrl('https://react.dev/learn')).toBe(true);
    expect(isPreapprovedUrl('https://example.com/learn')).toBe(false);
  });

  it('accepts the www canonicalization target of an apex entry', () => {
    // The redirect-scope callback runs on redirect targets: cypress.io
    // 301s to www.cypress.io, which must stay in scope.
    expect(isPreapprovedUrl('https://www.cypress.io/app')).toBe(true);
  });

  it('never preapproves plaintext http', () => {
    expect(isPreapprovedUrl('http://react.dev/learn')).toBe(false);
    expect(isPreapprovedUrl('http://react.dev:8080/learn')).toBe(false);
  });

  it('returns false for unparseable input', () => {
    expect(isPreapprovedUrl('not a url')).toBe(false);
  });
});
