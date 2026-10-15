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
  readonly resourceScope: {
    readonly phases: string[];
    readonly recordRef: Readonly<Record<string, unknown>>;
  };
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
  readonly grant: Grant;
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
        let thrown: unknown;
        try {
          gate.install(each.next);
        } catch (error) {
          thrown = error;
        }
        if (
          each.id === 'invalid-next' ||
          each.id === 'next-past-double-range' ||
          each.id === 'replacement-with-a-non-text-digest'
        ) {
          // A malformed grant is refused as malformed, not as a conflict,
          // which is a subclass of the record error.
          expect(thrown).toBeInstanceOf(ManagedSessionRecordError);
          expect(thrown).not.toBeInstanceOf(ManagedSessionConflictError);
          expect(
            gate.admits(
              each.previous.sessionKey,
              each.previous.operationId,
              each.previous.resourceScope.phases[0],
              0,
            ),
          ).toBe(true);
          // The refusal left the previous grant installed, not the refused
          // one: installing it again is idempotent, so it answers unchanged.
          expect(gate.install(each.previous)).toBe('unchanged');
        } else {
          expect(thrown).toBeInstanceOf(ManagedSessionConflictError);
        }
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
    expect(() =>
      gate.install({
        ...next,
        domain: 'child_run',
        resourceScope: {
          ...next.resourceScope,
          recordRef: {
            ...next.resourceScope.recordRef,
            kind: 'managed-child_run',
          },
        },
      }),
    ).toThrow(/cannot replace/);
    expect(gate.admits(grant.sessionKey, grant.operationId, phase, 0)).toBe(
      false,
    );
    expect(gate.install(next)).toBe('installed');
    expect(gate.admits(grant.sessionKey, grant.operationId, phase, 0)).toBe(
      true,
    );
  });

  it('keeps the highest revocation', () => {
    const gate = new ManagedOperationGrantGate();
    const grant = { ...fixtures.grant, operationRevision: 5 };
    const [phase] = grant.resourceScope.phases;
    gate.install(grant);
    gate.revoke(grant.sessionKey, grant.operationId, 5);
    // A late revocation of an older revision lowers nothing.
    gate.revoke(grant.sessionKey, grant.operationId, 3);
    expect(() => gate.install(grant)).toThrow(/was revoked/);
    expect(gate.admits(grant.sessionKey, grant.operationId, phase, 0)).toBe(
      false,
    );
  });

  it('refuses a malformed revocation instead of missing its grant', () => {
    const gate = new ManagedOperationGrantGate();
    const grant = fixtures.grant;
    const [phase] = grant.resourceScope.phases;
    gate.install(grant);
    const { workspaceId: _omitted, ...partialKey } = grant.sessionKey;
    for (const revoke of [
      () =>
        gate.revoke(
          partialKey as unknown as ManagedSessionKey,
          grant.operationId,
          grant.operationRevision,
        ),
      () => gate.revoke(grant.sessionKey, '', grant.operationRevision),
      ...[
        undefined,
        Number.NaN,
        0,
        1.5,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER + 1,
      ].map(
        (revision) => () =>
          gate.revoke(
            grant.sessionKey,
            grant.operationId,
            revision as unknown as number,
          ),
      ),
    ]) {
      expect(revoke).toThrow(ManagedSessionRecordError);
    }
    expect(() =>
      gate.admits(
        partialKey as unknown as ManagedSessionKey,
        grant.operationId,
        phase,
        0,
      ),
    ).toThrow(ManagedSessionRecordError);
    // The refusals changed nothing: the grant admits until a real revocation.
    expect(gate.admits(grant.sessionKey, grant.operationId, phase, 0)).toBe(
      true,
    );
    gate.revoke(grant.sessionKey, grant.operationId, grant.operationRevision);
    expect(gate.admits(grant.sessionKey, grant.operationId, phase, 0)).toBe(
      false,
    );
  });

  it('keeps a revocation that arrives before its grant', () => {
    const gate = new ManagedOperationGrantGate();
    const grant = fixtures.grant;
    const [phase] = grant.resourceScope.phases;
    gate.revoke(grant.sessionKey, grant.operationId, grant.operationRevision);
    // An entry the first revocation created holds no grant, and a lookup
    // admits nothing rather than reading it.
    expect(gate.admits(grant.sessionKey, grant.operationId, phase, 0)).toBe(
      false,
    );
    expect(() => gate.install(grant)).toThrow(/was revoked/);
  });

  it('withdraws the phases a replacement does not list', () => {
    const gate = new ManagedOperationGrantGate();
    const narrowing = fixtures.grantSuccessorCases.find(
      (each) => each.id === 'next-revision',
    )!;
    expect(narrowing.valid).toBe(true);
    gate.install(narrowing.previous);
    expect(
      gate.admits(
        narrowing.previous.sessionKey,
        narrowing.previous.operationId,
        'send_segment',
        0,
      ),
    ).toBe(true);
    expect(gate.install(narrowing.next)).toBe('installed');
    // The newest revision narrowed the phases, so the older list admits no
    // more of the phase it withdrew.
    expect(
      gate.admits(
        narrowing.next.sessionKey,
        narrowing.next.operationId,
        'send_segment',
        narrowing.previous.expiresAt,
      ),
    ).toBe(false);
    expect(
      gate.admits(
        narrowing.next.sessionKey,
        narrowing.next.operationId,
        'query_receipt',
        narrowing.previous.expiresAt,
      ),
    ).toBe(true);
  });

  it('renews a grant in place, so its lease extends', () => {
    const gate = new ManagedOperationGrantGate();
    const grant = fixtures.grant;
    const [phase] = grant.resourceScope.phases;
    gate.install(grant);
    const renewal = { ...grant, expiresAt: grant.expiresAt + 60_000 };
    // Decision 7: issuing the same revision again renews it.
    expect(gate.install(renewal)).toBe('installed');
    expect(
      gate.admits(grant.sessionKey, grant.operationId, phase, grant.expiresAt),
    ).toBe(true);
    expect(
      gate.admits(
        grant.sessionKey,
        grant.operationId,
        phase,
        renewal.expiresAt,
      ),
    ).toBe(false);
  });

  it('keeps the incumbent when a conflict or a malformed grant is refused', () => {
    const gate = new ManagedOperationGrantGate();
    const grant = fixtures.grant;
    const [phase] = grant.resourceScope.phases;
    gate.install(grant);
    expect(() =>
      gate.install({
        ...grant,
        resourceScope: {
          ...grant.resourceScope,
          phases: ['other_phase'],
        },
      }),
    ).toThrow(ManagedSessionConflictError);
    expect(() =>
      gate.install({
        ...grant,
        expiresAt: 'later' as unknown as number,
      }),
    ).toThrow(ManagedSessionRecordError);
    expect(gate.admits(grant.sessionKey, grant.operationId, phase, 0)).toBe(
      true,
    );
    expect(gate.install(grant)).toBe('unchanged');
  });

  it('keeps the grants of separate Workspaces apart', () => {
    const gate = new ManagedOperationGrantGate();
    const grant = fixtures.grant;
    const other = {
      ...grant,
      sessionKey: { ...grant.sessionKey, workspaceId: 'workspace-2' },
    };
    const [phase] = grant.resourceScope.phases;
    gate.install(grant);
    expect(gate.install(other)).toBe('installed');
    gate.revoke(grant.sessionKey, grant.operationId, grant.operationRevision);
    expect(gate.admits(grant.sessionKey, grant.operationId, phase, 0)).toBe(
      false,
    );
    // The other Workspace's bucket is independent of the revocation.
    expect(gate.admits(other.sessionKey, other.operationId, phase, 0)).toBe(
      true,
    );
  });
});
