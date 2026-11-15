/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertManagedConfigInstallSuccessor,
  managedConfigBinding,
  managedExtensionCompensationOperationId,
  parseManagedConfigInstallContent,
  parseManagedConfigInstallRecord,
  type ManagedConfigInstallContent,
  type ManagedConfigInstallRecord,
} from './managed-config-install.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { LocalJsonlManagedSessionJournalStore } from './local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

const directories: string[] = [];
const sharedFixtures = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-config-install-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  valid: Array<{ name: string; content: unknown }>;
  invalid: Array<{ name: string; content: unknown }>;
  successors: Array<{
    name: string;
    previous: string | null;
    next: string;
    valid: boolean;
  }>;
  phaseOperationIds: Array<{ operationId: string; expected: string }>;
};
describe('shared Managed configuration fixtures', () => {
  for (const fixture of sharedFixtures.successors)
    it(`${fixture.name}`, () => {
      const find = (name: string) =>
        parseManagedConfigInstallContent(
          sharedFixtures.valid.find((value) => value.name === name)!.content,
        );
      const check = () =>
        assertManagedConfigInstallSuccessor(
          fixture.previous === null
            ? undefined
            : record(find(fixture.previous)),
          find(fixture.next),
        );
      if (fixture.valid) expect(check).not.toThrow();
      else expect(check).toThrow();
    });
  for (const fixture of sharedFixtures.phaseOperationIds)
    it(`derives phase identity ${fixture.operationId}`, () => {
      expect(managedExtensionCompensationOperationId(fixture.operationId)).toBe(
        fixture.expected,
      );
    });
  for (const fixture of sharedFixtures.valid)
    it(`${fixture.name}`, () => {
      expect(() =>
        parseManagedConfigInstallContent(fixture.content),
      ).not.toThrow();
    });
  for (const fixture of sharedFixtures.invalid)
    it(`${fixture.name}`, () => {
      expect(() => parseManagedConfigInstallContent(fixture.content)).toThrow();
    });
});
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function ref(resourceId: string): ManagedSessionDurableRef {
  return {
    resourceId,
    kind: 'managed-test',
    schemaVersion: 1,
    byteLength: 2,
    digest: 'a'.repeat(64),
  };
}

function content(
  phase: ManagedConfigInstallContent['phase'] = 'preparing',
): ManagedConfigInstallContent {
  return {
    kind: 'hosted-extension-config',
    formatVersion: 1,
    command: {
      operationId: '11111111-1111-4111-8111-111111111111',
      actorKey: 'b'.repeat(64),
      expectedRevision: 0,
      extensions: [],
    },
    mode: 'apply',
    phaseOperationId: '11111111-1111-4111-8111-111111111111',
    configRevision: 1,
    previousConfigRevision: 0,
    phase,
    previousBundleRef: null,
    restoresBundleRef: null,
    bundleRef: ref('bundle'),
    rootSnapshotRef: ref('root'),
    stageAckRefs: phase === 'preparing' ? [] : [ref('h-stage'), ref('r-stage')],
    enableAckRefs: phase === 'active' ? [ref('h-enable'), ref('r-enable')] : [],
    error:
      phase === 'recovery_required' || phase === 'failed'
        ? { code: 'runtime_unavailable' }
        : null,
  };
}

function record(
  value: ManagedConfigInstallContent,
): ManagedConfigInstallRecord {
  return {
    ...value,
    revision: 1,
    operationId: value.command.operationId,
    previousRecordRef: null,
  };
}

