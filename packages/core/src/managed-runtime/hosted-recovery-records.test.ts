/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, it } from 'vitest';
import {
  hostedRecoveryReferences,
  parseHostedRecoveryResource,
} from './hosted-recovery-records.js';

const key = {
  tenantId: 'tenant',
  workspaceId: 'workspace',
  sessionId: 'session',
};
const ref = {
  resourceId: 'definition',
  kind: 'managed-definition',
  schemaVersion: 1,
  byteLength: 2,
  digest: 'a'.repeat(64),
};

it('follows only protocol reference slots, preserving arbitrary model and tool data', () => {
  const businessData = {
    resourceId: 'business',
    kind: 'business-record',
    schemaVersion: 1,
    byteLength: 12,
    digest: 'ordinary-user-digest',
  };
  expect(
    hostedRecoveryReferences({
      definitionRef: ref,
      prepared: {
        history: [{ parts: [{ functionCall: { args: businessData } }] }],
        request: { config: { tools: [businessData] } },
      },
      calls: [
        { call: { args: businessData }, inputRef: ref, definitionRef: ref },
      ],
    }),
  ).toEqual([ref]);
});

it('rejects malformed protocol references and conflicting reference metadata', () => {
  expect(() =>
    hostedRecoveryReferences({ definitionRef: { resourceId: 'missing' } }),
  ).toThrow();
  expect(() =>
    hostedRecoveryReferences({
      definitionRef: ref,
      rootSnapshotRef: { ...ref, byteLength: 3 },
    }),
  ).toThrow('conflict');
});

it.each([
  { ...key, sessionId: 'foreign' },
  { ...key, tenantId: 'foreign' },
])('rejects recovery resources naming a foreign scope', (sessionKey) => {
  expect(() =>
    parseHostedRecoveryResource(
      Buffer.from(JSON.stringify({ v: 1, sessionKey, promptId: 'prompt' })),
      key,
    ),
  ).toThrow('another Session');
});
