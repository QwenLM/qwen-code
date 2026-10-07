/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  csiFileInventory,
  csiFileSession,
  csiFileInventoryFromSnapshot,
  closeCsiFileFixtures,
} from '@qwen-code/qwen-code-core/managed-runtime/__tests__/csi-file-session.js';
import {
  commitHostedFileHistory,
  readHostedFileHistory,
} from './hosted-file-history.js';

afterEach(closeCsiFileFixtures);

function runEvidence(file: string) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx/esm',
      fileURLToPath(
        new URL('./managed-csi-checkpoint-evidence.ts', import.meta.url),
      ),
      file,
    ],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(
          new URL('../../tsconfig.json', import.meta.url),
        ),
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}

describe('Managed CSI checkpoint evidence entry', () => {
  it.each(['original-boundary', 'blocked-boundary'])(
    'dispatches %s observation without granting release authority',
    async (kind) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'qwen-csi-boundary-'));
      try {
        const fixture = await csiFileSession('write_file');
        await fixture.harness.consumeRuntimeResults();
        const settledInventory = csiFileInventoryFromSnapshot(
          await fixture.snapshot(),
          [fixture.originalExecution],
        );
        await fixture.session.releaseActivation();
        if (kind === 'blocked-boundary')
          settledInventory.executions[0]['state'] = 'UNKNOWN';
        const file = path.join(directory, 'boundary.json');
        writeFileSync(
          file,
          JSON.stringify({
            format: 'qwen-csi-session-retirement-boundary/1',
            settledInventory,
            terminalSnapshot: await fixture.snapshot(),
          }),
        );
        const result = runEvidence(file);
        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe('');
        expect(result.status).toBe(kind === 'original-boundary' ? 0 : 1);
        const observation = JSON.parse(result.stdout);
        expect(observation).toMatchObject(
          kind === 'original-boundary'
            ? { status: 'observed', stage: 'original_native_boundary' }
            : {
                status: 'unresolved',
                reason: 'boundary_inventory_not_settled',
              },
        );
        for (const field of ['drained', 'releasable', 'cut', 'finalization'])
          expect(observation).not.toHaveProperty(field);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  async function hostedHistoryFixture(name: string) {
    const fixture = await csiFileSession(name);
    const history = await readHostedFileHistory(fixture.session);
    if (!history) throw new Error('Fixture has no file history.');
    await commitHostedFileHistory(fixture.session, {
      ...history,
      pendingTurn: fixture.promptId,
    });
    await commitHostedFileHistory(fixture.session, history);
    return fixture;
  }

  it.each(['write_file', 'edit'])(
    'matches %s history committed by the production Hosted producer',
    async (name) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'qwen-csi-hosted-'));
      try {
        const fixture = await hostedHistoryFixture(name);
        await fixture.harness.consumeRuntimeResults();
        const file = path.join(directory, 'snapshot.json');
        writeFileSync(file, JSON.stringify(await fixture.snapshot()));
        const result = runEvidence(file);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toMatchObject({ status: 'matched' });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(['owner', 'snapshots', 'extra'])(
    'refuses a conflicting Hosted history projection: %s',
    async (damage) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'qwen-csi-hosted-'));
      try {
        const fixture = await hostedHistoryFixture('write_file');
        const latest = fixture.session.authority.domainRecord('file_history')!;
        const content = JSON.parse(
          (await fixture.resources.read(latest.recordRef)).toString('utf8'),
        );
        delete content.operationId;
        delete content.revision;
        delete content.previousRecordRef;
        if (damage === 'owner') content.record.sessionId = 'other-session';
        if (damage === 'snapshots') content.record.systemPayload.snapshots = [];
        if (damage === 'extra') content.record.pendingOtherEffect = true;
        await fixture.session.authority.commitDomainRecord(
          {
            operation: 'commitFileHistory',
            commandId: 'damaged-projection',
            sessionKey: fixture.session.authority.sessionHeader.sessionKey,
            contentDigest: fixture.outcomeRef.digest,
          },
          { domain: 'file_history', content },
          { class: 'trusted_entry' },
        );
        await fixture.harness.consumeRuntimeResults();
        const file = path.join(directory, 'snapshot.json');
        writeFileSync(file, JSON.stringify(await fixture.snapshot()));
        const result = runEvidence(file);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toMatchObject({
          status: 'unresolved',
          reason: 'file_history_projection_not_qualified',
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(['file', 'inventory', 'blocked-inventory', 'mislabelled-inventory'])(
    'dispatches %s evidence with its documented exit status',
    async (kind) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'qwen-csi-evidence-'));
      const file = path.join(directory, 'snapshot.json');
      try {
        let input: unknown;
        if (kind === 'file') {
          const fixture = await csiFileSession('write_file');
          await fixture.harness.consumeRuntimeResults();
          input = await fixture.snapshot();
        } else {
          const inventory = await csiFileInventory();
          if (kind === 'blocked-inventory')
            inventory.executions[0].state = 'UNKNOWN';
          if (kind === 'mislabelled-inventory')
            inventory.format = 'qwen-csi-session-checkpoint-snapshot/1';
          input = inventory;
        }
        writeFileSync(file, JSON.stringify(input));
        const result = runEvidence(file);
        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe('');
        expect(result.stdout.trim().split('\n')).toHaveLength(1);
        const observation = JSON.parse(result.stdout);
        expect(result.status).toBe(kind === 'mislabelled-inventory' ? 1 : 0);
        expect(observation.status).toBe(
          kind === 'file'
            ? 'matched'
            : kind === 'mislabelled-inventory'
              ? 'unresolved'
              : 'observed',
        );
        if (kind === 'inventory') {
          expect(observation.executions).toEqual([
            expect.objectContaining({ status: 'matched' }),
          ]);
          expect(observation.blockers).toEqual([]);
        }
        if (kind === 'blocked-inventory')
          expect(observation.blockers).toEqual(
            expect.arrayContaining([
              { member: 'execution', reason: 'execution_uncertain' },
            ]),
          );
        expect(observation).not.toHaveProperty('drained');
        expect(observation).not.toHaveProperty('releasable');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it.each([
    ['malformed', 'record is not valid JSON.'],
    ['oversized', 'Snapshot exceeds its size limit.'],
    ['missing', 'ENOENT'],
    ['invalid', 'snapshot format is unsupported.'],
  ] as const)('emits unresolved JSON for %s input', (kind, reason) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qwen-csi-evidence-'));
    const file = path.join(directory, 'snapshot.json');
    try {
      if (kind !== 'missing') {
        writeFileSync(file, kind === 'malformed' ? '{' : '{}');
        if (kind === 'oversized') truncateSync(file, 48 * 1024 * 1024 + 1);
      }
      const result = runEvidence(file);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toEqual({
        status: 'unresolved',
        reason: expect.stringContaining(reason),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
