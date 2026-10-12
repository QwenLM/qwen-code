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
  payloadCases: Array<{
    id: string;
    payloadJson: string;
    requestDigest: string;
    argsDigest: string;
  }>;
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

  it('admits H3 background Shell and Monitor payloads', () => {
    for (const vector of fixtures.payloadCases) {
      const binding = {
        ...parseToolPublicationBinding(fixtures.cases[0].value),
        requestDigest: vector.requestDigest,
        reference: {
          ...parseToolPublicationBinding(fixtures.cases[0].value).reference,
          argsDigest: vector.argsDigest,
        },
      };
      expect(() =>
        assertToolPublicationPayload(binding, vector.payloadJson),
      ).not.toThrow();
    }
  });

  it('rejects out-of-shape H3 payloads with correct digest pins', () => {
    const base = parseToolPublicationBinding(fixtures.cases[0].value);
    const rejected: Array<[string, string, string]> = [
      // unknown tool family
      [
        '{"toolName":"write_file","input":{"command":"x"}}',
        'sha256:411f38324b9bf797e7ecf5976730ec141d9e12be2d19532c4ba516090e2e4b62',
        'sha256:cf35b664f0e85cbf24dfda38ea6991fa01d9d315e402baacd2c02f2e92d0947a',
      ],
      // background flag must be boolean
      [
        '{"toolName":"run_shell_command","input":{"command":"x","is_background":"yes"}}',
        'sha256:602898b4332eb8b28dda69a40d2b3624b9d07f6593b749f1afca9c693ce51894',
        'sha256:0d22e860fb36fbd030c30ca0caebad9443183694f0e1412d2b11caf550b8571a',
      ],
      // unknown shell input field
      [
        '{"toolName":"run_shell_command","input":{"command":"x","shell":"bash"}}',
        'sha256:16125fd18f6212ddd9f0ed835e7929fa1dbc285caa632b3c34587d6cce2a6f7c',
        'sha256:5162d0ee563de930a07dfff0db15a2166cab390b7e8d45abee7248c939270e23',
      ],
      // monitor bounds come from the turn's admission clamps
      [
        '{"toolName":"monitor","input":{"command":"x","max_events":0}}',
        'sha256:ea611ecaec0e65dc3449c8645d53242aafc21e7448527d524dcc86a1d7cf917c',
        'sha256:8a87c588c0954e5046351b49417b4fa6de1ebd57de491a8fa211dd6e3e8c90dc',
      ],
      [
        '{"toolName":"monitor","input":{"command":"x","max_events":10001}}',
        'sha256:a3f1f57ac064649e969f919c14e946d7c955a9d4b6a2a4597222cad1a0994ed7',
        'sha256:0d6eb0575da8c48def8e0fbaf23f2223b748512b45468a10d7daa763669700cf',
      ],
      [
        '{"toolName":"monitor","input":{"command":"x","idle_timeout_ms":600001}}',
        'sha256:8e42f98c8b03da607acd129b9a80181b250531d42db85100688f01d3491e260f',
        'sha256:2b13f3ea4fc3d2e07a02dfc1937306298812f7c8700b5e0d7a9106d911bcac0b',
      ],
    ];
    for (const [payloadJson, requestDigest, argsDigest] of rejected) {
      expect(() =>
        assertToolPublicationPayload(
          {
            ...base,
            requestDigest,
            reference: { ...base.reference, argsDigest },
          },
          payloadJson,
        ),
      ).toThrow();
    }
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
