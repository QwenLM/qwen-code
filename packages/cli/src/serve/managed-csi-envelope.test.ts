/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_CSI_ATTEST_PATH,
  MANAGED_CSI_ACK_PATH,
  MANAGED_CSI_WORKER_ACK_PROTOCOL,
  ManagedCsiAckRequestError,
  parseManagedCsiAckRequest,
  parseManagedCsiAckJson,
  parseManagedCsiAckResponse,
  type ManagedCsiAckRequest,
  type ManagedCsiAckResponse,
  MANAGED_CSI_PROTOCOL,
  parseManagedCsiBoot,
  createManagedCsiAttestationRequest,
  validateManagedCsiAttestationRequest,
  validateManagedCsiAttestationResponse,
  type ManagedCsiPodIdentity,
} from './managed-csi-envelope.js';
import { parseManagedContextBoot } from './managed-context-envelope.js';

const fixtures = JSON.parse(
  readFileSync(
    new URL('./contracts/managed-csi-v1.fixtures.json', import.meta.url),
    'utf8',
  ),
) as {
  managedCsi: string;
  attestPath: string;
  boot: unknown;
  bootCases: Array<{ id: string; boot: unknown; valid: boolean }>;
  attestationRequest: unknown;
  expectedPod: ManagedCsiPodIdentity;
  requestCases: Array<{ id: string; request: unknown; valid: boolean }>;
  responseCases: Array<{ id: string; response: unknown; valid: boolean }>;
};

describe('managed-csi/1 closed control envelope', () => {
  it('pins its versioned route independently of managed-context/1', () => {
    expect(fixtures.managedCsi).toBe(MANAGED_CSI_PROTOCOL);
    expect(fixtures.attestPath).toBe(MANAGED_CSI_ATTEST_PATH);
    const boot = parseManagedCsiBoot(fixtures.boot);
    expect(boot.version).toBe(3);
    expect(parseManagedContextBoot(boot.context)).toEqual(boot.context);
    expect(() => parseManagedContextBoot(boot)).toThrow();
    expect(Object.isFrozen(boot.storage)).toBe(true);
    expect(Object.isFrozen(boot.context)).toBe(true);
  });

  it.each(fixtures.bootCases)('$id', (fixture) => {
    if (fixture.valid) {
      expect(parseManagedCsiBoot(fixture.boot)).toEqual(fixture.boot);
    } else {
      expect(() => parseManagedCsiBoot(fixture.boot)).toThrow(
        'Managed CSI boot document is invalid.',
      );
    }
  });

  it('creates the exact independent reservation request fixture', () => {
    expect(
      createManagedCsiAttestationRequest(parseManagedCsiBoot(fixtures.boot)),
    ).toEqual(fixtures.attestationRequest);
  });

  it.each(fixtures.requestCases)('$id', (fixture) => {
    const verify = () =>
      validateManagedCsiAttestationRequest(
        fixture.request,
        parseManagedCsiBoot(fixtures.boot),
      );
    if (fixture.valid) expect(verify).not.toThrow();
    else expect(verify).toThrow('Managed CSI attestation request is invalid.');
  });

  it.each(fixtures.responseCases)('$id', (fixture) => {
    const verify = () =>
      validateManagedCsiAttestationResponse(
        fixture.response,
        parseManagedCsiBoot(fixtures.boot),
        fixtures.expectedPod,
      );
    if (fixture.valid) expect(verify).not.toThrow();
    else expect(verify).toThrow('Managed CSI attestation response is invalid.');
  });
});

const ackFixtures = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-csi-worker-ack-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  ackPath: string;
  workerAck: string;
  boot: unknown;
  expectedPod: ManagedCsiPodIdentity;
  request: ManagedCsiAckRequest;
  response: ManagedCsiAckResponse;
};

function changedAck(
  value: unknown,
  path: string,
  replacement: unknown,
): unknown {
  const copy = structuredClone(value) as Record<string, unknown>;
  const parts = path.split('.');
  let at = copy;
  for (const key of parts.slice(0, -1)) at = at[key] as Record<string, unknown>;
  at[parts.at(-1)!] = replacement;
  return copy;
}

