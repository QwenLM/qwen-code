/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MCPServerConfig } from '../config/config.js';
import {
  canonicalOAuth,
  connectionIdOf,
  fingerprint,
  isPoolable,
  mcpTransportOf,
  parseConnectionId,
  POOLED_TRANSPORTS_DEFAULT,
} from './mcp-pool-key.js';

describe('mcp-pool-key', () => {
  describe('fingerprint', () => {
    it('is stable across two MCPServerConfig instances with identical content', () => {
      const a = new MCPServerConfig('node', ['./srv.js'], { FOO: 'bar' });
      const b = new MCPServerConfig('node', ['./srv.js'], { FOO: 'bar' });
      expect(fingerprint(a)).toBe(fingerprint(b));
    });

    it('is stable across env-key permutations (sorted before hash)', () => {
      const a = new MCPServerConfig('node', undefined, { A: '1', B: '2' });
      const b = new MCPServerConfig('node', undefined, { B: '2', A: '1' });
      expect(fingerprint(a)).toBe(fingerprint(b));
    });

    it('diverges on any byte change in env value (critical for credential isolation)', () => {
      const a = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'https://api.example.com',
        { Authorization: 'Bearer tokenA' },
      );
      const b = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'https://api.example.com',
        { Authorization: 'Bearer tokenB' },
      );
      expect(fingerprint(a)).not.toBe(fingerprint(b));
    });

    it('diverges on header-key permutation only via value (keys are sorted)', () => {
      const a = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'https://x',
        { 'X-A': '1', 'X-B': '2' },
      );
      const b = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'https://x',
        { 'X-B': '2', 'X-A': '1' },
      );
      expect(fingerprint(a)).toBe(fingerprint(b));
    });

    it('SAME key when includeTools/excludeTools/trust/description differ (per-session filters excluded)', () => {
      const a = new MCPServerConfig(
        'node',
        ['s.js'],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        /*trust*/ false,
        /*description*/ 'A',
        ['onlyA'],
        ['notA'],
      );
      const b = new MCPServerConfig(
        'node',
        ['s.js'],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        /*trust*/ true,
        /*description*/ 'B',
        undefined,
        undefined,
      );
      expect(fingerprint(a)).toBe(fingerprint(b));
    });

    it('produces a 16-char hex string', () => {
      const fp = fingerprint(new MCPServerConfig('node'));
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('canonicalOAuth (V21-9)', () => {
    it('collapses undefined / null / {} / {enabled:false} to the same null', () => {
      expect(canonicalOAuth(undefined)).toBeNull();
      expect(canonicalOAuth(null)).toBeNull();
      expect(canonicalOAuth({ enabled: false })).toBeNull();
    });

    it('produces stable shape for enabled configs (scope-sorted)', () => {
      const a = canonicalOAuth({ enabled: true, scopes: ['b', 'a'] });
      const b = canonicalOAuth({ enabled: true, scopes: ['a', 'b'] });
      expect(a).toEqual(b);
    });

    it('also sorts audiences (W88)', () => {
      const a = canonicalOAuth({ enabled: true, audiences: ['b', 'a'] });
      const b = canonicalOAuth({ enabled: true, audiences: ['a', 'b'] });
      expect(a).toEqual(b);
    });

    it.each([
      ['clientSecret', { clientSecret: 'shh' }],
      ['audiences', { audiences: ['aud1'] }],
      ['redirectUri', { redirectUri: 'https://x/cb' }],
      ['tokenParamName', { tokenParamName: 'access_token' }],
      ['registrationUrl', { registrationUrl: 'https://x/reg' }],
    ])(
      'distinguishes fingerprints on %s (W88 — pre-fix collided)',
      (_field, diff) => {
        const base = {
          enabled: true as const,
          clientId: 'id',
          authorizationUrl: 'https://x/authz',
          tokenUrl: 'https://x/token',
          scopes: ['a'],
        };
        const a = canonicalOAuth(base);
        const b = canonicalOAuth({ ...base, ...diff });
        expect(a).not.toEqual(b);
      },
    );
  });

  describe('mcpTransportOf', () => {
    it('classifies stdio when command present', () => {
      expect(mcpTransportOf(new MCPServerConfig('node'))).toBe('stdio');
    });
    it('classifies sdk via isSdkMcpServerConfig', () => {
      const cfg = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'sdk',
      );
      expect(mcpTransportOf(cfg)).toBe('sdk');
    });
    it('classifies http when httpUrl set', () => {
      expect(
        mcpTransportOf(
          new MCPServerConfig(
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            'https://api.x.com',
          ),
        ),
      ).toBe('http');
    });
    it('returns unknown when no transport-defining field', () => {
      expect(mcpTransportOf(new MCPServerConfig())).toBe('unknown');
    });
  });

  describe('isPoolable + POOLED_TRANSPORTS_DEFAULT', () => {
    it('stdio is poolable by default', () => {
      expect(
        isPoolable(new MCPServerConfig('node'), POOLED_TRANSPORTS_DEFAULT),
      ).toBe(true);
    });
    it('http is NOT poolable by default (V21 C8 / opt-in)', () => {
      const cfg = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'https://x',
      );
      expect(isPoolable(cfg, POOLED_TRANSPORTS_DEFAULT)).toBe(false);
    });
    it('http IS poolable when operator opts in via pooledTransports', () => {
      const cfg = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'https://x',
      );
      expect(
        isPoolable(
          cfg,
          new Set(['stdio', 'websocket', 'http']) as ReadonlySet<
            ReturnType<typeof mcpTransportOf>
          >,
        ),
      ).toBe(true);
    });
    it('SDK MCP is never poolable (always bypass)', () => {
      const cfg = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'sdk',
      );
      // Even with sdk in pooledTransports, isPoolable returns false.
      expect(
        isPoolable(
          cfg,
          new Set(['stdio', 'websocket', 'sdk']) as ReadonlySet<
            ReturnType<typeof mcpTransportOf>
          >,
        ),
      ).toBe(false);
    });
  });

  describe('connectionIdOf + parseConnectionId', () => {
    it('round-trips for normal server names', () => {
      const cfg = new MCPServerConfig('node');
      const id = connectionIdOf('foo', cfg);
      const parsed = parseConnectionId(id);
      expect(parsed.serverName).toBe('foo');
      expect(parsed.fingerprint).toBe(fingerprint(cfg));
    });

    it('handles server names containing the :: separator by using lastIndexOf', () => {
      // Edge: user with namespaced server name like "ext::github".
      const cfg = new MCPServerConfig('node');
      const id = connectionIdOf('ext::github', cfg);
      const parsed = parseConnectionId(id);
      expect(parsed.serverName).toBe('ext::github');
      expect(parsed.fingerprint).toBe(fingerprint(cfg));
    });
  });
});
