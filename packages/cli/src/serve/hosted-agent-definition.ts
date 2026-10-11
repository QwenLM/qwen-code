/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-storage.js';

export interface HostedAgentDefinition {
  agentId: string;
  revision: string;
  digest: string;
  model?: { id: string };
  instructionsRef?: ManagedSessionDurableRef;
}

export function parseHostedAgentDefinition(
  value: unknown,
  create = true,
): HostedAgentDefinition | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid agent definition.');
  const pin = value as Record<string, unknown>;
  const fields = create
    ? ['agentId', 'revision', 'digest', 'model', 'instructionsRef']
    : ['agentId', 'revision', 'digest'];
  if (
    Object.keys(pin).some((key) => !fields.includes(key)) ||
    typeof pin['agentId'] !== 'string' ||
    !/^agent_[0-9a-f]{32}$/u.test(pin['agentId']) ||
    typeof pin['revision'] !== 'string' ||
    !/^[1-9][0-9]{0,17}$/u.test(pin['revision']) ||
    typeof pin['digest'] !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(pin['digest'])
  )
    throw new Error('Invalid agent definition identity.');
  const result: HostedAgentDefinition = {
    agentId: pin['agentId'],
    revision: pin['revision'],
    digest: pin['digest'],
  };
  if (pin['model'] !== undefined) {
    const model = pin['model'] as Record<string, unknown> | null;
    if (
      !model ||
      typeof model !== 'object' ||
      Array.isArray(model) ||
      Object.keys(model).length !== 1 ||
      typeof model['id'] !== 'string' ||
      !model['id'].trim()
    )
      throw new Error('Invalid agent model.');
    result.model = { id: model['id'] };
  }
  if (pin['instructionsRef'] !== undefined) {
    const ref = assertManagedSessionDurableRef(
      pin['instructionsRef'] as ManagedSessionJsonValue,
      'agent instructions',
    );
    if (
      ref.kind !== 'managed-agent-instructions' ||
      ref.schemaVersion !== 1 ||
      ref.byteLength > 64 * 1024
    )
      throw new Error('Invalid agent instructions reference.');
    result.instructionsRef = ref;
  }
  return result;
}

export function sameHostedAgentDefinition(
  saved: HostedAgentDefinition | undefined,
  requested: HostedAgentDefinition | undefined,
): boolean {
  return (
    saved?.agentId === requested?.agentId &&
    saved?.revision === requested?.revision &&
    saved?.digest === requested?.digest
  );
}

export async function readHostedAgentInstructions(
  pin: HostedAgentDefinition | undefined,
  resources: Pick<ManagedSessionResourceStore, 'read'>,
): Promise<string | undefined> {
  const ref = pin?.instructionsRef;
  if (!ref) return undefined;
  const bytes = await resources.read(ref);
  if (
    bytes.byteLength !== ref.byteLength ||
    bytes.byteLength > 64 * 1024 ||
    createHash('sha256').update(bytes).digest('hex') !== ref.digest
  )
    throw new Error('Agent instructions do not match their reference.');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export class HostedModelUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('model_unavailable: The pinned agent model is unavailable.', {
      cause,
    });
    this.name = 'HostedModelUnavailableError';
  }
}
