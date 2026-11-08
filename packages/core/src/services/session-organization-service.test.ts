/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GROUP_COLOR_OPTIONS,
  SessionOrganizationService,
} from './session-organization-service.js';
import type {
  CreateSessionGroupInput,
  UpdateSessionOrganizationInput,
} from './session-organization-service.js';

describe('SessionOrganizationService', () => {
  let previousRuntimeDir: string | undefined;
  let runtimeDir: string;
  let service: SessionOrganizationService;
  let warnings: string[];

  const cwd = '/workspace/project';
  const sessionIdA = '550e8400-e29b-41d4-a716-446655440000';
  const sessionIdB = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const T = '2026-01-01T00:00:00.000Z';

  /** A service over the same store that reports into `warnings`. */
  const newService = () =>
    new SessionOrganizationService(cwd, (warning) => {
      warnings.push(warning);
    });
  const group = (name: string, color: CreateSessionGroupInput['color']) =>
    service.createGroup({ name, color });
  const updateOrg = (id: string, input: UpdateSessionOrganizationInput) =>
    service.updateSessionOrganization(id, input);
  const sessionEntry = async (id: string) =>
    (await service.readSnapshot()).sessions.get(id);
  const storedGroup = (id: string, name: string, color: string, order = 0) => ({
    id,
    name,
    color,
    order,
    createdAt: T,
    updatedAt: T,
  });

  async function writeStore(content: string): Promise<void> {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(service.getStorePath(), content, 'utf8');
  }
  const seedStore = (
    groups: unknown[],
    sessions: Record<string, unknown>,
    schemaVersion = 1,
  ) => writeStore(JSON.stringify({ schemaVersion, groups, sessions }));

  beforeEach(async () => {
    previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-org-'));
    process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    warnings = [];
    service = newService();
  });

  afterEach(async () => {
    if (previousRuntimeDir === undefined) {
      delete process.env['QWEN_RUNTIME_DIR'];
    } else {
      process.env['QWEN_RUNTIME_DIR'] = previousRuntimeDir;
    }
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  it('starts with no user groups and exposes fixed color options', async () => {
    const catalog = await service.listGroups();

    expect(catalog.groups).toEqual([]);
    expect(catalog.colorOptions).toEqual(GROUP_COLOR_OPTIONS);
  });

  it('creates, updates, and rejects duplicate group names case-insensitively', async () => {
    const created = await group(' Frontend ', 'blue');

    expect(created).toEqual(
      expect.objectContaining({ name: 'Frontend', color: 'blue', order: 0 }),
    );

    await expect(group('frontend', 'green')).rejects.toMatchObject({
      code: 'group_name_conflict',
    });

    const renamed = await service.updateGroup(created.id, {
      name: 'UI',
      color: 'purple',
      order: 5,
    });

    expect(renamed).toEqual(
      expect.objectContaining({
        id: created.id,
        name: 'UI',
        color: 'purple',
        order: 5,
      }),
    );
  });

  it('accepts and normalizes custom hex colors for named groups', async () => {
    const created = await group('Custom', ' #12ABef ' as never);
    expect(created.color).toBe('#12abef');

    const updated = await service.updateGroup(created.id, {
      color: ' #FEDCBA ' as never,
    });
    expect(updated.color).toBe('#fedcba');

    const catalog = await service.listGroups();
    expect(catalog.groups[0]?.color).toBe('#fedcba');
    expect(catalog.colorOptions).toEqual(GROUP_COLOR_OPTIONS);

    const restarted = new SessionOrganizationService(cwd);
    expect((await restarted.listGroups()).groups[0]?.color).toBe('#fedcba');
  });

  it('rejects invalid group names and colors', async () => {
    for (const name of ['Bad\tName', 'Bad\u007fName', '​', 'Bad‮Name']) {
      await expect(group(name, 'blue')).rejects.toMatchObject({
        code: 'invalid_group_name',
        field: 'name',
      });
    }
    for (const [name, color] of [
      ['Feature', 'pink'],
      ['Short Hex', '#abc'],
    ]) {
      await expect(group(name, color as never)).rejects.toMatchObject({
        code: 'invalid_group_color',
        field: 'color',
      });
    }
  });

  it('assigns new group order after the current maximum order', async () => {
    const first = await group('First', 'red');
    const second = await group('Second', 'green');
    await service.updateGroup(second.id, { order: 10 });
    await service.deleteGroup(first.id);

    const third = await group('Third', 'blue');

    expect(third.order).toBe(11);
  });

  it('clamps new group order at the maximum safe integer', async () => {
    const first = await group('First', 'red');
    await service.updateGroup(first.id, { order: Number.MAX_SAFE_INTEGER });

    const second = await group('Second', 'green');

    expect(second.order).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects creating more than 200 groups', async () => {
    await seedStore(
      Array.from({ length: 200 }, (_, index) =>
        storedGroup(`group-${index}`, `Group ${index}`, 'blue', index),
      ),
      {},
    );

    await expect(group('Overflow', 'red')).rejects.toMatchObject({
      code: 'group_limit_reached',
    });
  });

  it('keeps groups with unsupported stored colors by falling back and warning once', async () => {
    await seedStore([storedGroup('group-future', 'Future', 'teal')], {
      [sessionIdA]: { groupId: 'group-future', updatedAt: T },
    });

    await expect(service.listGroups()).resolves.toEqual({
      groups: [
        expect.objectContaining({
          id: 'group-future',
          name: 'Future',
          color: 'blue',
        }),
      ],
      colorOptions: GROUP_COLOR_OPTIONS,
    });
    expect(await sessionEntry(sessionIdA)).toEqual(
      expect.objectContaining({ groupId: 'group-future' }),
    );
    await newService().listGroups();

    expect(warnings).toEqual([
      'Session group "Future" (id: group-future) uses unsupported color "teal"; using "blue"',
    ]);
  });

  it('warns when dropping duplicate group names from the sidecar', async () => {
    await seedStore(
      [
        storedGroup('group-a', 'Work', 'red'),
        storedGroup('group-b', 'work', 'blue', 1),
      ],
      {},
    );

    await expect(service.listGroups()).resolves.toEqual({
      groups: [expect.objectContaining({ id: 'group-a', name: 'Work' })],
      colorOptions: GROUP_COLOR_OPTIONS,
    });
    expect(warnings).toEqual([
      'Dropped duplicate session group by name: "work" (id: group-b)',
    ]);
  });

  it('pins sessions and assigns them to a single custom group', async () => {
    const release = await group('Release', 'red');

    const org = await updateOrg(sessionIdA, {
      isPinned: true,
      groupId: release.id,
    });

    expect(org).toEqual(
      expect.objectContaining({ groupId: release.id, isPinned: true }),
    );
    expect(org.pinnedAt).toEqual(expect.any(String));
    expect(await sessionEntry(sessionIdA)).toEqual(
      expect.objectContaining({ groupId: release.id, isPinned: true }),
    );
  });

  it('unpins a session and clears pinnedAt', async () => {
    await updateOrg(sessionIdA, { isPinned: true });

    const org = await updateOrg(sessionIdA, { isPinned: false });

    expect(org).toEqual(
      expect.objectContaining({ groupId: null, isPinned: false }),
    );
    expect(org.pinnedAt).toBeUndefined();
    expect(await sessionEntry(sessionIdA)).toEqual(
      expect.objectContaining({ isPinned: false }),
    );
  });

  it('treats an empty session organization update as a no-op', async () => {
    const pinned = await updateOrg(sessionIdA, { isPinned: true });
    const storeBefore = await fs.readFile(service.getStorePath(), 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 5));

    const org = await updateOrg(sessionIdA, {});

    expect(org).toEqual(pinned);
    await expect(fs.readFile(service.getStorePath(), 'utf8')).resolves.toBe(
      storeBefore,
    );
  });

  it('rejects unknown group updates and assignments', async () => {
    await expect(
      service.updateGroup('missing-group', { name: 'Missing' }),
    ).rejects.toMatchObject({ code: 'group_not_found', field: 'groupId' });

    await expect(
      updateOrg(sessionIdA, { groupId: 'missing-group' }),
    ).rejects.toMatchObject({ code: 'group_not_found', field: 'groupId' });
  });

  it('deleting a group clears session references without losing pinned state', async () => {
    const research = await group('Research', 'yellow');
    await updateOrg(sessionIdA, { isPinned: true, groupId: research.id });
    await updateOrg(sessionIdB, { groupId: research.id });

    await service.deleteGroup(research.id);

    const snapshot = await service.readSnapshot();
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.sessions.get(sessionIdA)).toEqual(
      expect.objectContaining({ groupId: null, isPinned: true }),
    );
    expect(snapshot.sessions.get(sessionIdB)).toEqual(
      expect.objectContaining({ groupId: null, isPinned: false }),
    );
  });

  it('assigns and clears a quick color grouping tag', async () => {
    const assigned = await updateOrg(sessionIdA, { color: 'green' });
    expect(assigned).toEqual(
      expect.objectContaining({ color: 'green', groupId: null }),
    );
    expect(await sessionEntry(sessionIdA)).toEqual(
      expect.objectContaining({ color: 'green' }),
    );

    const cleared = await updateOrg(sessionIdA, { color: null });
    expect(cleared.color).toBeNull();
    expect((await sessionEntry(sessionIdA))?.color).toBeNull();
  });

  it('rejects unsupported session colors', async () => {
    for (const color of ['pink', '#12abef', ' blue ']) {
      await expect(
        updateOrg(sessionIdA, { color: color as never }),
      ).rejects.toMatchObject({ code: 'invalid_group_color', field: 'color' });
    }
  });

  it('keeps color, group, and pin independent in the store', async () => {
    const docs = await group('Docs', 'blue');
    // Core records exactly the fields provided; it never auto-clears the other
    // grouping dimension (the UI enforces the single-choice rule explicitly).
    await updateOrg(sessionIdA, { groupId: docs.id });
    const withColor = await updateOrg(sessionIdA, {
      color: 'red',
      isPinned: true,
    });
    expect(withColor).toEqual(
      expect.objectContaining({
        color: 'red',
        groupId: docs.id,
        isPinned: true,
      }),
    );
  });

  it('normalizes unknown stored session colors to null', async () => {
    await seedStore([], {
      [sessionIdA]: { groupId: null, color: 'teal', updatedAt: T },
    });

    expect(await sessionEntry(sessionIdA)).toEqual(
      expect.objectContaining({ color: null }),
    );
  });

  it('warns once when reading orphaned group references', async () => {
    await seedStore([], {
      [sessionIdA]: { groupId: 'missing-group', updatedAt: T },
    });

    expect(await sessionEntry(sessionIdA)).toEqual(
      expect.objectContaining({ groupId: null, isPinned: false }),
    );
    await service.readSnapshot();
    await newService().readSnapshot();

    expect(warnings).toEqual([
      `Dropped orphaned session group reference: session ${sessionIdA} references missing group missing-group`,
    ]);
  });

  it('warns once when reading malformed session entries', async () => {
    await seedStore([], { [sessionIdA]: 'bad-entry' });

    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.has(sessionIdA)).toBe(false);
    await newService().readSnapshot();

    expect(warnings).toEqual([
      `Dropped malformed session organization entry: ${sessionIdA}`,
    ]);
  });

  it('treats a malformed sidecar as empty for reads and refuses to overwrite it', async () => {
    await writeStore('{not-json');

    await expect(service.listGroups()).resolves.toEqual({
      groups: [],
      colorOptions: GROUP_COLOR_OPTIONS,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Failed to read session organization store');
    await service.listGroups();
    expect(warnings).toHaveLength(1);

    await expect(group('Fixed', 'orange')).rejects.toMatchObject({
      code: 'session_organization_store_unreadable',
    });
    await expect(group('Fixed Again', 'orange')).rejects.toThrow(
      'Delete the file to reset session organization',
    );

    await expect(fs.readFile(service.getStorePath(), 'utf8')).resolves.toBe(
      '{not-json',
    );
  });

  it('includes schema version details in unreadable store warnings', async () => {
    await seedStore([], {}, 2);

    await expect(service.listGroups()).resolves.toEqual({
      groups: [],
      colorOptions: GROUP_COLOR_OPTIONS,
    });

    expect(warnings).toEqual([
      expect.stringContaining(
        'store schema is unsupported (found schemaVersion 2, expected 1)',
      ),
    ]);
  });

  it('removes a session organization entry from the sidecar', async () => {
    const cleanup = await group('Cleanup', 'purple');
    await updateOrg(sessionIdA, { isPinned: true, groupId: cleanup.id });

    await service.removeSession(sessionIdA);

    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.has(sessionIdA)).toBe(false);
  });

  it('checks the runtime generation before removing an organization entry', async () => {
    await updateOrg(sessionIdA, { isPinned: true });
    const generationClosed = new Error('generation closed');

    await expect(
      service.removeSession(sessionIdA, {
        assertCanCommit: () => {
          throw generationClosed;
        },
      }),
    ).rejects.toBe(generationClosed);
    expect((await service.readSnapshot()).sessions.has(sessionIdA)).toBe(true);
  });

  it('removes multiple session organization entries in one call', async () => {
    const cleanup = await group('Cleanup', 'purple');
    await updateOrg(sessionIdA, { isPinned: true, groupId: cleanup.id });
    await updateOrg(sessionIdB, { isPinned: true, groupId: cleanup.id });

    await service.removeSessions([sessionIdA, sessionIdB, sessionIdA]);

    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.has(sessionIdA)).toBe(false);
    expect(snapshot.sessions.has(sessionIdB)).toBe(false);
  });
});
