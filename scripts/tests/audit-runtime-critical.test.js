/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  createAuditPayload,
  decodeAuditResponse,
  findCriticalAdvisories,
} from '../audit-runtime-critical.js';

describe('runtime dependency audit', () => {
  it('collects installed production package versions', () => {
    expect(
      createAuditPayload({
        packages: {
          '': { name: 'root', version: '1.0.0' },
          'packages/core': { name: '@qwen-code/core', version: '1.0.0' },
          'node_modules/foo': { version: '1.0.0' },
          'packages/core/node_modules/foo': { version: '2.0.0' },
          'node_modules/@scope/bar': { version: '3.0.0' },
          'node_modules/dev-only': { version: '1.0.0', dev: true },
          'node_modules/workspace': { link: true },
        },
      }),
    ).toEqual({
      '@qwen-code/core': ['1.0.0'],
      foo: ['1.0.0', '2.0.0'],
      '@scope/bar': ['3.0.0'],
    });
  });

  it('decodes plain and gzip responses', () => {
    const body = Buffer.from('{"foo":[]}');
    expect(decodeAuditResponse(body)).toEqual(body);
    expect(decodeAuditResponse(gzipSync(body))).toEqual(body);
  });

  it('returns only critical advisories', () => {
    expect(
      findCriticalAdvisories({
        foo: [
          { severity: 'high', title: 'high' },
          { severity: 'critical', title: 'critical' },
        ],
      }),
    ).toEqual([{ name: 'foo', severity: 'critical', title: 'critical' }]);
  });
});
