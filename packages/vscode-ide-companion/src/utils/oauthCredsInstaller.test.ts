/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* eslint-disable import/no-internal-modules -- OAuth smoke helper lives under /test */
import {
  getOauthCredsPath,
  installOauthCredsFromEnv,
  resolveOauthCredsFromEnv,
} from '../../test/oauthCredsInstaller.mjs';
/* eslint-enable import/no-internal-modules */

const validCreds = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  token_type: 'Bearer',
  expiry_date: Date.now() + 60 * 60 * 1000,
  resource_url: 'https://chat.qwen.ai/api/v1',
};

describe('oauthCredsInstaller', () => {
  it('prefers QWEN_TEST_OAUTH_CREDS_JSON when provided', () => {
    expect(
      resolveOauthCredsFromEnv({
        QWEN_TEST_OAUTH_CREDS_JSON: JSON.stringify(validCreds),
        QWEN_TEST_OAUTH_CREDS_BASE64: Buffer.from(
          JSON.stringify({
            ...validCreds,
            access_token: 'other-token',
          }),
          'utf8',
        ).toString('base64'),
      }),
    ).toEqual(validCreds);
  });

  it('decodes QWEN_TEST_OAUTH_CREDS_BASE64 when JSON env is absent', () => {
    expect(
      resolveOauthCredsFromEnv({
        QWEN_TEST_OAUTH_CREDS_BASE64: Buffer.from(
          JSON.stringify(validCreds),
          'utf8',
        ).toString('base64'),
      }),
    ).toEqual(validCreds);
  });

  it('rejects incomplete credentials', () => {
    expect(() =>
      resolveOauthCredsFromEnv({
        QWEN_TEST_OAUTH_CREDS_JSON: JSON.stringify({
          access_token: 'token-only',
        }),
      }),
    ).toThrow(/missing refresh_token/i);
  });

  it('writes oauth_creds.json under the provided home directory', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-oauth-'));

    const writtenPath = await installOauthCredsFromEnv(
      {
        QWEN_TEST_OAUTH_CREDS_JSON: JSON.stringify(validCreds),
      },
      tempHome,
    );

    expect(writtenPath).toBe(getOauthCredsPath(tempHome));
    await expect(fs.readFile(writtenPath, 'utf8')).resolves.toBe(
      `${JSON.stringify(validCreds, null, 2)}\n`,
    );
  });
});
