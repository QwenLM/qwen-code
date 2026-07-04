/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { redactLogCredentials } from './logRedaction.js';

const R = '<redacted>';

describe('redactLogCredentials', () => {
  // ── Bearer tokens ──────────────────────────────────────────────────

  it('redacts Bearer tokens', () => {
    expect(
      redactLogCredentials('Authorization: Bearer eyJhbGciOi.xyz.abc'),
    ).toBe(`Authorization: ${R}`);
  });

  it('redacts bare Bearer (no "Authorization:" prefix)', () => {
    expect(redactLogCredentials('header Bearer t-abc123_def.456')).toBe(
      `header Bearer ${R}`,
    );
  });

  it('is case-insensitive for Bearer', () => {
    expect(redactLogCredentials('bearer TOKEN123')).toBe(`bearer ${R}`);
  });

  it('redacts Bearer tokens with +/= characters (RFC 6750)', () => {
    expect(redactLogCredentials('Bearer abc+/def==')).toBe(`Bearer ${R}`);
  });

  // ── QQBot tokens ──────────────────────────────────────────────────

  it('redacts QQBot tokens', () => {
    expect(redactLogCredentials('token: QQBot abcdef123456')).toBe(
      `token: QQBot ${R}`,
    );
  });

  // ── Authorization header catch-all ────────────────────────────────

  it('redacts Authorization with Basic scheme', () => {
    expect(redactLogCredentials('Authorization: Basic dXNlcjpwYXNz')).toBe(
      `Authorization: ${R}`,
    );
  });

  it('redacts Authorization with Digest scheme', () => {
    expect(redactLogCredentials('Authorization: Digest username="user"')).toBe(
      `Authorization: ${R}`,
    );
  });

  // ── DingTalk access token header ──────────────────────────────────

  it('redacts DingTalk access token header', () => {
    expect(
      redactLogCredentials('x-acs-dingtalk-access-token: abc123def456'),
    ).toBe(`x-acs-dingtalk-access-token: ${R}`);
  });

  // ── API key prefixes ──────────────────────────────────────────────

  it('redacts sk- keys with ≥20 chars', () => {
    const key = 'sk-' + 'a'.repeat(20);
    expect(redactLogCredentials(`key=${key}`)).toBe(`key=sk-${R}`);
  });

  it('does NOT redact short sk- strings', () => {
    expect(redactLogCredentials('sk-test')).toBe('sk-test');
    expect(redactLogCredentials('sk-abc')).toBe('sk-abc');
  });

  it('redacts GitHub personal access tokens', () => {
    const token = 'ghp_' + 'A'.repeat(36);
    expect(redactLogCredentials(`GITHUB_TOKEN=${token}`)).toContain(R);
  });

  it('redacts GitLab personal access tokens', () => {
    const token = 'glpat-' + 'x'.repeat(20);
    expect(redactLogCredentials(token)).toBe(R);
  });

  it('redacts Slack bot tokens', () => {
    const token = 'xoxb-' + '1'.repeat(20);
    expect(redactLogCredentials(token)).toBe(R);
  });

  it('redacts Slack user access tokens', () => {
    const token = 'xoxp-' + '1'.repeat(20);
    expect(redactLogCredentials(token)).toBe(R);
  });

  it('redacts real-format Slack tokens with hyphens', () => {
    const token = 'xoxb-fake-' + 'a'.repeat(30);
    expect(redactLogCredentials(token)).toBe(R);
  });

  it('does NOT redact short ghp_ strings', () => {
    expect(redactLogCredentials('ghp_short')).toBe('ghp_short');
  });

  it('redacts sk- keys with hyphens (sk-proj-, sk-ant-)', () => {
    const key = 'sk-proj-' + 'a'.repeat(20);
    expect(redactLogCredentials(key)).toBe(`sk-${R}`);
  });

  it('redacts github_pat_ fine-grained PATs', () => {
    const token = 'github_pat_' + 'A'.repeat(40);
    expect(redactLogCredentials(token)).toBe(R);
  });

  it('redacts AWS STS temporary credentials (ASIA prefix)', () => {
    expect(redactLogCredentials('ASIAIOSFODNN7EXAMPLE')).toBe(R);
  });

  // ── AWS access key IDs ────────────────────────────────────────────

  it('redacts AWS access key IDs', () => {
    expect(redactLogCredentials('AKIAIOSFODNN7EXAMPLE')).toBe(R);
  });

  // ── Key=value secret assignments ──────────────────────────────────

  it('redacts token= assignments with ≥10 char values', () => {
    expect(redactLogCredentials('token=abcdef1234567890')).toBe(`token=${R}`);
  });

  it('redacts API_KEY: assignments', () => {
    expect(redactLogCredentials('api_key: sk-longenoughvalue123')).toBe(
      `api_key: ${R}`,
    );
  });

  it('redacts password= assignments', () => {
    expect(redactLogCredentials('password=mysecretpassword123')).toBe(
      `password=${R}`,
    );
  });

  it('redacts secret= assignments', () => {
    expect(redactLogCredentials('secret=verylongsecretvalue')).toBe(
      `secret=${R}`,
    );
  });

  it('does NOT redact short token values', () => {
    expect(redactLogCredentials('token=abc')).toBe('token=abc');
  });

  it('redacts compound key names like AWS_SECRET_ACCESS_KEY', () => {
    expect(
      redactLogCredentials(
        'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY',
      ),
    ).toBe(`AWS_SECRET_ACCESS_KEY=${R}`);
  });

  it('redacts QWEN_DAEMON_TOKEN assignments', () => {
    expect(
      redactLogCredentials('QWEN_DAEMON_TOKEN=some-long-token-value-here'),
    ).toBe(`QWEN_DAEMON_TOKEN=${R}`);
  });

  it('redacts client_secret assignments', () => {
    expect(redactLogCredentials('client_secret: abcdef1234567890xxxx')).toBe(
      `client_secret: ${R}`,
    );
  });

  // ── JSON-quoted secret fields ───────────────────────────────────

  it('redacts JSON "token":"..." fields', () => {
    const line = '{"token":"abcdef1234567890xxxx","event":"login"}';
    const result = redactLogCredentials(line);
    expect(result).not.toContain('abcdef1234567890xxxx');
    expect(result).toContain(`"token":"${R}"`);
    expect(result).toContain('"event":"login"');
  });

  it('redacts JSON "client_secret":"..." fields', () => {
    const line = '{"client_secret":"my-very-secret-value-1234"}';
    const result = redactLogCredentials(line);
    expect(result).not.toContain('my-very-secret-value-1234');
  });

  it('does NOT redact short JSON values', () => {
    expect(redactLogCredentials('{"token":"short"}')).toBe('{"token":"short"}');
  });

  // ── URL-embedded credentials ──────────────────────────────────────

  it('redacts URL credentials', () => {
    expect(
      redactLogCredentials('proxy: https://user:pass@proxy.local:8080'),
    ).toBe(`proxy: https://${R}@proxy.local:8080`);
  });

  it('redacts multiple userinfo segments', () => {
    expect(redactLogCredentials('http://a:b@c:d@host/path')).toBe(
      `http://${R}@host/path`,
    );
  });

  // ── Mixed patterns ────────────────────────────────────────────────

  it('redacts multiple credentials on one line', () => {
    const line =
      'Authorization: Bearer eyJtoken calling https://user:pass@api.example.com/v1';
    const result = redactLogCredentials(line);
    expect(result).not.toContain('eyJtoken');
    expect(result).not.toContain('user:pass');
    expect(result).toContain(R);
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it('returns empty string unchanged', () => {
    expect(redactLogCredentials('')).toBe('');
  });

  it('returns non-matching line unchanged', () => {
    const line = '[2025-01-01T00:00:00Z] [INFO] Server started on port 4170';
    expect(redactLogCredentials(line)).toBe(line);
  });

  it('preserves non-ASCII content', () => {
    const line = '[INFO] 连接成功 Bearer abc123.xyz.def';
    const result = redactLogCredentials(line);
    expect(result).toContain('连接成功');
    expect(result).toContain(`Bearer ${R}`);
  });

  it('handles very long lines without error', () => {
    const longLine = 'x'.repeat(100_000);
    expect(() => redactLogCredentials(longLine)).not.toThrow();
  });
});

describe('createStderrForwarder redaction integration', () => {
  it('redacts credentials flushed via onEnd (partial line without newline)', async () => {
    const { createStderrForwarder } = await import('./spawnChannel.js');
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[p] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    forwarder.onData('Bearer secrettoken123');
    expect(captured).toHaveLength(0);
    forwarder.onEnd();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.line).not.toContain('secrettoken123');
    expect(captured[0]!.line).toContain('<redacted>');
    stderrSpy.mockRestore();
  });
});
