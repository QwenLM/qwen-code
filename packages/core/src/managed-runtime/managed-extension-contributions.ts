/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ManagedPackageContributions } from '../extension/managed-package.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

const PART_BYTES = 64 * 1024;
const MAX_BYTES = 2 * 1024 * 1024;

export async function publishManagedExtensionContributions(
  resources: Pick<ManagedSessionResourceStore, 'publish'>,
  contributions: ManagedPackageContributions,
): Promise<ManagedSessionDurableRef> {
  const bytes = Buffer.from(JSON.stringify(contributions));
  if (bytes.length > MAX_BYTES)
    throw new Error('Extension contributions exceed 2 MiB.');
  const parts: ManagedSessionDurableRef[] = [];
  for (let offset = 0; offset < bytes.length; offset += PART_BYTES)
    parts.push(
      await resources.publish(
        'managed-extension-contributions-part',
        bytes.subarray(offset, offset + PART_BYTES),
      ),
    );
  return resources.publish(
    'managed-extension-contributions',
    Buffer.from(
      JSON.stringify({
        kind: 'managed-extension-contributions',
        formatVersion: 1,
        byteLength: bytes.length,
        digest: digest(bytes),
        parts,
      }),
    ),
  );
}

export async function readManagedExtensionContributions(
  resources: Pick<ManagedSessionResourceStore, 'read'>,
  ref: ManagedSessionDurableRef,
): Promise<ManagedPackageContributions> {
  if (
    ref.kind !== 'managed-extension-contributions' ||
    ref.schemaVersion !== 1 ||
    ref.byteLength > PART_BYTES
  )
    throw new Error('Invalid extension contribution reference.');
  const manifestBytes = await resources.read(ref);
  if (
    manifestBytes.length !== ref.byteLength ||
    digest(manifestBytes) !== ref.digest
  )
    throw new Error(
      'Extension contribution manifest does not match its reference.',
    );
  const value: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
  );
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid extension contribution manifest.');
  const manifest = value as Record<string, unknown>;
  if (
    Object.keys(manifest).sort().join(',') !==
      'byteLength,digest,formatVersion,kind,parts' ||
    manifest['kind'] !== 'managed-extension-contributions' ||
    manifest['formatVersion'] !== 1 ||
    !Number.isSafeInteger(manifest['byteLength']) ||
    Number(manifest['byteLength']) < 1 ||
    Number(manifest['byteLength']) > MAX_BYTES ||
    typeof manifest['digest'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(manifest['digest']) ||
    !Array.isArray(manifest['parts']) ||
    manifest['parts'].length < 1 ||
    manifest['parts'].length > 32
  )
    throw new Error('Invalid extension contribution manifest.');
  const parts: Buffer[] = [];
  for (const value of manifest['parts']) {
    const part = assertManagedSessionDurableRef(
      value as ManagedSessionJsonValue,
      'extension contribution part',
    );
    if (
      part.kind !== 'managed-extension-contributions-part' ||
      part.schemaVersion !== 1 ||
      part.byteLength < 1 ||
      part.byteLength > PART_BYTES
    )
      throw new Error('Invalid extension contribution part.');
    const bytes = await resources.read(part);
    if (bytes.length !== part.byteLength || digest(bytes) !== part.digest)
      throw new Error(
        'Extension contribution part does not match its reference.',
      );
    parts.push(bytes);
  }
  const bytes = Buffer.concat(parts);
  if (
    bytes.length !== manifest['byteLength'] ||
    digest(bytes) !== manifest['digest']
  )
    throw new Error('Extension contributions do not match their manifest.');
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  ) as ManagedPackageContributions;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
