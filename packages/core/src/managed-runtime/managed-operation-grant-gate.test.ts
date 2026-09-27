/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ManagedOperationGrantGate } from './managed-operation-grant-gate.js';
import { ManagedSessionConflictError } from './managed-session-authority.js';
import {
  ManagedSessionRecordError,
  type ManagedSessionKey,
} from './managed-session-records.js';

interface Grant {
  readonly sessionKey: ManagedSessionKey;
  readonly operationId: string;
  readonly operationRevision: number;
  readonly expiresAt: number;
}

const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'contracts',
      'managed-extension-record-v1.fixtures.json',
    ),
    'utf8',
  ),
) as {
  readonly grant: Grant & { readonly resourceScope: { phases: string[] } };
  readonly grantSuccessorCases: ReadonlyArray<{
    readonly id: string;
    readonly valid: boolean;
    readonly previous: Grant;
    readonly next: Grant;
  }>;
};

function sameOperation(left: Grant, right: Grant): boolean {
  return (
    JSON.stringify(left.sessionKey) === JSON.stringify(right.sessionKey) &&
    left.operationId === right.operationId
  );
}

describe('managed operation grant gate', () => {
  it.each(fixtures.grantSuccessorCases)(
    'replaces a grant as the contract allows: $id',
    (each) => {
      const gate = new ManagedOperationGrantGate();
      if (each.id === 'invalid-previous') {
        expect(() => gate.install(each.previous)).toThrow(
          ManagedSessionRecordError,
        );
        return;
      }
      expect(gate.install(each.previous)).toBe('installed');
      if (JSON.stringify(each.previous) === JSON.stringify(each.next)) {
        // An identical grant replaces nothing and is answered as before.
        expect(gate.install(each.next)).toBe('unchanged');
      } else if (each.valid || !sameOperation(each.previous, each.next)) {
        // Another Session or operation has a gate of its own.
        expect(gate.install(each.next)).toBe('installed');
      } else {
        expect(() => gate.install(each.next)).toThrow(
          each.id === 'invalid-next' || each.id === 'next-past-double-range'
            ? ManagedSessionRecordError
            : ManagedSessionConflictError,
        );
      }
    },
  );

  it('admits only listed phases until the lease ends', () => {
    const gate = new ManagedOperationGrantGate();
    const grant = fixtures.grant;
    const [phase] = grant.resourceScope.phases;
    expect(gate.admits(grant.sessionKey, grant.operationId, phase, 0)).toBe(
      false,
    );
    gate.install(grant);
    expect(
      gate.admits(
        grant.sessionKey,
        grant.operationId,
        phase,
        grant.expiresAt - 1,
      ),
    ).toBe(true);
    expect(
      gate.admits(grant.sessionKey, grant.operationId, phase, grant.expiresAt),
    ).toBe(false);
    expect(
      gate.admits(grant.sessionKey, grant.operationId, 'other_phase', 0),
    ).toBe(false);
  });

  it('never reopens a revoked revision', () => {
    const gate = new ManagedOperationGrantGate();
    const grant = fixtures.grant;
    const [phase] = grant.resourceScope.phases;
    gate.install(grant);
    gate.revoke(grant.sessionKey, grant.operationId, grant.operationRevision);
    expect(gate.admits(grant.sessionKey, grant.operationId, phase, 0)).toBe(
      false,
    );
    expect(() => gate.install(grant)).toThrow(/was revoked/);
    expect(() =>
      gate.install({ ...grant, expiresAt: grant.expiresAt + 1 }),
    ).toThrow(/was revoked/);
    const next = { ...grant, operationRevision: grant.operationRevision + 1 };
    expect(gate.install(next)).toBe('installed');
    expect(gate.admits(grant.sessionKey, grant.operationId, phase, 0)).toBe(
      true,
    );
  });

  it('bounds the next grant by the one it revoked', () => {
    const gate = new ManagedOperationGrantGate();
    const grant = { ...fixtures.grant, workspaceGeneration: '5' };
    const [phase] = grant.resourceScope.phases;
    gate.install(grant);
    gate.revoke(grant.sessionKey, grant.operationId, grant.operationRevision);
    const next = { ...grant, operationRevision: grant.operationRevision + 1 };
    expect(() => gate.install({ ...next, workspaceGeneration: '3' })).toThrow(
      /cannot replace/,
    );
    expect(() => gate.install({ ...next, domain: 'child_run' })).toThrow();
    expect(gate.admits(grant.sessionKey, grant.operationId, phase, 0)).toBe(
      false,
    );
    expect(gate.install(next)).toBe('installed');
    expect(gate.admits(grant.sessionKey, grant.operationId, phase, 0)).toBe(
      true,
    );
  });

  it('keeps a revocation that arrives before its grant', () => {
    const gate = new ManagedOperationGrantGate();
    const grant = fixtures.grant;
    gate.revoke(grant.sessionKey, grant.operationId, grant.operationRevision);
    expect(() => gate.install(grant)).toThrow(/was revoked/);
  });
});
