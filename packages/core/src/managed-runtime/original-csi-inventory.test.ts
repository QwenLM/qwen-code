/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  csiFileInventory as inventory,
  closeCsiFileFixtures,
} from './__tests__/csi-file-session.js';
import { inspectOriginalCsiInventory } from './original-csi-inventory.js';

afterEach(closeCsiFileFixtures);
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('original CSI inventory observation', () => {
  it('reports native file settlement without claiming admission closure or DRAINED', async () => {
    const input = await inventory();
    const result = await inspectOriginalCsiInventory(input);
    expect(result).toMatchObject({
      status: 'observed',
      counts: { executions: 1, publications: 0, workerAcks: 0 },
      executions: [{ executionCallId: 'execution', status: 'matched' }],
      blockers: [],
    });
    expect(result).not.toHaveProperty('drained');
    expect(result).not.toHaveProperty('releasable');
    expect(await inspectOriginalCsiInventory(input)).toEqual(result);
  });
  it('qualifies a native initial Session with no admitted tool work', async () => {
    const result = await inspectOriginalCsiInventory(await inventory(true));
    expect(result).toMatchObject({
      status: 'observed',
      counts: { runtimeSessions: 1, executions: 0, publications: 0 },
      executions: [],
      blockers: [],
    });
    expect(result).not.toHaveProperty('drained');
    expect(result).not.toHaveProperty('releasable');
  });
  it.each([
    'PREPARED',
    'DISPATCHING',
    'EXECUTING',
    'CANCEL_REQUESTED',
    'UNKNOWN',
    'ABANDONED',
  ])('retains %s as a blocker', async (state) => {
    const input = await inventory();
    input.executions[0].state = state;
    expect(await inspectOriginalCsiInventory(input)).toMatchObject({
      status: 'observed',
      blockers: [
        {
          member: 'execution',
          reason: ['UNKNOWN', 'ABANDONED'].includes(state)
            ? 'execution_uncertain'
            : 'execution_not_settled',
        },
      ],
    });
  });
  it('does not count released RuntimeSessions as absence of their execution history', async () => {
    const input = await inventory();
    input.runtimeSessions[0].sessionState = 'RELEASED';
    expect(await inspectOriginalCsiInventory(input)).toMatchObject({
      status: 'observed',
      executions: [{ status: 'matched' }],
    });
    input.executions[0].state = 'UNKNOWN';
    expect(await inspectOriginalCsiInventory(input)).toMatchObject({
      status: 'observed',
      blockers: [{ reason: 'execution_uncertain' }],
    });
  });
  it('rejects an execution array emptied beneath committed native work', async () => {
    const input = await inventory();
    input.executions = [];
    const result = await inspectOriginalCsiInventory(input);
    expect(result).toMatchObject({
      status: 'observed',
      blockers: expect.arrayContaining([
        { member: 'execution', reason: 'orphan_native_tool_work' },
        { member: input.isolationKey, reason: 'empty_session_not_qualified' },
      ]),
    });
  });
  it('preserves independent orphan publication children and ACKs as blockers', async () => {
    const input = await inventory();
    const scopeKey = hash(JSON.stringify(['t', 'w', input.isolationKey]));
    input.publicationObjects.push({
      scopeKey,
      publicationId: 'missing-publication',
    });
    input.workerAcks.push({
      executionCallId: 'missing-execution',
      evidence: {
        original: {
          sessionKey: input.sessionSnapshots[0].sessionKey,
          publicationId: 'missing-publication',
        },
      },
    });
    expect(await inspectOriginalCsiInventory(input)).toMatchObject({
      status: 'observed',
      blockers: expect.arrayContaining([
        {
          member: `${scopeKey}:missing-publication`,
          reason: 'orphan_publication_child',
        },
        { member: 'missing-execution', reason: 'orphan_worker_ack' },
      ]),
    });
  });
  it.each([
    'missing-collection',
    'missing-session',
    'wrong-runtime',
    'duplicate-execution',
    'overflow',
  ])('refuses incomplete or conflicting %s', async (damage) => {
    const input = await inventory();
    if (damage === 'missing-collection')
      delete (input as Partial<typeof input>).publicationSeals;
    if (damage === 'missing-session') input.sessionSnapshots = [];
    if (damage === 'wrong-runtime')
      input.executions[0].runtimeSessionId = 'other';
    if (damage === 'duplicate-execution')
      input.executions.push(input.executions[0]);
    if (damage === 'overflow')
      input.runtimeSessions = Array(4097).fill(input.runtimeSessions[0]);
    expect(await inspectOriginalCsiInventory(input)).toMatchObject({
      status: 'unresolved',
    });
  });
  it.each([
    ['resource-metadata', 'resource_not_qualified'],
    ['resource-missing', 'inventory_resource_missing'],
    ['reference-missing', 'inventory_reference_missing'],
    ['orphan-reference', 'orphan_resource_reference'],
  ])('retains %s contradictions', async (damage, expectedReason) => {
    const input = await inventory();
    if (damage === 'resource-metadata')
      input.sessionResourceInventory[0].sha256 = '0'.repeat(64);
    if (damage === 'resource-missing') input.sessionResourceInventory.pop();
    if (damage === 'reference-missing') input.sessionResourceReferences.pop();
    if (damage === 'orphan-reference')
      input.sessionResourceReferences[0].resourceId = 'missing';
    const result = await inspectOriginalCsiInventory(input);
    expect(result.status).toBe('observed');
    if (result.status === 'observed')
      expect(result.blockers).toEqual(
        expect.arrayContaining([
          { member: expect.any(String), reason: expectedReason },
        ]),
      );
  });
});
