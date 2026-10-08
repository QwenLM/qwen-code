/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Storage } from '../../config/storage.js';
import { mockCompromisedLock } from '../../test-utils/mock-compromised-lock.js';
import {
  getAgentsFilePath,
  getWorkspaceFilePath,
  AgentSchemaVersionError,
  readWorkspaceAgents,
  readAgentWorkspace,
  removeAgentHost,
  retireWorkspaceAgent,
  setWorkspaceAgentEnabled,
  updateWorkspaceAgent,
  issueAgentHostEnrollment,
  enrollAgentHost,
  heartbeatAgentHost,
  normalizeHostProgramProbes,
  readAgentHosts,
  isAgentAddressable,
  updateWorkspaceAgents,
  withAgentStoreTransaction,
} from './store.js';
import {
  AGENTS_SCHEMA_VERSION,
  hostAvailablePrograms,
  hostOffersProgram,
  type WorkspaceAgent,
} from './types.js';

const renameFailure = vi.hoisted(() => ({
  path: undefined as string | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (args[1] === renameFailure.path) {
        throw new Error('binding write failed');
      }
      return actual.rename(...args);
    },
  };
});

const PROJECT_ROOT = '/agent-store-test-project';
const ALICE: WorkspaceAgent = { id: 'ag_alice', name: 'alice', createdAt: 1 };
const BOB: WorkspaceAgent = { id: 'ag_bob', name: 'bob', createdAt: 1 };

async function writeRaw(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value));
}

