/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SESSION_ID_HEADER_HOSTS,
  extractRequestHost,
  matchesTrustedHost,
} from './trusted-llm-hosts.js';

describe('matchesTrustedHost', () => {
  it('returns false for empty hostname (defensive)', () => {
    expect(matchesTrustedHost('', ['dashscope.aliyuncs.com'])).toBe(false);
  });

  it('exact match (case-insensitive)', () => {
    expect(
      matchesTrustedHost('dashscope.aliyuncs.com', ['dashscope.aliyuncs.com']),
    ).toBe(true);
    expect(
      matchesTrustedHost('DashScope.Aliyuncs.COM', ['dashscope.aliyuncs.com']),
    ).toBe(true);
  });

  it('exact pattern rejects sub-domain (no implicit wildcard)', () => {
    expect(
      matchesTrustedHost('sub.dashscope.aliyuncs.com', [
        'dashscope.aliyuncs.com',
      ]),
    ).toBe(false);
  });

  it('*.suffix matches the bare suffix domain', () => {
    expect(matchesTrustedHost('alibaba-inc.com', ['*.alibaba-inc.com'])).toBe(
      true,
    );
  });

  it('*.suffix matches sub-domains', () => {
    expect(
      matchesTrustedHost('idealab.alibaba-inc.com', ['*.alibaba-inc.com']),
    ).toBe(true);
    expect(
      matchesTrustedHost('a.b.alibaba-inc.com', ['*.alibaba-inc.com']),
    ).toBe(true);
  });

  it('*.suffix rejects unrelated hosts that contain the suffix mid-name', () => {
    // `evil-alibaba-inc.com` ends with `alibaba-inc.com` as a substring but
    // is not a true sub-domain — the dot-anchored check should reject it.
    expect(
      matchesTrustedHost('evil-alibaba-inc.com', ['*.alibaba-inc.com']),
    ).toBe(false);
    // Trailing-suffix attack: a host whose name HAPPENS to end in the suffix
    // text but on a different TLD.
    expect(
      matchesTrustedHost('alibaba-inc.com.evil.net', ['*.alibaba-inc.com']),
    ).toBe(false);
  });

  it('mixed pattern list (exact + wildcard)', () => {
    const patterns = [
      'dashscope.aliyuncs.com',
      '*.dashscope.aliyuncs.com',
      '*.alibaba-inc.com',
    ];
    expect(matchesTrustedHost('dashscope.aliyuncs.com', patterns)).toBe(true);
    expect(matchesTrustedHost('sub.dashscope.aliyuncs.com', patterns)).toBe(
      true,
    );
    expect(matchesTrustedHost('idealab.alibaba-inc.com', patterns)).toBe(true);
    expect(matchesTrustedHost('api.openai.com', patterns)).toBe(false);
  });

  it('empty pattern list rejects everything', () => {
    expect(matchesTrustedHost('dashscope.aliyuncs.com', [])).toBe(false);
  });
});

describe('extractRequestHost', () => {
  it('extracts from string URL', () => {
    expect(extractRequestHost('https://dashscope.aliyuncs.com/v1/x')).toBe(
      'dashscope.aliyuncs.com',
    );
  });

  it('extracts from URL object', () => {
    expect(extractRequestHost(new URL('https://api.openai.com/v1'))).toBe(
      'api.openai.com',
    );
  });

  it('extracts from Request', () => {
    expect(
      extractRequestHost(new Request('https://api.anthropic.com/v1/messages')),
    ).toBe('api.anthropic.com');
  });

  it('returns undefined for unparseable string', () => {
    expect(extractRequestHost('not a url')).toBeUndefined();
  });
});

describe('DEFAULT_SESSION_ID_HEADER_HOSTS', () => {
  it('matches DashScope global + intl endpoints', () => {
    expect(
      matchesTrustedHost(
        'dashscope.aliyuncs.com',
        DEFAULT_SESSION_ID_HEADER_HOSTS,
      ),
    ).toBe(true);
    expect(
      matchesTrustedHost(
        'dashscope-intl.aliyuncs.com',
        DEFAULT_SESSION_ID_HEADER_HOSTS,
      ),
    ).toBe(true);
  });

  it('matches internal *.alibaba-inc.com / *.aliyun-inc.com', () => {
    expect(
      matchesTrustedHost(
        'idealab.alibaba-inc.com',
        DEFAULT_SESSION_ID_HEADER_HOSTS,
      ),
    ).toBe(true);
    expect(
      matchesTrustedHost('gw.aliyun-inc.com', DEFAULT_SESSION_ID_HEADER_HOSTS),
    ).toBe(true);
  });

  it('does NOT match third-party LLM providers', () => {
    expect(
      matchesTrustedHost('api.openai.com', DEFAULT_SESSION_ID_HEADER_HOSTS),
    ).toBe(false);
    expect(
      matchesTrustedHost('api.anthropic.com', DEFAULT_SESSION_ID_HEADER_HOSTS),
    ).toBe(false);
    expect(
      matchesTrustedHost('openrouter.ai', DEFAULT_SESSION_ID_HEADER_HOSTS),
    ).toBe(false);
    expect(
      matchesTrustedHost(
        'generativelanguage.googleapis.com',
        DEFAULT_SESSION_ID_HEADER_HOSTS,
      ),
    ).toBe(false);
  });
});