describe('Managed configuration install records', () => {
  it('requires both stage and enable evidence before active', () => {
    expect(parseManagedConfigInstallContent(content('active')).phase).toBe(
      'active',
    );
    expect(() =>
      parseManagedConfigInstallContent({
        ...content('active'),
        enableAckRefs: [ref('h-enable')],
      }),
    ).toThrow();
    expect(() =>
      parseManagedConfigInstallContent({
        ...content('committed'),
        stageAckRefs: [],
      }),
    ).toThrow();
  });

  it('does not confuse the phase envelope revision with configuration revision', () => {
    const value = {
      ...record(content('active')),
      revision: 8,
      previousRecordRef: {
        ...ref('previous-phase'),
        kind: 'managed-config_install',
      },
    };
    expect(parseManagedConfigInstallRecord(value).configRevision).toBe(1);
    expect(() =>
      parseManagedConfigInstallRecord({ ...value, settings: {} }),
    ).toThrow();
  });

  it('refuses a new operation until the current binding settles', () => {
    const previous = record(content('committed'));
    expect(() =>
      assertManagedConfigInstallSuccessor(previous, {
        ...content(),
        command: {
          ...content().command,
          operationId: '22222222-2222-4222-8222-222222222222',
        },
      }),
    ).toThrow();
  });

  it('does not allow a resumed phase to substitute a different package view', () => {
    expect(() =>
      assertManagedConfigInstallSuccessor(record(content()), {
        ...content('prepared'),
        bundleRef: ref('other-package-content'),
      }),
    ).toThrow();
  });

  it('records compensation as a newer binding of saved content', () => {
    const old = ref('old-bundle');
    const previous = record({
      ...content('recovery_required'),
      previousBundleRef: old,
    });
    const restored = {
      ...content(),
      mode: 'recoverPrevious' as const,
      phaseOperationId: managedExtensionCompensationOperationId(
        previous.command.operationId,
      ),
      configRevision: 2,
      previousConfigRevision: 1,
      bundleRef: ref('old-content-new-hook-revision'),
      previousBundleRef: previous.bundleRef,
      restoresBundleRef: old,
    };
    expect(parseManagedConfigInstallContent(restored).configRevision).toBe(2);
    expect(() =>
      assertManagedConfigInstallSuccessor(previous, restored),
    ).not.toThrow();
    expect(() =>
      assertManagedConfigInstallSuccessor(previous, {
        ...restored,
        restoresBundleRef: ref('unrelated-bundle'),
      }),
    ).toThrow();
  });
});

async function open() {
  const directory = await mkdtemp(path.join(tmpdir(), 'qwen-config-install-'));
  directories.push(directory);
  const runtimeBaseDir = path.join(directory, 'runtime');
  await mkdir(runtimeBaseDir);
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: 'session',
  };
  const lease = await LocalManagedSessionAuthority.acquireWriter({
    runtimeBaseDir,
    sessionId: sessionKey.sessionId,
    transcriptPath: path.join(runtimeBaseDir, 'session.jsonl'),
  });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir,
    sessionKey,
  });
  const authority = await LocalManagedSessionAuthority.open({
    journal: LocalJsonlManagedSessionJournalStore.fromLease(lease, sessionKey),
    sessionKey,
    cwd: '/workspace',
    version: 'test',
    resources,
    create: {
      definitionRef: ref('definition'),
      rootSnapshotRef: ref('root'),
      createdBy: 'daemon',
    },
  });
  const commit = (body: ManagedConfigInstallContent, binding = false) =>
    authority.commitDomainRecord(
      {
        operation: `extensionConfig.${body.mode}.${body.phase}`,
        commandId: body.command.operationId,
        sessionKey,
        contentDigest: 'c'.repeat(64),
      },
      {
        domain: 'config_install',
        content: { ...body },
        ...(binding ? { configBinding: managedConfigBinding(body) } : {}),
      },
      { class: 'trusted_entry' },
    );
  return { authority, resources, commit };
}

describe('Managed configuration binding commits', () => {
  it('commits intent and binding in one transaction and replays it once', async () => {
    const { authority, commit } = await open();
    try {
      await commit(content());
      await commit(content('prepared'));
      const receipt = await commit(content('committed'), true);
      const events = authority.eventsInSequenceRange(
        receipt.receipt.firstSequence,
        receipt.receipt.lastSequence,
      );
      expect(events.map((event) => event.kind)).toEqual([
        'domain.committed',
        'config.bound',
      ]);
      expect(events[1].payload['revision']).toBe(1);
      expect(receipt.revision).toBe(3);
      expect((await commit(content('committed'), true)).receipt.replayed).toBe(
        true,
      );
      expect(authority.domainRecord('config_install')?.revision).toBe(3);
    } finally {
      await authority.close();
    }
  });

  it('refuses a commit without its atomic binding before publishing it', async () => {
    const { authority, resources, commit } = await open();
    try {
      await commit(content());
      await commit(content('prepared'));
      const publish = vi.spyOn(resources, 'publish');
      await expect(commit(content('committed'))).rejects.toThrow(
        /binding conflicts/u,
      );
      expect(publish).not.toHaveBeenCalled();
      expect(authority.domainRecord('config_install')?.revision).toBe(2);
    } finally {
      await authority.close();
    }
  });
});
