/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  parseHostedFileHistoryRecord,
  parseHostedFileHistoryState,
} from './hosted-file-history-protocol.js';
import { createHash } from 'node:crypto';
import {
  readCsiNativeRequest,
  readCsiNativeResponse,
} from './managed-csi-native-readback.js';
import {
  csiHistoryPreparationFixture,
  csiFileHistoryEnvelope,
} from './__tests__/csi-history-preparation-fixture.js';
import { parseManagedCsiFileBoot } from './managed-csi-file-envelope.js';
import {
  readCsiFileHistoryEnvelope,
  readCsiFileHistoryObservation,
  readCsiFileHistoryOperation,
  readCsiPreparationEvidence,
} from './managed-csi-file-history-protocol.js';

vi.mock('node:path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:path')>()),
}));

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
  snapshotCwdCases: Array<{ cwd: unknown; valid: boolean }>;
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

describe.each(['posix', 'win32'] as const)(
  'shared private CSI history wire contract with injected native %s grammar',
  (grammar) => {
    const nativePaths = path[grammar];
    beforeEach(() => {
      vi.spyOn(path, 'isAbsolute').mockImplementation(nativePaths.isAbsolute);
      vi.spyOn(path, 'normalize').mockImplementation(nativePaths.normalize);
    });
    afterEach(() => vi.restoreAllMocks());
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
    it.each(fixture.snapshotCwdCases)(
      'matches the shared cwd normalization contract for $cwd',
      ({ cwd, valid }) => {
        const observation = readCsiFileHistoryObservation(
          fixture.valid.find((entry) => entry.name === 'snapshot-cwd')!
            .observation,
          owner,
        );
        Object.assign(observation.state.snapshots[0], { cwd });
        if (valid) {
          expect(readCsiFileHistoryObservation(observation, owner)).toEqual(
            observation,
          );
        } else {
          expect(() =>
            readCsiFileHistoryObservation(observation, owner),
          ).toThrow();
        }
      },
    );
    it.each(
      fixture.snapshotCwdCases.filter(
        ({ cwd }) =>
          typeof cwd === 'string' &&
          [...cwd].some(
            (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
          ),
      ),
    )(
      'rejects control-bearing cwd through the existing error kind',
      ({ cwd }) => {
        const observation = readCsiFileHistoryObservation(
          fixture.valid.find((entry) => entry.name === 'snapshot-cwd')!
            .observation,
          owner,
        );
        Object.assign(observation.state.snapshots[0], { cwd });
        expect(() => readCsiFileHistoryObservation(observation, owner)).toThrow(
          expect.objectContaining({
            name: 'ManagedToolProtocolError',
            code: 'managed_tool_invalid_request',
            message: 'Managed Tool invocation data is invalid.',
          }),
        );
      },
    );
    it.each([
      'C:\\workspace',
      'C:\\',
      'C:\\workspace\\',
      '\\\\server\\share\\workspace',
      '\\\\server\\share\\',
      '\\workspace',
    ])(
      'allows generic Hosted origin %s but refuses it at the CSI boundary',
      (cwd) => {
        const observation = readCsiFileHistoryObservation(
          fixture.valid.find((entry) => entry.name === 'snapshot-cwd')!
            .observation,
          owner,
        );
        observation.state.snapshots[0].cwd = cwd;
        expect(parseHostedFileHistoryState(observation.state, owner)).toEqual(
          observation.state,
        );
        const record = {
          schemaVersion: 1,
          state: observation.state,
          pendingTurn: null,
          pendingUndo: null,
          undoReceipts: [],
        };
        expect(parseHostedFileHistoryRecord(record, owner)).toEqual(record);
        expect(() => readCsiFileHistoryObservation(observation, owner)).toThrow(
          'Invalid private CSI file history.',
        );
      },
    );
    it.each([4096, 4097])('bounds the POSIX cwd length at %s', (length) => {
      const observation = readCsiFileHistoryObservation(
        fixture.valid.find((entry) => entry.name === 'snapshot-cwd')!
          .observation,
        owner,
      );
      observation.state.snapshots[0].cwd = `/${'x'.repeat(length - 1)}`;
      if (length === 4096) {
        expect(readCsiFileHistoryObservation(observation, owner)).toEqual(
          observation,
        );
      } else {
        expect(() =>
          readCsiFileHistoryObservation(observation, owner),
        ).toThrow();
      }
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
  },
);

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

  it.each(['paths', 'membership', 'owner', 'read-only-path'])(
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
      if (fault === 'read-only-path')
        body.preparation.paths.push('read-only.txt');
      const bytes = Buffer.from(JSON.stringify(body));
      item.bytesBase64 = bytes.toString('base64');
      item.reference['byteLength'] = bytes.length;
      item.reference['digest'] = createHash('sha256')
        .update(bytes)
        .digest('hex');
      expect(() => readCsiPreparationEvidence(sample.response)).toThrow();
    },
  );

  it('refuses a coherent intent whose request digest differs from the original payload bytes', () => {
    const sample = csiHistoryPreparationFixture();
    const evidence = sample.response.evidence;
    const resources = evidence['resources'] as Array<{
      reference: Record<string, unknown>;
      bytesBase64: string;
    }>;
    const intent = resources.find(
      (item) => item.reference['resourceId'] === sample.intentRef.resourceId,
    )!;
    const body = JSON.parse(
      Buffer.from(intent.bytesBase64, 'base64').toString(),
    );
    const wrongDigest = `sha256:${'0'.repeat(64)}`;
    body.preparation.invocations[1].requestDigest = wrongDigest;
    (evidence['members'] as Array<Record<string, unknown>>)[1]['argsDigest'] =
      wrongDigest;
    const bytes = Buffer.from(JSON.stringify(body));
    intent.bytesBase64 = bytes.toString('base64');
    intent.reference['byteLength'] = bytes.length;
    intent.reference['digest'] = createHash('sha256')
      .update(bytes)
      .digest('hex');
    evidence['intentRef'] = intent.reference;
    const request = readCsiNativeRequest({
      ...sample.request,
      subject: intent.reference,
    });
    const response = readCsiNativeResponse(sample.response, request);
    expect(() => readCsiPreparationEvidence(response)).toThrow();
  });
});