describe('agent versioned store', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-store-test-'));
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  it('fails closed on a newer workspace schema', async () => {
    await readAgentWorkspace(PROJECT_ROOT);
    await writeRaw(getWorkspaceFilePath(PROJECT_ROOT), {
      schemaVersion: AGENTS_SCHEMA_VERSION + 1,
      workspaceId: 'ws_newer',
    });

    await expect(readAgentWorkspace(PROJECT_ROOT)).rejects.toBeInstanceOf(
      AgentSchemaVersionError,
    );
  });

  it('fails closed on a malformed current workspace schema', async () => {
    await writeRaw(getWorkspaceFilePath(PROJECT_ROOT), {
      schemaVersion: AGENTS_SCHEMA_VERSION,
      workspaceId: 'not a valid id',
    });

    await expect(readAgentWorkspace(PROJECT_ROOT)).rejects.toThrow(
      /Malformed agent workspace record/,
    );
  });

  it('fails closed on a newer agents schema', async () => {
    await readAgentWorkspace(PROJECT_ROOT);
    await writeRaw(getAgentsFilePath(PROJECT_ROOT), {
      schemaVersion: AGENTS_SCHEMA_VERSION + 1,
      agents: [],
    });

    await expect(readWorkspaceAgents(PROJECT_ROOT)).rejects.toBeInstanceOf(
      AgentSchemaVersionError,
    );
  });

  it('creates the workspace record and an empty roster on first use', async () => {
    const workspace = await readAgentWorkspace(PROJECT_ROOT);
    expect(workspace).toEqual({
      schemaVersion: AGENTS_SCHEMA_VERSION,
      workspaceId: expect.stringMatching(/^ws_/),
    });
    await expect(readWorkspaceAgents(PROJECT_ROOT)).resolves.toEqual([]);
  });

  it('reads a workspace record written by the thread-era store', async () => {
    // Those records also carried a run counter and a host-session claim; both
    // are ignored now, and the grants beside them still load.
    await writeRaw(getWorkspaceFilePath(PROJECT_ROOT), {
      schemaVersion: AGENTS_SCHEMA_VERSION,
      workspaceId: 'ws_legacy',
      nextRunSequence: 7,
      hostSessionId: 'session-1',
    });
    await writeRaw(getAgentsFilePath(PROJECT_ROOT), {
      schemaVersion: AGENTS_SCHEMA_VERSION,
      agents: [
        { ...ALICE, description: 'Reviews builds', maxConcurrentRuns: 2 },
      ],
    });

    await expect(readAgentWorkspace(PROJECT_ROOT)).resolves.toMatchObject({
      workspaceId: 'ws_legacy',
    });
    await expect(readWorkspaceAgents(PROJECT_ROOT)).resolves.toMatchObject([
      { id: ALICE.id, description: 'Reviews builds', maxConcurrentRuns: 2 },
    ]);
  });

  it('refuses a pre-release (v0) roster instead of guessing at it', async () => {
    await writeRaw(getAgentsFilePath(PROJECT_ROOT), [ALICE]);

    await expect(readWorkspaceAgents(PROJECT_ROOT)).rejects.toBeInstanceOf(
      AgentSchemaVersionError,
    );
    // Left as it was: it is the only copy of that roster.
    expect(
      JSON.parse(await fs.readFile(getAgentsFilePath(PROJECT_ROOT), 'utf8')),
    ).toEqual([ALICE]);
  });

  it('rejects nested workspace transactions instead of deadlocking', async () => {
    await expect(
      withAgentStoreTransaction(PROJECT_ROOT, () =>
        readWorkspaceAgents(PROJECT_ROOT),
      ),
    ).rejects.toThrow(/Nested agent workspace transactions/);
  });

  it('keeps a transaction result when its workspace lock is compromised', async () => {
    const { lockSpy, getOnCompromised } = mockCompromisedLock();
    try {
      await expect(
        updateWorkspaceAgents(PROJECT_ROOT, () => [ALICE]),
      ).resolves.toEqual([ALICE]);
      expect(getOnCompromised()).toBeTypeOf('function');
    } finally {
      lockSpy.mockRestore();
    }
    await expect(readWorkspaceAgents(PROJECT_ROOT)).resolves.toEqual([ALICE]);
  });

  it('consumes a fresh enrollment token without replacing a valid host', async () => {
    const first = await issueAgentHostEnrollment(PROJECT_ROOT);
    const enrolled = await enrollAgentHost(PROJECT_ROOT, {
      token: first.token,
      name: 'worker',
      workspaceCwd: '/worker',
      providers: ['Qwen Code ACP'],
    });
    const fresh = await issueAgentHostEnrollment(PROJECT_ROOT);

    await expect(
      heartbeatAgentHost(PROJECT_ROOT, enrolled.host.id, enrolled.secret, {
        workspaceCwd: '/worker',
        providers: ['Qwen Code ACP'],
        enrollmentToken: fresh.token,
      }),
    ).resolves.toMatchObject({ id: enrolled.host.id });
    await expect(
      enrollAgentHost(PROJECT_ROOT, {
        token: fresh.token,
        name: 'other',
        workspaceCwd: '/other',
        providers: ['Qwen Code ACP'],
      }),
    ).rejects.toThrow('Invalid or expired Agent Host enrollment token.');
  });

  it('stores a v2 Host program probe and forgets it when the Host drops back to v1', async () => {
    const first = await issueAgentHostEnrollment(PROJECT_ROOT);
    const enrolled = await enrollAgentHost(PROJECT_ROOT, {
      token: first.token,
      name: 'mac',
      workspaceCwd: '/worker',
      providers: ['qwen'],
    });
    const programs = [
      { program: 'qwen' as const, available: true },
      { program: 'claude' as const, available: true, version: '2.1.0' },
      { program: 'codex' as const, available: false, reason: 'missing' },
    ];

    const host = await heartbeatAgentHost(
      PROJECT_ROOT,
      enrolled.host.id,
      enrolled.secret,
      { workspaceCwd: '/worker', providers: [], programs, protocol: 2 },
    );
    expect(host).toMatchObject({ programs, protocol: 2, providers: [] });
    expect(hostAvailablePrograms(host!)).toEqual(['qwen', 'claude']);
    expect((await readAgentHosts(PROJECT_ROOT))[0]).toMatchObject({
      programs,
      protocol: 2,
    });

    const v1 = await heartbeatAgentHost(
      PROJECT_ROOT,
      enrolled.host.id,
      enrolled.secret,
      { workspaceCwd: '/worker', providers: ['Qwen Code ACP'] },
    );
    expect(v1?.programs).toBeUndefined();
    expect(v1?.protocol).toBeUndefined();
    expect(hostOffersProgram(v1!, 'qwen')).toBe(true);
    expect(hostOffersProgram(v1!, 'claude')).toBe(false);
  });

  it('normalizes a Host program probe and rejects unknown programs', () => {
    expect(
      normalizeHostProgramProbes([
        { program: 'claude', available: false },
        { program: 'claude', available: true, version: 'v'.repeat(500) },
      ]),
    ).toEqual([
      { program: 'claude', available: true, version: 'v'.repeat(200) },
    ]);
    expect(
      normalizeHostProgramProbes([{ program: 'vim', available: true }]),
    ).toBeUndefined();
    expect(normalizeHostProgramProbes('qwen')).toBeUndefined();
  });

  it('keeps a fresh enrollment token when the saved credential is invalid', async () => {
    const first = await issueAgentHostEnrollment(PROJECT_ROOT);
    const enrolled = await enrollAgentHost(PROJECT_ROOT, {
      token: first.token,
      name: 'worker',
      workspaceCwd: '/worker',
      providers: ['Qwen Code ACP'],
    });
    const fresh = await issueAgentHostEnrollment(PROJECT_ROOT);

    await expect(
      heartbeatAgentHost(PROJECT_ROOT, enrolled.host.id, 'invalid', {
        workspaceCwd: '/worker',
        providers: ['Qwen Code ACP'],
        enrollmentToken: fresh.token,
      }),
    ).resolves.toBeUndefined();
    await expect(
      enrollAgentHost(PROJECT_ROOT, {
        token: fresh.token,
        name: 'replacement',
        workspaceCwd: '/worker',
        providers: ['Qwen Code ACP'],
      }),
    ).resolves.toMatchObject({ host: { name: 'replacement' } });
  });
});

