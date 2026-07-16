/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createExtensionPairingManager,
  type ExtensionPairingManager,
} from './extension-pairing.js';

const CHALLENGE = 'A'.repeat(43);

function pairingProof(
  code: string,
  direction: 'client' | 'server' | 'credential',
  pairingNonce: string,
  challenge: string,
  credentialId?: string,
): string {
  const suffix = credentialId ? `:${credentialId}` : '';
  return createHmac('sha256', createHash('sha256').update(code).digest())
    .update(
      `qwen-extension-pairing:${direction}:${pairingNonce}:${challenge}${suffix}`,
    )
    .digest('base64url');
}

function pairingRequest(
  manager: ExtensionPairingManager,
  code = manager.getDisplayCode(),
) {
  const status = manager.getStatus();
  if (status.paired) throw new Error('expected unpaired status');
  return {
    pairingNonce: status.pairingNonce,
    challenge: CHALLENGE,
    clientProof: pairingProof(code, 'client', status.pairingNonce, CHALLENGE),
  };
}

describe('createExtensionPairingManager', () => {
  it('generates high-entropy pairing material without exposing the code', () => {
    const manager = createExtensionPairingManager({
      now: () => 1_000,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });

    const status = manager.getStatus();

    expect(status.paired).toBe(false);
    if (status.paired) throw new Error('expected unpaired status');
    expect(status.expiresAt).toBe(601_000);
    expect(status.pairingNonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect('code' in status).toBe(false);
    expect(manager.getDisplayCode()).toMatch(
      /^(?:[0-9a-f]{4}-){7}[0-9a-f]{4}$/,
    );
  });

  it('rejects an invalid proof without receiving the pairing code', () => {
    const manager = createExtensionPairingManager({
      now: () => 1_000,
      randomBytes: (size) => Buffer.alloc(size, 2),
    });
    const request = pairingRequest(manager, '0000-0000-0000-0000');

    expect(JSON.stringify(request)).not.toContain(manager.getDisplayCode());
    expect(manager.confirm(request)).toEqual({
      ok: false,
      error: 'invalid_proof',
    });
    expect(manager.verifyCredential('anything')).toBe(false);
  });

  it('locks pairing after repeated invalid proofs', () => {
    let now = 1_000;
    const manager = createExtensionPairingManager({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 2),
    });
    const invalidRequest = pairingRequest(manager, 'wrong-code');

    for (let index = 0; index < 10; index++) {
      expect(manager.confirm(invalidRequest)).toEqual({
        ok: false,
        error: 'invalid_proof',
      });
    }
    expect(manager.confirm(pairingRequest(manager))).toEqual({
      ok: false,
      error: 'too_many_attempts',
    });

    now += 60_000;
    expect(manager.confirm(invalidRequest)).toEqual({
      ok: false,
      error: 'invalid_proof',
    });
  });

  it('rejects expired pairing material and rotates its nonce', () => {
    let now = 1_000;
    let randomValue = 1;
    const onCodeRotated = vi.fn();
    const manager = createExtensionPairingManager({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, randomValue++),
      onCodeRotated,
    });
    const request = pairingRequest(manager);
    const oldNonce = request.pairingNonce;

    now = 601_001;

    expect(manager.confirm(request)).toEqual({
      ok: false,
      error: 'expired_code',
    });
    const status = manager.getStatus();
    if (status.paired) throw new Error('expected unpaired status');
    expect(status.pairingNonce).not.toBe(oldNonce);
    expect(onCodeRotated).toHaveBeenCalledWith(
      manager.getDisplayCode(),
      1_201_001,
    );
  });

  it('mutually proves pairing and never transfers the credential secret', () => {
    let counter = 1;
    const manager = createExtensionPairingManager({
      now: () => 1_000,
      randomBytes: (size) => Buffer.alloc(size, counter++),
    });
    const code = manager.getDisplayCode();
    const request = pairingRequest(manager, code);

    const result = manager.confirm(request);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected pairing success');
    expect(result.credentialId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(result.proof).toBe(
      pairingProof(
        code,
        'server',
        request.pairingNonce,
        request.challenge,
        result.credentialId,
      ),
    );
    const credentialSecret = pairingProof(
      code,
      'credential',
      request.pairingNonce,
      request.challenge,
      result.credentialId,
    );
    const credential = `${result.credentialId}.${credentialSecret}`;
    expect(JSON.stringify(result)).not.toContain(credentialSecret);
    expect(manager.verifyCredential(credential)).toBe(true);
    expect(manager.verifyCredential(`${credential}x`)).toBe(false);
    expect(manager.getStatus()).toEqual({ paired: true });
    expect(manager.confirm(request)).toEqual({
      ok: false,
      error: 'already_paired',
    });

    const challenge = 'B'.repeat(43);
    const key = createHash('sha256').update(credentialSecret).digest();
    const expectedProof = createHmac('sha256', key)
      .update(`qwen-extension-daemon:${challenge}`)
      .digest('base64url');
    expect(
      manager.createVerificationProof(result.credentialId, challenge),
    ).toBe(expectedProof);
    expect(
      manager.createVerificationProof(result.credentialId, 'short'),
    ).toBeUndefined();
    expect(
      manager.createVerificationProof('unknown', challenge),
    ).toBeUndefined();
  });
});
