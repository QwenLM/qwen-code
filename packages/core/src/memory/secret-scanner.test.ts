/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { scanForSecrets } from './secret-scanner.js';

describe('scanForSecrets', () => {
  it('returns no matches for clean content', () => {
    expect(
      scanForSecrets('Integration tests must hit a real database, not mocks.'),
    ).toEqual([]);
  });

  // One canonical sample per rule family — guards against a mis-transcribed
  // quantifier silently disabling a rule.
  it.each([
    ['aws-access-token', 'AKIAIOSFODNN7EXAMPLE'],
    ['alibaba-cloud-access-key', `LTAI${'a'.repeat(16)}`],
    ['gcp-api-key', `AIza${'a'.repeat(35)}`],
    ['digitalocean-pat', `dop_v1_${'a'.repeat(64)}`],
    ['anthropic-api-key', `sk-ant-api03-${'a'.repeat(30)}`],
    ['openai-api-key', `sk-proj-${'a'.repeat(48)}`],
    ['huggingface-access-token', `hf_a1${'b'.repeat(32)}`],
    ['github-pat', `ghp_${'a'.repeat(36)}`],
    ['github-fine-grained-pat', `github_pat_${'a'.repeat(82)}`],
    ['github-app-token', `ghu_${'a'.repeat(36)}`],
    ['github-oauth', `gho_${'a'.repeat(36)}`],
    ['gitlab-pat', `glpat-${'a'.repeat(20)}`],
    ['slack-bot-token', `xoxb-${'1'.repeat(12)}-${'1'.repeat(12)}abcd`],
    ['slack-app-token', 'xapp-1-ABC123-1234567890-abcdef'],
    ['npm-access-token', `npm_${'a'.repeat(36)}`],
    ['stripe-access-token', `sk_live_${'a'.repeat(24)}`],
  ])('detects %s', (ruleId, sample) => {
    const matches = scanForSecrets(`token = ${sample}`);
    expect(matches.map((m) => m.ruleId)).toContain(ruleId);
  });

  it('detects all current OpenAI key formats', () => {
    for (const sample of [
      `sk-proj-${'a'.repeat(48)}`,
      `sk-svcacct-${'a'.repeat(48)}`,
      `sk-${'a'.repeat(20)}T3BlbkFJ${'b'.repeat(20)}`,
    ]) {
      expect(scanForSecrets(sample).map((m) => m.ruleId)).toContain(
        'openai-api-key',
      );
    }
  });

  it('detects a secret followed by punctuation delimiters', () => {
    const key = `sk-ant-api03-${'a'.repeat(30)}`;
    for (const delim of ['.', ',', ')', '}']) {
      expect(
        scanForSecrets(`key=${key}${delim}`).map((m) => m.ruleId),
      ).toContain('anthropic-api-key');
    }
  });

  it('detects an AWS access key whose suffix contains digits 0/1/8/9', () => {
    // Suffix is base62; the retired base32 [A-Z2-7] class missed 0/1/8/9.
    expect(
      scanForSecrets(`AKIA0918ABCDEFGH9012`).map((m) => m.ruleId),
    ).toContain('aws-access-token');
  });

  it('detects a HuggingFace token containing digits', () => {
    expect(
      scanForSecrets(`hf_${'a1b2'.repeat(9)}`).map((m) => m.ruleId),
    ).toContain('huggingface-access-token');
  });

  it('detects a PEM private key block', () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(120)}\n-----END PRIVATE KEY-----`;
    expect(scanForSecrets(pem).map((m) => m.ruleId)).toContain('private-key');
  });

  it('handles many unmatched private-key markers without a match', () => {
    const payload = Array.from(
      { length: 4000 },
      () => '-----BEGIN PRIVATE KEY-----',
    ).join('\n');
    expect(scanForSecrets(payload)).toEqual([]);
  });

  it('never returns the matched secret value, only rule id and label', () => {
    const secret = `ghp_${'b'.repeat(36)}`;
    const [match] = scanForSecrets(secret);
    expect(Object.keys(match).sort()).toEqual(['label', 'ruleId']);
    expect(JSON.stringify(match)).not.toContain(secret);
  });

  it('reports readable labels (acronyms and providers expanded)', () => {
    expect(scanForSecrets(`ghp_${'c'.repeat(36)}`)[0].label).toBe('GitHub PAT');
    expect(scanForSecrets('AKIAIOSFODNN7EXAMPLE')[0].label).toBe(
      'AWS Access Token',
    );
    expect(scanForSecrets(`LTAI${'a'.repeat(16)}`)[0].label).toBe(
      'Alibaba Cloud Access Key',
    );
  });

  it('does not match a token one char short of the minimum length', () => {
    // 35-char body is just under the github-pat {36} floor.
    expect(scanForSecrets(`ghp_${'a'.repeat(35)} `)).toEqual([]);
  });
});
