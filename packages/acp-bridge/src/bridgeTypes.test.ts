/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseBridgeManagedSessionStore,
  parseRegenerateOfPromptId,
} from './bridgeTypes.js';

describe('parseRegenerateOfPromptId', () => {
  it('preserves the original daemon prompt UUID', () => {
    const promptId = '11111111-1111-4111-8111-111111111111';
    expect(parseRegenerateOfPromptId(promptId)).toBe(promptId);
  });

  it.each([
    undefined,
    null,
    '',
    ' ',
    'prompt-id',
    '11111111-1111-4111-8111-111111111111\n',
    1,
    {},
    [],
    'x'.repeat(1000),
  ])('ignores a malformed regeneration marker (%j)', (value) => {
    expect(parseRegenerateOfPromptId(value)).toBeUndefined();
  });
});

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../core/src/managed-runtime/contracts/managed-session-store-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  limits: {
    minimumWriterTokenLength: number;
    maximumWriterTokenLength: number;
  };
};

describe('parseBridgeManagedSessionStore', () => {
  const valid = {
    baseUrl: 'http://127.0.0.1:8080',
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    writerId: 'writer-a',
    leaseDurationMs: 60_000,
  };

  it('round-trips the provisioned writer credential and insecure opt-in', () => {
    const parsed = parseBridgeManagedSessionStore(valid);
    expect(parsed.writerToken).toBeUndefined();
    expect(parsed.allowInsecureHttp).toBeUndefined();

    const provisioned = parseBridgeManagedSessionStore({
      ...valid,
      writerToken: `qwt1_${'a'.repeat(43)}`,
      allowInsecureHttp: true,
    });
    expect(provisioned.writerToken).toBe(`qwt1_${'a'.repeat(43)}`);
    expect(provisioned.allowInsecureHttp).toBe(true);
  });

  it('rejects malformed optional credentials', () => {
    for (const writerToken of [
      'short',
      'has spaces and symbols!! padding',
      42,
      null,
    ]) {
      expect(() =>
        parseBridgeManagedSessionStore({ ...valid, writerToken }),
      ).toThrow(/writerToken is invalid/);
    }
    expect(() =>
      parseBridgeManagedSessionStore({
        ...valid,
        allowInsecureHttp: 'yes',
      }),
    ).toThrow(/allowInsecureHttp is invalid/);
    expect(() =>
      parseBridgeManagedSessionStore({ ...valid, extraField: 1 }),
    ).toThrow(/unsupported field/);
  });

  it('bounds writerToken length at the shared fixture limits', () => {
    const { minimumWriterTokenLength, maximumWriterTokenLength } =
      fixture.limits;
    expect(() =>
      parseBridgeManagedSessionStore({
        ...valid,
        writerToken: 'a'.repeat(minimumWriterTokenLength - 1),
      }),
    ).toThrow(/writerToken is invalid/);
    expect(
      parseBridgeManagedSessionStore({
        ...valid,
        writerToken: 'a'.repeat(minimumWriterTokenLength),
      }).writerToken,
    ).toHaveLength(minimumWriterTokenLength);
    expect(
      parseBridgeManagedSessionStore({
        ...valid,
        writerToken: 'a'.repeat(maximumWriterTokenLength),
      }).writerToken,
    ).toHaveLength(maximumWriterTokenLength);
    expect(() =>
      parseBridgeManagedSessionStore({
        ...valid,
        writerToken: 'a'.repeat(maximumWriterTokenLength + 1),
      }),
    ).toThrow(/writerToken is invalid/);
  });
});