describe('closed original CSI worker ACK envelope', () => {
  const boot = parseManagedCsiBoot(ackFixtures.boot);
  const parse = (value: unknown) =>
    parseManagedCsiAckRequest(value, boot, ackFixtures.expectedPod);
  it('accepts the bounded shared fixture with distinct Runtime and Harness Sessions', () => {
    expect(ackFixtures.ackPath).toBe(MANAGED_CSI_ACK_PATH);
    expect(ackFixtures.workerAck).toBe(MANAGED_CSI_WORKER_ACK_PROTOCOL);
    expect(parse(ackFixtures.request)).toEqual(ackFixtures.request);
    expect(
      parseManagedCsiAckResponse(
        ackFixtures.response,
        boot,
        ackFixtures.expectedPod,
      ),
    ).toEqual(ackFixtures.response);
    expect(ackFixtures.request.reference.sessionId).not.toBe(
      ackFixtures.response.captureIdentity.sessionId,
    );
    expect(ackFixtures.request.reference.promptId).not.toBe(
      ackFixtures.response.captureIdentity.turnId,
    );
    expect(
      Buffer.byteLength(JSON.stringify(ackFixtures.response)),
    ).toBeLessThan(16 * 1024);
  });
  it.each([
    ['extra', true, 400],
    ['retirementId', 'NOT-UUID', 400],
    ['workerAck', 'managed-csi-original-worker-ack/2', 409],
    ['protocolVersion', 2, 409],
    ['context.token', 'must-not-be-accepted', 400],
    ['context.runtimeIncarnation', 'replacement', 409],
    ['storage.reservationRevision', '2', 409],
    ['pod.uid', '11111111-2222-3333-4444-555555555556', 409],
    ['reference.extra', true, 400],
    ['reference.sessionId', 'e\u0301', 400],
    ['reference.promptId', '\ud800', 400],
    ['reference.callId', 'bad\n', 400],
    ['reference.callId', 'é'.repeat(257), 400],
    ['reference.argsDigest', 'a'.repeat(63), 400],
    ['acknowledgement.extra', true, 400],
    ['acknowledgement.executionCallId', '', 400],
    ['acknowledgement.deliveryStatus', 'blocked', 400],
    ['acknowledgement.historyRevision', null, 400],
    ['acknowledgement.historyRevision', 0, 400],
    ['acknowledgement.historyRevision', 1.5, 400],
    ['acknowledgement.historyRevision', Number.MAX_SAFE_INTEGER + 1, 400],
    ['acknowledgement.manifest', null, 400],
    ['acknowledgement.manifest.extra', true, 400],
    ['acknowledgement.manifest.kind', 'managed-checkpoint', 400],
    ['acknowledgement.manifest.schemaVersion', 2, 400],
    ['acknowledgement.manifest.byteLength', 0, 400],
    ['acknowledgement.manifest.byteLength', 65537, 400],
    ['acknowledgement.manifest.digest', 'sha256:' + 'b'.repeat(64), 400],
  ] as const)('rejects %s before ACK mutation', (path, value, status) => {
    try {
      parse(changedAck(ackFixtures.request, path, value));
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ManagedCsiAckRequestError);
      expect((error as ManagedCsiAckRequestError).status).toBe(status);
    }
  });
  it('requires every original request field and returns independent closed copies', () => {
    for (const key of Object.keys(ackFixtures.request)) {
      const copy = { ...ackFixtures.request } as Record<string, unknown>;
      delete copy[key];
      expect(() => parse(copy)).toThrow(ManagedCsiAckRequestError);
    }
    const actual = parse(ackFixtures.request);
    expect(actual.reference).not.toBe(ackFixtures.request.reference);
    expect(actual.acknowledgement.manifest).not.toBe(
      ackFixtures.request.acknowledgement.manifest,
    );
    expect(actual.storage).not.toBe(ackFixtures.request.storage);
    expect(actual.pod).not.toBe(ackFixtures.request.pod);
  });
  it('accepts property-order-independent copies and positive safe receipt sequences', () => {
    const reordered = Object.fromEntries(
      Object.entries(ackFixtures.request).reverse(),
    );
    expect(parse(reordered)).toEqual(ackFixtures.request);
    expect(
      parse(
        changedAck(
          ackFixtures.request,
          'acknowledgement.historyRevision',
          Number.MAX_SAFE_INTEGER,
        ),
      ).acknowledgement.historyRevision,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each([
    ['extra', true],
    ['state', 'DRAINED'],
    ['captureIdentity.extra', true],
    ['captureIdentity.tenantId', 'other'],
    ['captureIdentity.callId', 'other'],
    ['captureIdentity.executionCallId', 'other'],
    ['captureIdentity.invocationDigest', 'c'.repeat(64)],
    ['captureIdentity.bindingGeneration', '09'],
    ['captureIdentity.bindingGeneration', '9223372036854775808'],
    ['captureIdentity.revision', 2],
    ['captureIdentity.captureId', 'Capture-A'],
    ['captureIdentity.sessionId', 'e\u0301'],
    ['captureIdentity.turnId', '\ud800'],
  ])('rejects a crossed or malformed positive response %s', (path, value) => {
    expect(() =>
      parseManagedCsiAckResponse(
        changedAck(ackFixtures.response, path, value),
        boot,
        ackFixtures.expectedPod,
      ),
    ).toThrow(ManagedCsiAckRequestError);
  });
});

describe('CSI ACK strict raw JSON', () => {
  it('accepts canonical integer JSON emitted by the original client', () => {
    expect(
      parseManagedCsiAckJson(Buffer.from(JSON.stringify(ackFixtures.request))),
    ).toEqual(ackFixtures.request);
  });
  it.each(['1.0000000000000001', '1.0', '1e0', '0', '-0', '-1'])(
    'refuses raw noncanonical numeric literal %s',
    (number) => {
      expect(() =>
        parseManagedCsiAckJson(Buffer.from('{"counter":' + number + '}')),
      ).toThrow();
    },
  );
  it('rejects invalid UTF8, duplicate escaped keys and bytes beyond the fixed bound', () => {
    expect(() =>
      parseManagedCsiAckJson(
        Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
      ),
    ).toThrow();
    expect(() =>
      parseManagedCsiAckJson(Buffer.from('{"x":1,"\\u0078":1}')),
    ).toThrow();
    expect(() =>
      parseManagedCsiAckJson(
        Buffer.from(
          JSON.stringify(ackFixtures.request) + ' '.repeat(16 * 1024),
        ),
      ),
    ).toThrow();
  });
});
