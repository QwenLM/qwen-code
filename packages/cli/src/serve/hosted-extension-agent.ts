/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type {
  ManagedExtensionApplyCommand,
  ManagedExtensionPin,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-package.js';
import {
  parsePublicChildExtensionAgent,
  type PublicChildExtensionAgent,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

export interface HostedChildExtensionAgent {
  readonly extensionAgent: PublicChildExtensionAgent;
  readonly effectiveConfigRef: ManagedSessionDurableRef;
}

export function parseHostedChildExtensionAgent(
  value: unknown,
): HostedChildExtensionAgent | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'effectiveConfigRef,extensionAgent'
  )
    throw new Error('Invalid child extension binding.');
  const fields = value as Record<string, ManagedSessionJsonValue>;
  const effectiveConfigRef = assertManagedSessionDurableRef(
    fields['effectiveConfigRef'],
    'child extension source',
  );
  const extensionAgent = parsePublicChildExtensionAgent(
    fields['extensionAgent'],
  );
  if (
    effectiveConfigRef.kind !== 'managed-extension-config-bundle' ||
    effectiveConfigRef.schemaVersion !== 1 ||
    effectiveConfigRef.digest !== extensionAgent.bundleRef.digest
  )
    throw new Error(
      'Child extension source does not match its parent binding.',
    );
  return { extensionAgent, effectiveConfigRef };
}

export function hostedChildExtensionCommandId(
  sessionId: string,
  sourceDigest: string,
): string {
  const bytes = createHash('sha256')
    .update(`managed-extension-child:${sessionId}:${sourceDigest}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function hostedChildExtensionApplyCommand(
  sessionId: string,
  sourceDigest: string,
  extensions: readonly ManagedExtensionPin[],
): ManagedExtensionApplyCommand {
  return {
    operationId: hostedChildExtensionCommandId(sessionId, sourceDigest),
    actorKey: createHash('sha256')
      .update(`managed-extension-child:${sessionId}`)
      .digest('hex'),
    expectedRevision: 0,
    extensions,
  };
}