describe('removing and replacing an Agent Host', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-test-'));
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  const enroll = async (name: string, supersedesHostId?: string) => {
    const { token } = await issueAgentHostEnrollment(
      PROJECT_ROOT,
      supersedesHostId,
    );
    return enrollAgentHost(PROJECT_ROOT, {
      token,
      name,
      workspaceCwd: '/worker',
      providers: ['Qwen Code ACP'],
    });
  };

  it('unbinds agents and makes an agent whose only Host it was local', async () => {
    const a = await enroll('a');
    const b = await enroll('b');
    await updateWorkspaceAgents(PROJECT_ROOT, () => [
      { ...ALICE, execution: { mode: 'managed-host', hostIds: [a.host.id] } },
      {
        ...BOB,
        execution: { mode: 'managed-host', hostIds: [a.host.id, b.host.id] },
      },
    ]);

    await expect(removeAgentHost(PROJECT_ROOT, a.host.id)).resolves.toEqual({
      removed: true,
      agentsMadeLocal: [ALICE.id],
    });
    const roster = await readWorkspaceAgents(PROJECT_ROOT);
    expect(roster.find((agent) => agent.id === ALICE.id)?.execution).toEqual({
      mode: 'local',
    });
    expect(roster.find((agent) => agent.id === BOB.id)?.execution).toEqual({
      mode: 'managed-host',
      hostIds: [b.host.id],
    });
    expect((await readAgentHosts(PROJECT_ROOT)).map((host) => host.id)).toEqual(
      [b.host.id],
    );
  });

  it('reports an unknown Host rather than touching the roster', async () => {
    await updateWorkspaceAgents(PROJECT_ROOT, () => [ALICE]);
    await expect(removeAgentHost(PROJECT_ROOT, 'host_nobody')).resolves.toEqual(
      { removed: false },
    );
    expect(await readWorkspaceAgents(PROJECT_ROOT)).toEqual([ALICE]);
  });

  it('moves bound agents onto the replacement Host', async () => {
    const old = await enroll('old');
    const sibling = await enroll('sibling');
    await updateWorkspaceAgents(PROJECT_ROOT, () => [
      {
        ...ALICE,
        execution: {
          mode: 'managed-host',
          hostIds: [old.host.id, sibling.host.id],
        },
      },
    ]);

    const replacement = await enroll('new', old.host.id);

    // Only the replaced Host's binding moves; the agent keeps its others.
    const [alice] = await readWorkspaceAgents(PROJECT_ROOT);
    expect(alice.execution).toEqual({
      mode: 'managed-host',
      hostIds: [replacement.host.id, sibling.host.id],
    });
    expect((await readAgentHosts(PROJECT_ROOT)).map((host) => host.id)).toEqual(
      [sibling.host.id, replacement.host.id],
    );
  });

  it('keeps an interrupted replacement staged until it is retried', async () => {
    const old = await enroll('old');
    await updateWorkspaceAgents(PROJECT_ROOT, () => [
      { ...ALICE, execution: { mode: 'managed-host', hostIds: [old.host.id] } },
    ]);
    const { token } = await issueAgentHostEnrollment(PROJECT_ROOT, old.host.id);
    const input = {
      token,
      name: 'new',
      workspaceCwd: '/worker',
      providers: ['Qwen Code ACP'],
    };
    // The new identity is saved, then moving the bindings fails.
    renameFailure.path = getAgentsFilePath(PROJECT_ROOT);
    try {
      await expect(enrollAgentHost(PROJECT_ROOT, input)).rejects.toThrow(
        'binding write failed',
      );
    } finally {
      renameFailure.path = undefined;
    }
    const staged = (await readAgentHosts(PROJECT_ROOT)).find(
      (host) => host.id !== old.host.id,
    )!;

    // Neither a fresh enrollment nor removing either side may drop it.
    await expect(issueAgentHostEnrollment(PROJECT_ROOT)).rejects.toThrow(
      'Retry the pending Agent Host replacement',
    );
    await expect(removeAgentHost(PROJECT_ROOT, old.host.id)).rejects.toThrow(
      'Retry the pending Agent Host replacement',
    );
    await expect(removeAgentHost(PROJECT_ROOT, staged.id)).rejects.toThrow(
      'Retry the pending Agent Host replacement',
    );

    // The retry finishes it under the staged identity.
    const refreshed = await issueAgentHostEnrollment(PROJECT_ROOT, old.host.id);
    expect(refreshed.replacementHostId).toBe(staged.id);
    const replacement = await enrollAgentHost(PROJECT_ROOT, {
      ...input,
      token: refreshed.token,
    });
    expect(replacement.host.id).toBe(staged.id);
    expect((await readAgentHosts(PROJECT_ROOT)).map((host) => host.id)).toEqual(
      [staged.id],
    );
    expect((await readWorkspaceAgents(PROJECT_ROOT))[0]?.execution).toEqual({
      mode: 'managed-host',
      hostIds: [staged.id],
    });
  });
});

