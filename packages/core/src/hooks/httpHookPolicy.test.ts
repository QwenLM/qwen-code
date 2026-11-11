/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isHttpHookUrlAllowed,
  urlMatchesHttpHookPattern,
} from './httpHookPolicy.js';

describe('HTTP hook URL policy', () => {
  it('treats undefined as unrestricted and an empty list as deny-all', () => {
    expect(isHttpHookUrlAllowed('https://hooks.example.com/a', undefined)).toBe(
      true,
    );
    expect(isHttpHookUrlAllowed('https://hooks.example.com/a', [])).toBe(false);
  });

  it('matches wildcard hosts, ports, and paths', () => {
    expect(
      urlMatchesHttpHookPattern(
        'https://audit.corp.example:8443/hooks/tool-use',
        'https://*.corp.example:*/hooks/*',
      ),
    ).toBe(true);
  });

  it('matches a wildcard scheme and query value while keeping other query text literal', () => {
    const pattern = '*://hooks.example.com/events?project=*&kind=tool';
    expect(
      urlMatchesHttpHookPattern(
        'http://hooks.example.com/events?project=demo&kind=tool',
        pattern,
      ),
    ).toBe(true);
    expect(
      urlMatchesHttpHookPattern(
        'https://hooks.example.com/events?project=demo&kind=other',
        pattern,
      ),
    ).toBe(false);
  });

  it('matches a hostname containing the former marker literally', () => {
    const pattern = 'https://qoderhttpwildcardplaceholder.example.com/events/*';
    expect(
      urlMatchesHttpHookPattern(
        'https://qoderhttpwildcardplaceholder.example.com/events/tool',
        pattern,
      ),
    ).toBe(true);
    expect(
      urlMatchesHttpHookPattern(
        'https://other.example.com/events/tool',
        pattern,
      ),
    ).toBe(false);
  });

  it('does not let a hostname wildcard implicitly match every port', () => {
    expect(
      urlMatchesHttpHookPattern(
        'https://audit.corp.example:8443/hooks/tool-use',
        'https://*.corp.example/hooks/*',
      ),
    ).toBe(false);
  });

  it('matches hostnames case-insensitively and ignores a trailing FQDN dot', () => {
    expect(
      urlMatchesHttpHookPattern(
        'https://AUDIT.CORP.EXAMPLE./hooks',
        'https://audit.corp.example/hooks',
      ),
    ).toBe(true);
  });

  it('treats an origin-only pattern as allowing all paths on that origin', () => {
    expect(
      urlMatchesHttpHookPattern(
        'https://hooks.example.com/hooks/pre-tool',
        'https://hooks.example.com',
      ),
    ).toBe(true);
  });

  it('does not match a different protocol, host, or path', () => {
    expect(
      urlMatchesHttpHookPattern(
        'http://hooks.example.com/private',
        'https://hooks.example.com/hooks/*',
      ),
    ).toBe(false);
    expect(
      urlMatchesHttpHookPattern(
        'https://evil.example.com/hooks/a',
        'https://hooks.example.com/hooks/*',
      ),
    ).toBe(false);
    expect(
      urlMatchesHttpHookPattern(
        'https://hooks.example.com/private',
        'https://hooks.example.com/hooks/*',
      ),
    ).toBe(false);
  });
});
