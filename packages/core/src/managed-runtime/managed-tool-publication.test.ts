/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
// eslint-disable-next-line import/no-internal-modules
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  assertToolPublicationPayload,
  createToolPublicationToken,
  parseToolPublicationBinding,
  parseToolPublicationBytes,
  parseToolPublicationGrant,
  parseToolPublicationRequest,
  toolPublicationBindingDigest,
  toolPublicationManifestIdentity,
} from './managed-tool-publication.js';

const fixtures = JSON.parse(
  fs.readFileSync(
    new URL(
      './contracts/managed-tool-publication-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  payloadJson: string;
  digestVectors: Array<{ id: string; binding: unknown; digest: string }>;
  tokenVector: { token: string; hash: string };
  bindingDigest: string;
  cases: Array<{
    id: string;
    kind: 'binding' | 'request' | 'grant';
    value: unknown;
    valid: boolean;
    schemaValid: boolean;
  }>;
};
const schema = JSON.parse(
  fs.readFileSync(
    new URL(
      './contracts/managed-tool-publication-v1.schema.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const parsers = {
  binding: parseToolPublicationBinding,
  request: parseToolPublicationRequest,
  grant: parseToolPublicationGrant,
};

describe('managed-tool-publication/1', () => {
  const ajv = new Ajv2020({ strict: true });
  ajv.addSchema(schema, 'publication');
  for (const example of fixtures.cases) {
    it(`${example.id}`, () => {
      const validate = ajv.getSchema(`publication#/$defs/${example.kind}`)!;
      expect(validate(example.value)).toBe(example.schemaValid);
      const parse = () => parsers[example.kind](example.value);
      if (example.valid) expect(parse).not.toThrow();
      else expect(parse).toThrow();
    });
  }

  it('matches independent Unicode, key-order and integer digest vectors', () => {
    for (const vector of fixtures.digestVectors) {
      expect(
        toolPublicationBindingDigest(
          parseToolPublicationBinding(vector.binding),
        ),
      ).toBe(vector.digest);
    }
    expect(
      createHash('sha256').update(fixtures.tokenVector.token).digest('hex'),
    ).toBe(fixtures.tokenVector.hash);
  });

  it('keeps original Runtime identity and both digests separate from model pairing', () => {
    const binding = parseToolPublicationBinding(fixtures.cases[0].value);
    expect(binding.modelCallId).not.toBe(binding.reference.callId);
    expect(binding.requestDigest).not.toBe(binding.reference.argsDigest);
    expect(toolPublicationBindingDigest(binding)).toBe(fixtures.bindingDigest);
    expect(toolPublicationManifestIdentity(binding)).toMatchObject({
      callId: binding.reference.callId,
      invocationDigest: binding.reference.argsDigest,
      sessionId: binding.sessionKey.sessionId,
    });
    expect(() =>
      assertToolPublicationPayload(binding, fixtures.payloadJson),
    ).not.toThrow();
    const spaced = ` ${fixtures.payloadJson}`;
    expect(() => assertToolPublicationPayload(binding, spaced)).toThrow();
    const changed = {
      ...binding,
      requestDigest: `sha256:${createHash('sha256').update(spaced).digest('hex')}`,
    };
    expect(() => assertToolPublicationPayload(changed, spaced)).not.toThrow();
    const invalidInput = { command: 'printf hi', timeout: 0 };
    const invalidPayload = JSON.stringify({
      toolName: 'run_shell_command',
      input: invalidInput,
    });
    expect(() =>
      assertToolPublicationPayload(
        {
          ...binding,
          requestDigest: `sha256:${createHash('sha256').update(invalidPayload).digest('hex')}`,
          reference: {
            ...binding.reference,
            argsDigest: `sha256:${createHash('sha256').update(JSON.stringify(invalidInput)).digest('hex')}`,
          },
        },
        invalidPayload,
      ),
    ).toThrow();
    expect(() =>
      assertToolPublicationPayload(
        {
          ...binding,
          reference: {
            ...binding.reference,
            argsDigest: `sha256:${'0'.repeat(64)}`,
          },
        },
        fixtures.payloadJson,
      ),
    ).toThrow();
  });

  it('rejects invalid UTF-8, duplicate fields and oversized wire bodies', () => {
    expect(() =>
      parseToolPublicationBytes('binding', Buffer.from([0xff])),
    ).toThrow();
    expect(() =>
      parseToolPublicationBytes(
        'binding',
        Buffer.from('{"publication":1,"publication":2}'),
      ),
    ).toThrow();
    expect(() =>
      parseToolPublicationBytes('binding', Buffer.alloc(65537, 32)),
    ).toThrow();
    const input = fixtures.cases[0].value;
    expect(
      parseToolPublicationBytes('binding', Buffer.from(JSON.stringify(input))),
    ).toEqual(parseToolPublicationBinding(input));
  });

  it('returns a detached snapshot and generates a separate 256-bit secret', () => {
    const input = structuredClone(fixtures.cases[0].value) as {
      reference: { callId: string };
    };
    const parsed = parseToolPublicationBinding(input);
    input.reference.callId = 'changed';
    expect(parsed.reference.callId).toBe('runtime-call-uuid');
    const first = createToolPublicationToken();
    expect(Buffer.from(first, 'base64url')).toHaveLength(32);
    expect(first).not.toBe(createToolPublicationToken());
  });
});
