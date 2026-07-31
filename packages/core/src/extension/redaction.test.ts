/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { REDACTED_URL_CREDENTIAL, redactUrlCredentials } from './redaction.js';

describe('redactUrlCredentials', () => {
  it('redacts username and password from HTTPS URLs', () => {
    expect(
      redactUrlCredentials('https://user:token@example.com/org/repo.git'),
    ).toBe(`https://${REDACTED_URL_CREDENTIAL}@example.com/org/repo.git`);
  });

  it('redacts token-only URL credentials', () => {
    expect(
      redactUrlCredentials('https://ghp_token@github.com/owner/repo'),
    ).toBe(`https://${REDACTED_URL_CREDENTIAL}@github.com/owner/repo`);
  });

  it('redacts raw hash characters echoed in URL credentials', () => {
    expect(
      redactUrlCredentials('https://user:pass#word@example.com/org/repo.git'),
    ).toBe(`https://${REDACTED_URL_CREDENTIAL}@example.com/org/repo.git`);
  });

  it('redacts unencoded at signs inside echoed URL credentials', () => {
    expect(
      redactUrlCredentials('https://email@gmail.com:tok@example.com/repo'),
    ).toBe(`https://${REDACTED_URL_CREDENTIAL}@example.com/repo`);
  });

  it('redacts unencoded question marks inside echoed URL credentials', () => {
    expect(redactUrlCredentials('https://user:gh?token@example.com/repo')).toBe(
      `https://${REDACTED_URL_CREDENTIAL}@example.com/repo`,
    );
  });

  it('redacts percent-encoded URL credentials', () => {
    expect(
      redactUrlCredentials('https://user%40mail:tok%3Fen@example.com/repo'),
    ).toBe(`https://${REDACTED_URL_CREDENTIAL}@example.com/repo`);
  });

  it('does not redact at signs after the URL path starts', () => {
    const source = 'https://example.com/path/@scope/package';
    expect(redactUrlCredentials(source)).toBe(source);
  });

  it('redacts custom URL schemes used by extension sources', () => {
    expect(redactUrlCredentials('sso://user:token@example.com/org/repo')).toBe(
      `sso://${REDACTED_URL_CREDENTIAL}@example.com/org/repo`,
    );
  });

  it('redacts credentialed URLs embedded in diagnostic messages', () => {
    expect(
      redactUrlCredentials(
        'fatal: authentication failed for https://user:token@example.com/repo',
      ),
    ).toBe(
      `fatal: authentication failed for https://${REDACTED_URL_CREDENTIAL}@example.com/repo`,
    );
  });

  it('does not modify URLs without credentials', () => {
    const source = 'https://github.com/owner/repo';
    expect(redactUrlCredentials(source)).toBe(source);
  });

  it('does not throw for malformed or non-URL sources', () => {
    expect(redactUrlCredentials('owner/repo')).toBe('owner/repo');
    expect(redactUrlCredentials('https://')).toBe('https://');
  });
});
