/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { csiHistoryPreparationFixture } from './__tests__/csi-history-preparation-fixture.js';
import { parseManagedCsiFileBoot } from './managed-csi-file-envelope.js';
import {
  csiFileHistoryEnvelope,
  readCsiFileHistoryEnvelope,
  readCsiFileHistoryObservation,
  readCsiFileHistoryOperation,
  readCsiPreparationEvidence,
  csiHistoryContentDigest,
} from './managed-csi-file-history-protocol.js';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-csi-file-history-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  request: {
    identity: { sessionId: string };
    installedContext: Record<string, unknown>;
  };
  valid: Array<{ name: string; observation: unknown }>;
  invalid: Array<{ name: string; observation: unknown }>;
};
const native = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-csi-native-readback-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

describe('shared private CSI history wire contract', () => {
  const owner = fixture.request.identity.sessionId;
  it.each(fixture.valid)(
    'preserves $name descriptor and backup evidence',
    (candidate) => {
      expect(
        readCsiFileHistoryObservation(candidate.observation, owner),
      ).toEqual(candidate.observation);
    },
  );
  it.each(fixture.invalid)('refuses $name', (candidate) => {
    expect(() =>
      readCsiFileHistoryObservation(candidate.observation, owner),
    ).toThrow();
  });
  it('requires the exact original installation and the three closed operations', () => {
    const boot = parseManagedCsiFileBoot(native.boot);
    const installed = fixture.request.installedContext;
    for (const action of ['bind', 'snapshot'] as const) {
      const operation = {
        kind: 'csi-file-history',
        version: 1,
        action,
      } as const;
      const envelope = csiFileHistoryEnvelope(boot, installed, operation);
      expect(readCsiFileHistoryEnvelope(envelope, boot, installed)).toEqual(
        operation,
      );
      expect(() =>
        readCsiFileHistoryEnvelope(
          {
            ...envelope,
            installedContext: { ...installed, operationId: 'other' },
          },
          boot,
          installed,
        ),
      ).toThrow();
      expect(() =>
        readCsiFileHistoryOperation({ ...operation, paths: ['caller.txt'] }),
      ).toThrow();
    }
    expect(() =>
      readCsiFileHistoryOperation({
        kind: 'csi-file-history',
        version: 1,
        action: 'prepare',
      }),
    ).toThrow();
    expect(() =>
      readCsiFileHistoryOperation({
        kind: 'csi-file-history',
        version: 1,
        action: 'rewind',
      }),
    ).toThrow();
  });
});

describe('preparation paths from original resource bytes', () => {
  it('preserves the full Read/Write/Edit membership and refusal ordinal gaps', () => {
    const sample = csiHistoryPreparationFixture();
    expect(readCsiPreparationEvidence(sample.response)).toEqual({
      preparation: sample.preparation,
      observation: sample.observation,
    });
    expect(sample.preparation.invocations.map((item) => item.ordinal)).toEqual([
      0, 2, 4,
    ]);
    expect(sample.preparation.paths).not.toContain('read-only.txt');
  });

  it.each(['paths', 'membership', 'owner', 'wrapper'])(
    'refuses coherent resource hashes with changed %s',
    (fault) => {
      const sample = csiHistoryPreparationFixture();
      const resources = sample.response.evidence['resources'] as Array<{
        reference: Record<string, unknown>;
        bytesBase64: string;
      }>;
      const item = resources.find(
        (item) => item.reference['resourceId'] === sample.intentRef.resourceId,
      )!;
      const body = JSON.parse(
        Buffer.from(item.bytesBase64, 'base64').toString(),
      );
      if (fault === 'paths') body.preparation.paths = ['caller.txt'];
      if (fault === 'membership') body.preparation.invocations.shift();
      if (fault === 'owner') body.runtimeSessionId = 'foreign';
      if (fault === 'wrapper') body.preparation.paths.push('read-only.txt');
      const bytes = Buffer.from(JSON.stringify(body));
      item.bytesBase64 = bytes.toString('base64');
      item.reference['byteLength'] = bytes.length;
      item.reference['digest'] = createHash('sha256')
        .update(bytes)
        .digest('hex');
      expect(() => readCsiPreparationEvidence(sample.response)).toThrow();
    },
  );

  it('uses a stable semantic digest across generated projection values', () => {
    const sample = csiHistoryPreparationFixture();
    const content = {
      ...sample.observation,
      preparation: sample.preparation,
      record: { uuid: 'first', timestamp: 'first' },
    };
    const digest = csiHistoryContentDigest(content);
    expect(
      csiHistoryContentDigest({
        ...content,
        record: { uuid: 'second', timestamp: 'second' },
      }),
    ).toBe(digest);
    expect(
      csiHistoryContentDigest({
        ...content,
        preparation: { ...sample.preparation, paths: ['other.txt'] },
      }),
    ).not.toBe(digest);
  });
});
