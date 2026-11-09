/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';

// Matches the private authority manifest proposed in #13526. Only the
// dedicated container worker may accept this composition.
export const CSI_FILES_RETIREMENT_CAPABILITY_DIGEST =
  'sha256:116dcd2afce7292bdf0bf4c76010964f7a7148ad512b2939e48e3d55ea91118d';
export const CSI_FILES_DIAGNOSTICS_CAPABILITY_DIGEST =
  'sha256:e973d9401c00a917e8b3de2d8fd63a0d1b09e3c4407aecf64826cdfff6c1c321';

export function isCsiFilesCapability(digest: unknown): boolean {
  return (
    digest === CSI_FILES_RETIREMENT_CAPABILITY_DIGEST ||
    digest === CSI_FILES_DIAGNOSTICS_CAPABILITY_DIGEST
  );
}

export type CsiFilesProfile =
  | 'csi-files-retirement/1'
  | 'csi-files-retirement/2';

const sessionProfiles = new WeakMap<
  ManagedSession['authority'],
  CsiFilesProfile
>();

export async function readHostedCsiFileProfile(
  session: ManagedSession,
): Promise<CsiFilesProfile> {
  const saved = sessionProfiles.get(session.authority);
  if (saved) return saved;
  const definition = JSON.parse(
    (
      await session.resources.read(
        session.authority.sessionHeader.definitionRef,
      )
    ).toString('utf8'),
  ) as { toolProfile?: unknown };
  const profile = definition.toolProfile;
  if (
    profile !== 'csi-files-retirement/1' &&
    profile !== 'csi-files-retirement/2'
  )
    throw new Error('Invalid CSI Session profile.');
  sessionProfiles.set(session.authority, profile);
  return profile;
}

export function matchesCsiFilesProfile(
  profile: unknown,
  capabilityDigest: unknown,
): boolean {
  return (
    (profile === 'csi-files-retirement/1' &&
      capabilityDigest === CSI_FILES_RETIREMENT_CAPABILITY_DIGEST) ||
    (profile === 'csi-files-retirement/2' &&
      capabilityDigest === CSI_FILES_DIAGNOSTICS_CAPABILITY_DIGEST)
  );
}