describe('retiring an agent', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-retire-test-'));
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  const seed = (agents: WorkspaceAgent[]) =>
    updateWorkspaceAgents(PROJECT_ROOT, () => agents);

  it('keeps the entry so every post it made still names its author', async () => {
    // The whole point: a chat session is read long after an agent stops
    // working, and removing the row would turn its side of the conversation
    // into an author nobody can look up.
    await seed([ALICE, BOB]);

    await expect(retireWorkspaceAgent(PROJECT_ROOT, ALICE.id)).resolves.toBe(
      'updated',
    );

    const roster = await readWorkspaceAgents(PROJECT_ROOT);
    expect(roster.map((agent) => agent.id)).toEqual([ALICE.id, BOB.id]);
    const alice = roster.find((agent) => agent.id === ALICE.id);
    expect(alice?.name).toBe('alice');
    expect(alice?.retiredAt).toEqual(expect.any(Number));
  });

  it('stops the identity taking new work without disabling it', async () => {
    // Retired and disabled are different refusals. `enabled` is untouched, so
    // a reader can tell which one happened.
    await seed([ALICE]);
    await retireWorkspaceAgent(PROJECT_ROOT, ALICE.id);

    const [alice] = await readWorkspaceAgents(PROJECT_ROOT);
    expect(isAgentAddressable(alice)).toBe(false);
    expect(alice.enabled).toBeUndefined();
  });

  it('is idempotent and does not restamp the first retirement', async () => {
    await seed([ALICE]);
    await retireWorkspaceAgent(PROJECT_ROOT, ALICE.id);
    const first = (await readWorkspaceAgents(PROJECT_ROOT))[0].retiredAt;

    await expect(retireWorkspaceAgent(PROJECT_ROOT, ALICE.id)).resolves.toBe(
      'updated',
    );

    expect((await readWorkspaceAgents(PROJECT_ROOT))[0].retiredAt).toBe(first);
  });

  it('refuses to enable a retired identity instead of reporting success', async () => {
    // Enabling one would change nothing a caller can observe, since
    // `isAgentAddressable` still refuses it. Saying so beats a hollow 200.
    await seed([ALICE]);
    await retireWorkspaceAgent(PROJECT_ROOT, ALICE.id);

    await expect(
      setWorkspaceAgentEnabled(PROJECT_ROOT, ALICE.id, true),
    ).resolves.toBe('retired');

    const [alice] = await readWorkspaceAgents(PROJECT_ROOT);
    expect(isAgentAddressable(alice)).toBe(false);
  });

  it('makes a disabled agent addressable again when re-enabled', async () => {
    await seed([ALICE]);
    await setWorkspaceAgentEnabled(PROJECT_ROOT, ALICE.id, false);

    await expect(
      setWorkspaceAgentEnabled(PROJECT_ROOT, ALICE.id, true),
    ).resolves.toBe('updated');
    const [alice] = await readWorkspaceAgents(PROJECT_ROOT);
    expect(isAgentAddressable(alice)).toBe(true);
  });

  it('checks concurrent persona and placement patches against the locked roster', async () => {
    await seed([ALICE]);
    const enrollment = await issueAgentHostEnrollment(PROJECT_ROOT);
    const { host } = await enrollAgentHost(PROJECT_ROOT, {
      token: enrollment.token,
      name: 'worker',
      workspaceCwd: '/worker',
      providers: ['Qwen Code ACP'],
    });
    const results = await Promise.all([
      updateWorkspaceAgent(PROJECT_ROOT, ALICE.id, {
        execution: {
          mode: 'managed-host',
          hostIds: [host.id],
          provider: 'qwen',
        },
      }),
      updateWorkspaceAgent(PROJECT_ROOT, ALICE.id, {
        applyConfig: (agent) => ({ ...agent, model: 'custom-model' }),
      }),
    ]);
    expect(results.sort()).toEqual([
      'managed_host_persona_unsupported',
      'updated',
    ]);
    const [agent] = await readWorkspaceAgents(PROJECT_ROOT);
    expect(
      agent.execution?.mode === 'managed-host' && Boolean(agent.model),
    ).toBe(false);
  });

  it('reports an unknown id rather than inventing an entry', async () => {
    await seed([ALICE]);

    await expect(retireWorkspaceAgent(PROJECT_ROOT, 'ag_nobody')).resolves.toBe(
      'not_found',
    );
    expect(await readWorkspaceAgents(PROJECT_ROOT)).toHaveLength(1);
  });
});
