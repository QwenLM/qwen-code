/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import { AcpConnection } from './acpConnection.js';
import { ACP_ERROR_CODES } from '../constants/acpSchema.js';

describe('AcpConnection readTextFile error mapping', () => {
  it('maps ENOENT to RESOURCE_NOT_FOUND RequestError', () => {
    const conn = new AcpConnection() as unknown as {
      mapReadTextFileError: (error: unknown, filePath: string) => unknown;
    };
    const enoent = Object.assign(new Error('missing file'), { code: 'ENOENT' });

    expect(() =>
      conn.mapReadTextFileError(enoent, '/tmp/missing.txt'),
    ).toThrowError(
      expect.objectContaining({
        code: ACP_ERROR_CODES.RESOURCE_NOT_FOUND,
      }),
    );
  });

  it('keeps non-ENOENT RequestError unchanged', () => {
    const conn = new AcpConnection() as unknown as {
      mapReadTextFileError: (error: unknown, filePath: string) => unknown;
    };
    const requestError = new RequestError(
      ACP_ERROR_CODES.INTERNAL_ERROR,
      'Internal error',
    );

    expect(conn.mapReadTextFileError(requestError, '/tmp/file.txt')).toBe(
      requestError,
    );
  });
});
