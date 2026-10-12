/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  parseHostedAgentDefinition,
  readHostedAgentInstructions,
  sameHostedAgentDefinition,
} from './hosted-agent-definition.js';

const identity = {
  agentId: `agent_${'a'.repeat(32)}`,
  revision: '1',
  digest: 'b'.repeat(64),
};

it('keeps execution settings on create and accepts only the fixed identity on load', () => {
  const saved = parseHostedAgentDefinition({
    ...identity,
    model: { id: 'configured' },
  });
  expect(saved?.model?.id).toBe('configured');
  expect(
    sameHostedAgentDefinition(
      saved,
      parseHostedAgentDefinition(identity, false),
    ),
  ).toBe(true);
  expect(sameHostedAgentDefinition(saved, undefined)).toBe(false);
  expect(sameHostedAgentDefinition(saved, { ...identity, revision: '2' })).toBe(
    false,
  );
  expect(() =>
    parseHostedAgentDefinition({ ...identity, model: { id: 'other' } }, false),
  ).toThrow();
  expect(() =>
    parseHostedAgentDefinition({ ...identity, instructions: 'inline' }),
  ).toThrow();
});

it('checks instruction bytes and UTF-8 before returning the pinned section', async () => {
  const bytes = Buffer.from('Agent instruction 界');
  const ref = {
    resourceId: 'instructions',
    kind: 'managed-agent-instructions',
    schemaVersion: 1,
    byteLength: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
  const pin = parseHostedAgentDefinition({ ...identity, instructionsRef: ref });
  expect(
    await readHostedAgentInstructions(pin, { read: async () => bytes }),
  ).toBe(bytes.toString());
  await expect(
    readHostedAgentInstructions(pin, {
      read: async () => Buffer.alloc(bytes.length),
    }),
  ).rejects.toThrow();
  const invalid = Buffer.from([0xff]);
  const invalidPin = parseHostedAgentDefinition({
    ...identity,
    instructionsRef: {
      ...ref,
      byteLength: 1,
      digest: createHash('sha256').update(invalid).digest('hex'),
    },
  });
  await expect(
    readHostedAgentInstructions(invalidPin, { read: async () => invalid }),
  ).rejects.toThrow();
  expect(() =>
    parseHostedAgentDefinition({
      ...identity,
      instructionsRef: { ...ref, byteLength: 65537 },
    }),
  ).toThrow();
});
