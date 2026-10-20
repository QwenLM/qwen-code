/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseManagedCsiFileBoot } from './managed-csi-file-envelope.js';
import {
  csiFileFinalizeRequest,
  csiFinalizationDigest,
  readCsiFileFinalizeRequest,
  requireSavedCsiApplicationCut,
} from './managed-csi-file-finalize-protocol.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('./contracts/managed-csi-files-v2.fixtures.json', import.meta.url),
    'utf8',
  ),
);
const boot = parseManagedCsiFileBoot(fixture.finalizationBoot6);
const installed = fixture.installationRequest.context;
const pod = fixture.expectedPod;
const mount = fixture.attestationResponse.mount;
const operation = {
  operation: 'observe' as const,
  retirementId: 'e911c54f-ad76-420f-8c76-fb124c0ce623',
  preparedCommitSha256: 'a'.repeat(64),
  frozenRequestSha256: null,
  cutSha256: null,
};
const request = () =>
  csiFileFinalizeRequest(boot, installed, pod, mount, operation);
const finalRequest = () =>
  csiFileFinalizeRequest(boot, installed, pod, mount, {
    ...operation,
    operation: 'finalize',
    frozenRequestSha256: 'b'.repeat(64),
    cutSha256: 'c'.repeat(64),
  });

afterEach(() => vi.unstubAllGlobals());

describe('original CSI file finalization protocol', () => {
  it('shares exact request and canonical digest fixtures with the Java consumer', () => {
    const shared = JSON.parse(
      readFileSync(
        new URL(
          './contracts/managed-csi-file-finalize-v1.fixtures.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    for (const action of ['observe', 'finalize']) {
      const original = shared[action];
      expect(
        csiFileFinalizeRequest(
          boot,
          original.installedContext,
          pod,
          mount,
          original,
        ),
      ).toEqual(original);
      expect(csiFinalizationDigest(original)).toBe(
        shared[`${action}CanonicalSha256`],
      );
    }
  });

  it('pins the original boot and accepts only the complete exact request', () => {
    const original = request();
    expect(
      readCsiFileFinalizeRequest(original, boot, installed, pod, mount),
    ).toEqual(original);
    for (const key of Object.keys(original)) {
      const missing = { ...original } as Record<string, unknown>;
      delete missing[key];
      expect(() =>
        readCsiFileFinalizeRequest(missing, boot, installed, pod, mount),
      ).toThrow();
    }
    for (const crossed of [
      { ...original, extra: true },
      { ...original, bootSha256: 'd'.repeat(64) },
      { ...original, identity: { ...original.identity, sessionId: 'foreign' } },
      {
        ...original,
        installedContext: { ...installed, contextDigest: 'other' },
      },
      { ...original, pod: { ...pod, uid: 'replacement' } },
      { ...original, mount: { ...mount, device: 'other' } },
      { ...original, frozenRequestSha256: 'b'.repeat(64) },
      { ...original, operation: 'finalize' },
      { ...finalRequest(), cutSha256: null },
      { ...original, preparedCommitSha256: 'A'.repeat(64) },
      { ...original, retirementId: 'not-a-uuid' },
      { ...original, retirementId: [original.retirementId] },
      { ...original, preparedCommitSha256: [original.preparedCommitSha256] },
      { ...finalRequest(), frozenRequestSha256: ['b'.repeat(64)] },
      { ...finalRequest(), cutSha256: ['c'.repeat(64)] },
    ])
      expect(() =>
        readCsiFileFinalizeRequest(crossed, boot, installed, pod, mount),
      ).toThrow();
    for (const oldBoot of [fixture.boot, fixture.executionBoot5])
      expect(() =>
        csiFileFinalizeRequest(
          parseManagedCsiFileBoot(oldBoot),
          installed,
          pod,
          mount,
          operation,
        ),
      ).toThrow('original worker does not support');
  });

  it('hashes sorted JSON fields while preserving array order and values', () => {
    expect(csiFinalizationDigest({ z: [2, 1], a: { y: null, x: 'é' } })).toBe(
      createHash('sha256')
        .update('{"a":{"x":"é","y":null},"z":[2,1]}')
        .digest('hex'),
    );
    expect(csiFinalizationDigest({ a: 1, b: 2 })).toBe(
      csiFinalizationDigest({ b: 2, a: 1 }),
    );
    expect(csiFinalizationDigest([1, 2])).not.toBe(
      csiFinalizationDigest([2, 1]),
    );
    expect(() => csiFinalizationDigest(undefined)).toThrow();
  });

  it('uses the original authority and checks every saved cut field', async () => {
    const final = finalRequest();
    const observationHash = 'd'.repeat(64);
    const authority = {
      format: 'qwen-csi-application-cut-authority/1',
      retirementId: final.retirementId,
      preparedCommitSha256: final.preparedCommitSha256,
      frozenRequestSha256: final.frozenRequestSha256,
      cutSha256: final.cutSha256,
      preCutObservationSha256: observationHash,
      workerRequestSha256: csiFinalizationDigest(final),
    };
    const response = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/json',
        },
      });
    const fetcher = vi.fn().mockResolvedValue(response(authority));
    vi.stubGlobal('fetch', fetcher);
    await requireSavedCsiApplicationCut(boot, final, observationHash);
    if (boot.version !== 6) throw new Error('Expected boot6 fixture');
    expect(fetcher).toHaveBeenCalledWith(
      `${boot.authority.origin}/internal/managed-session-store/v1/sessions/${boot.identity.sessionId}/csi-retirement:worker-authority`,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify(final),
        headers: expect.objectContaining({
          authorization: `Bearer ${boot.context.token}`,
          'X-Qwen-Tenant-Id': boot.context.tenantId,
        }),
      }),
    );
    for (const key of Object.keys(authority)) {
      fetcher.mockResolvedValueOnce(response({ ...authority, [key]: 'other' }));
      await expect(
        requireSavedCsiApplicationCut(boot, final, observationHash),
      ).rejects.toThrow('Saved original CSI cut conflicts');
    }
    for (const bad of [
      response({ ...authority, extra: true }),
      response(authority, 409),
      new Response(JSON.stringify(authority)),
      response({ huge: 'x'.repeat(16 * 1024) }),
      new Response('{"format":"a","format":"b"}', {
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/json',
        },
      }),
    ]) {
      fetcher.mockResolvedValueOnce(bad);
      await expect(
        requireSavedCsiApplicationCut(boot, final, observationHash),
      ).rejects.toThrow();
    }
  });
});
