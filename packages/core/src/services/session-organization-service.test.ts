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

describe('SessionOrganizationService', () => {
  let previousRuntimeDir: string | undefined;
  let runtimeDir: string;
  let service: SessionOrganizationService;
  let warnings: string[];

  const cwd = '/workspace/project';
  const sessionIdA = '550e8400-e29b-41d4-a716-446655440000';
  const sessionIdB = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  beforeEach(async () => {
    previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-org-'));
    process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    warnings = [];
    service = new SessionOrganizationService(cwd, (warning) => {
      warnings.push(warning);
    });
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
    const group = await service.createGroup({
      name: ' Frontend ',
      color: 'blue',
    });

    expect(group).toEqual(
      expect.objectContaining({
        name: 'Frontend',
        color: 'blue',
        order: 0,
      }),
    );

    await expect(
      service.createGroup({ name: 'frontend', color: 'green' }),
    ).rejects.toMatchObject({ code: 'group_name_conflict' });

    const renamed = await service.updateGroup(group.id, {
      name: 'UI',
      color: 'purple',
      order: 5,
    });

    expect(renamed).toEqual(
      expect.objectContaining({
        id: group.id,
        name: 'UI',
        color: 'purple',
        order: 5,
      }),
    );
  });

  it('rejects invalid group names and colors', async () => {
    await expect(
      service.createGroup({ name: 'Bad\tName', color: 'blue' }),
    ).rejects.toMatchObject({
      code: 'invalid_group_name',
      field: 'name',
    });

    await expect(
      service.createGroup({ name: 'Bad\u007fName', color: 'blue' }),
    ).rejects.toMatchObject({
      code: 'invalid_group_name',
      field: 'name',
    });

    await expect(
      service.createGroup({ name: '\u200b', color: 'blue' }),
    ).rejects.toMatchObject({
      code: 'invalid_group_name',
      field: 'name',
    });

    await expect(
      service.createGroup({ name: 'Bad\u202eName', color: 'blue' }),
    ).rejects.toMatchObject({
      code: 'invalid_group_name',
      field: 'name',
    });

    await expect(
      service.createGroup({ name: 'Feature', color: 'pink' as never }),
    ).rejects.toMatchObject({
      code: 'invalid_group_color',
      field: 'color',
    });
  });

  it('assigns new group order after the current maximum order', async () => {
    const first = await service.createGroup({ name: 'First', color: 'red' });
    const second = await service.createGroup({
      name: 'Second',
      color: 'green',
    });
    await service.updateGroup(second.id, { order: 10 });
    await service.deleteGroup(first.id);

    const third = await service.createGroup({ name: 'Third', color: 'blue' });

    expect(third.order).toBe(11);
  });

  it('clamps new group order at the maximum safe integer', async () => {
    const first = await service.createGroup({ name: 'First', color: 'red' });
    await service.updateGroup(first.id, { order: Number.MAX_SAFE_INTEGER });

    const second = await service.createGroup({
      name: 'Second',
      color: 'green',
    });

    expect(second.order).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('keeps groups with unsupported stored colors by falling back and warning once', async () => {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(
      service.getStorePath(),
      JSON.stringify({
        schemaVersion: 1,
        groups: [
          {
            id: 'group-future',
            name: 'Future',
            color: 'teal',
            order: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        sessions: {
          [sessionIdA]: {
            groupId: 'group-future',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );

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
    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.get(sessionIdA)).toEqual(
      expect.objectContaining({
        groupId: 'group-future',
      }),
    );
    await new SessionOrganizationService(cwd, (warning) => {
      warnings.push(warning);
    }).listGroups();

    expect(warnings).toEqual([
      'Session group "Future" (id: group-future) uses unsupported color "teal"; using "blue"',
    ]);
  });

  it('warns when dropping duplicate group names from the sidecar', async () => {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(
      service.getStorePath(),
      JSON.stringify({
        schemaVersion: 1,
        groups: [
          {
            id: 'group-a',
            name: 'Work',
            color: 'red',
            order: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'group-b',
            name: 'work',
            color: 'blue',
            order: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        sessions: {},
      }),
      'utf8',
    );

    await expect(service.listGroups()).resolves.toEqual({
      groups: [
        expect.objectContaining({
          id: 'group-a',
          name: 'Work',
        }),
      ],
      colorOptions: GROUP_COLOR_OPTIONS,
    });
    expect(warnings).toEqual([
      'Dropped duplicate session group by name: "work" (id: group-b)',
    ]);
  });

  it('pins sessions and assigns them to a single custom group', async () => {
    const group = await service.createGroup({ name: 'Release', color: 'red' });

    const org = await service.updateSessionOrganization(sessionIdA, {
      isPinned: true,
      groupId: group.id,
    });

    expect(org).toEqual(
      expect.objectContaining({
        groupId: group.id,
        isPinned: true,
      }),
    );
    expect(org.pinnedAt).toEqual(expect.any(String));

    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.get(sessionIdA)).toEqual(
      expect.objectContaining({
        groupId: group.id,
        isPinned: true,
      }),
    );
  });

  it('unpins a session and clears pinnedAt', async () => {
    await service.updateSessionOrganization(sessionIdA, { isPinned: true });

    const org = await service.updateSessionOrganization(sessionIdA, {
      isPinned: false,
    });

    expect(org).toEqual(
      expect.objectContaining({
        groupId: null,
        isPinned: false,
      }),
    );
    expect(org.pinnedAt).toBeUndefined();
    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.get(sessionIdA)).toEqual(
      expect.objectContaining({ isPinned: false }),
    );
  });

  it('treats an empty session organization update as a no-op', async () => {
    const pinned = await service.updateSessionOrganization(sessionIdA, {
      isPinned: true,
    });
    const storeBefore = await fs.readFile(service.getStorePath(), 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 5));

    const org = await service.updateSessionOrganization(sessionIdA, {});

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
      service.updateSessionOrganization(sessionIdA, {
        groupId: 'missing-group',
      }),
    ).rejects.toMatchObject({ code: 'group_not_found', field: 'groupId' });
  });

  it('deleting a group clears session references without losing pinned state', async () => {
    const group = await service.createGroup({
      name: 'Research',
      color: 'yellow',
    });
    await service.updateSessionOrganization(sessionIdA, {
      isPinned: true,
      groupId: group.id,
    });
    await service.updateSessionOrganization(sessionIdB, { groupId: group.id });

    await service.deleteGroup(group.id);

    const snapshot = await service.readSnapshot();
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.sessions.get(sessionIdA)).toEqual(
      expect.objectContaining({ groupId: null, isPinned: true }),
    );
    expect(snapshot.sessions.get(sessionIdB)).toEqual(
      expect.objectContaining({ groupId: null, isPinned: false }),
    );
  });

  it('warns once when reading orphaned group references', async () => {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(
      service.getStorePath(),
      JSON.stringify({
        schemaVersion: 1,
        groups: [],
        sessions: {
          [sessionIdA]: {
            groupId: 'missing-group',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );

    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.get(sessionIdA)).toEqual(
      expect.objectContaining({
        groupId: null,
        isPinned: false,
      }),
    );
    await service.readSnapshot();
    await new SessionOrganizationService(cwd, (warning) => {
      warnings.push(warning);
    }).readSnapshot();

    expect(warnings).toEqual([
      `Dropped orphaned session group reference: session ${sessionIdA} references missing group missing-group`,
    ]);
  });

  it('warns once when reading malformed session entries', async () => {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(
      service.getStorePath(),
      JSON.stringify({
        schemaVersion: 1,
        groups: [],
        sessions: {
          [sessionIdA]: 'bad-entry',
        },
      }),
      'utf8',
    );

    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.has(sessionIdA)).toBe(false);
    await new SessionOrganizationService(cwd, (warning) => {
      warnings.push(warning);
    }).readSnapshot();

    expect(warnings).toEqual([
      `Dropped malformed session organization entry: ${sessionIdA}`,
    ]);
  });

  it('treats a malformed sidecar as empty for reads and refuses to overwrite it', async () => {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(service.getStorePath(), '{not-json', 'utf8');

    await expect(service.listGroups()).resolves.toEqual({
      groups: [],
      colorOptions: GROUP_COLOR_OPTIONS,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Failed to read session organization store');
    await service.listGroups();
    expect(warnings).toHaveLength(1);

    await expect(
      service.createGroup({ name: 'Fixed', color: 'orange' }),
    ).rejects.toMatchObject({
      code: 'session_organization_store_unreadable',
    });
    await expect(
      service.createGroup({ name: 'Fixed Again', color: 'orange' }),
    ).rejects.toThrow('Delete the file to reset session organization');

    await expect(fs.readFile(service.getStorePath(), 'utf8')).resolves.toBe(
      '{not-json',
    );
  });

  it('includes schema version details in unreadable store warnings', async () => {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(
      service.getStorePath(),
      JSON.stringify({
        schemaVersion: 2,
        groups: [],
        sessions: {},
      }),
      'utf8',
    );

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
    const group = await service.createGroup({
      name: 'Cleanup',
      color: 'purple',
    });
    await service.updateSessionOrganization(sessionIdA, {
      isPinned: true,
      groupId: group.id,
    });

    await service.removeSession(sessionIdA);

    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.has(sessionIdA)).toBe(false);
  });
});
