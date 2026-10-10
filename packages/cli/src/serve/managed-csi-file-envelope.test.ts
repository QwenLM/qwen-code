/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createManagedCsiFileAttestationRequest,
  createManagedCsiFileReady,
  parseManagedCsiFileBoot,
  parseManagedCsiFileJson,
  readManagedCsiFileContext,
  readManagedCsiFileDrain,
  readManagedCsiNativeAuthority,
  validateManagedCsiFileAttestationResponse,
  wrapManagedCsiFileContext,
} from './managed-csi-file-envelope.js';
import {
  parseManagedCsiBoot,
  type ManagedCsiPodIdentity,
} from './managed-csi-envelope.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('./contracts/managed-csi-files-v2.fixtures.json', import.meta.url),
    'utf8',
  ),
) as {
  boot: unknown;
  ready: unknown;
  executionBoot5: unknown;
  executionReady5: unknown;
  validAuthorityOrigins: string[];
  invalidAuthorityOrigins: string[];
  expectedPod: ManagedCsiPodIdentity;
  attestationRequest: unknown;
  attestationResponse: Record<string, unknown>;
  contextAttestationRequest: { context: unknown };
  drainRequest: unknown;
  invalidJson: string[];
};

describe('closed CSI file construction contract', () => {
  it('retains the boot5 authority without exposing it in readiness or changing CSI2 attestation', () => {
    const boot = parseManagedCsiFileBoot(fixture.executionBoot5);
    expect(boot.version).toBe(5);
    expect(createManagedCsiFileReady(boot, 43190)).toEqual(
      fixture.executionReady5,
    );
    expect(createManagedCsiFileAttestationRequest(boot)).toEqual(
      fixture.attestationRequest,
    );
    validateManagedCsiFileAttestationResponse(
      fixture.attestationResponse,
      boot,
      fixture.expectedPod,
    );
    if (boot.version !== 5) throw new Error('Expected boot5');
    expect(Object.isFrozen(boot.authority)).toBe(true);
    for (const authority of [
      undefined,
      {},
      { ...boot.authority, token: 'foreign' },
      { ...boot.authority, protocolVersion: 2 },
      { ...boot.authority, origin: null },
    ])
      expect(() => parseManagedCsiFileBoot({ ...boot, authority })).toThrow();
    expect(() => parseManagedCsiFileBoot({ ...boot, version: 4 })).toThrow();
    expect(() =>
      parseManagedCsiFileBoot({ ...(fixture.boot as object), version: 5 }),
    ).toThrow();
    expect(() => parseManagedCsiBoot(boot)).toThrow();
  });

  it.each(fixture.validAuthorityOrigins)(
    'accepts the canonical authority origin %s',
    (origin) => {
      expect(
        readManagedCsiNativeAuthority({ protocolVersion: 1, origin }),
      ).toEqual({ protocolVersion: 1, origin });
    },
  );

  it.each(fixture.invalidAuthorityOrigins)(
    'refuses the noncanonical authority origin %s',
    (origin) => {
      expect(() =>
        readManagedCsiNativeAuthority({ protocolVersion: 1, origin }),
      ).toThrow();
    },
  );

  it('matches the paired Java producer fixture without broadening legacy boot', () => {
    const boot = parseManagedCsiFileBoot(fixture.boot);
    expect(createManagedCsiFileReady(boot, 43190)).toEqual(fixture.ready);
    expect(createManagedCsiFileAttestationRequest(boot)).toEqual(
      fixture.attestationRequest,
    );
    validateManagedCsiFileAttestationResponse(
      fixture.attestationResponse,
      boot,
      fixture.expectedPod,
    );
    expect(
      readManagedCsiFileDrain(fixture.drainRequest, boot, fixture.expectedPod),
    ).toEqual({
      operation: 'seal',
      retirementId: 'd911c54f-ad76-420f-8c76-fb124c0ce623',
    });
    expect(
      wrapManagedCsiFileContext(
        boot,
        readManagedCsiFileContext(fixture.contextAttestationRequest, boot),
      ),
    ).toEqual(fixture.contextAttestationRequest);
    expect(() => parseManagedCsiBoot(boot)).toThrow();
    expect(Object.isFrozen(boot.identity)).toBe(true);
  });

  it.each(['type', 'version', 'managedCsi', 'identity', 'context', 'storage'])(
    'refuses missing %s and unknown outer keys',
    (key) => {
      const boot = { ...parseManagedCsiFileBoot(fixture.boot) } as Record<
        string,
        unknown
      >;
      delete boot[key];
      expect(() => parseManagedCsiFileBoot(boot)).toThrow();
      expect(() =>
        parseManagedCsiFileBoot({ ...(fixture.boot as object), extra: true }),
      ).toThrow();
    },
  );

  it('refuses crossed profile, Session, context and physical identity', () => {
    const boot = parseManagedCsiFileBoot(fixture.boot);
    for (const identity of [
      { ...boot.identity, profile: 'other' },
      { ...boot.identity, extra: true },
      { ...boot.identity, sessionId: 'not-a-uuid' },
      { ...boot.identity, sessionId: 'C911c54f-ad76-420f-8c76-fb124c0ce623' },
      { ...boot.identity, capabilityDigest: `sha256:${'a'.repeat(64)}` },
    ]) {
      expect(() => parseManagedCsiFileBoot({ ...boot, identity })).toThrow();
    }
    for (const context of [
      { ...boot.context, isolationClass: 'workspace' },
      { ...boot.context, capabilityDigest: `sha256:${'a'.repeat(64)}` },
    ])
      expect(() => parseManagedCsiFileBoot({ ...boot, context })).toThrow();
    expect(() =>
      readManagedCsiFileContext(
        {
          ...fixture.contextAttestationRequest,
          identity: {
            ...boot.identity,
            sessionId: 'd911c54f-ad76-420f-8c76-fb124c0ce623',
          },
        },
        boot,
      ),
    ).toThrow();
    expect(() =>
      validateManagedCsiFileAttestationResponse(
        {
          ...fixture.attestationResponse,
          storage: { ...boot.storage, pvcUid: 'foreign' },
        },
        boot,
        fixture.expectedPod,
      ),
    ).toThrow();
    expect(() =>
      validateManagedCsiFileAttestationResponse(
        { ...fixture.attestationResponse, token: boot.context.token },
        boot,
        fixture.expectedPod,
      ),
    ).toThrow();
  });

  it.each(fixture.invalidJson)(
    'refuses noncanonical or ambiguous wire JSON %s',
    (text) => {
      expect(() => parseManagedCsiFileJson(Buffer.from(text), 32768)).toThrow();
    },
  );

  it('refuses invalid UTF-8 and size overflow, allowing zero native counts', () => {
    expect(() => parseManagedCsiFileJson(Buffer.from([0xff]), 32768)).toThrow();
    expect(() => parseManagedCsiFileJson(Buffer.from('{}'), 1)).toThrow();
    expect(
      parseManagedCsiFileJson(Buffer.from('{"pendingStarts":0}'), 32768),
    ).toEqual({ pendingStarts: 0 });
  });
});
