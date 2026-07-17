import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ObservedChannelContactStore } from './observed-target-store.js';

describe('ObservedChannelContactStore', () => {
  let filePath: string;
  let now: Date;

  beforeEach(() => {
    filePath = join(
      mkdtempSync(join(tmpdir(), 'qwen-observed-contacts-')),
      'observed-contacts.json',
    );
    now = new Date('2026-07-17T12:00:00.000Z');
  });

  function createStore(maxObservations = 500): ObservedChannelContactStore {
    return new ObservedChannelContactStore(filePath, {
      now: () => now,
      maxObservations,
    });
  }

  it('returns an empty graph when the registry is missing', () => {
    expect(
      createStore().list({ freshWithinSeconds: 7 * 24 * 60 * 60 }),
    ).toEqual({ users: [], groups: [] });
  });

  it('separates direct users from observed group and topic membership', () => {
    const store = createStore();
    store.observe('dingtalk-main', {
      user: { id: 'direct-user', label: 'Direct User' },
    });
    store.observe('dingtalk-main', {
      user: { id: 'user-1', label: 'User One' },
      group: { id: 'group-1', label: 'group-1' },
      topic: { id: 'topic-1', label: 'topic-1' },
    });

    expect(store.list({ freshWithinSeconds: 604800 })).toEqual({
      users: [
        {
          channelName: 'dingtalk-main',
          id: 'direct-user',
          label: 'Direct User',
          lastObservedAt: '2026-07-17T12:00:00.000Z',
        },
      ],
      groups: [
        {
          channelName: 'dingtalk-main',
          id: 'group-1',
          label: 'group-1',
          lastObservedAt: '2026-07-17T12:00:00.000Z',
          users: [
            {
              id: 'user-1',
              label: 'User One',
              lastObservedAt: '2026-07-17T12:00:00.000Z',
            },
          ],
          topics: [
            {
              id: 'topic-1',
              label: 'topic-1',
              lastObservedAt: '2026-07-17T12:00:00.000Z',
              users: [
                {
                  id: 'user-1',
                  label: 'User One',
                  lastObservedAt: '2026-07-17T12:00:00.000Z',
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('updates labels and timestamps when a relationship is observed again', () => {
    const store = createStore();
    store.observe('telegram', {
      user: { id: '42', label: 'Old Name' },
      group: { id: '-100', label: '-100' },
    });
    now = new Date('2026-07-18T12:00:00.000Z');
    store.observe('telegram', {
      user: { id: '42', label: 'New Name' },
      group: { id: '-100', label: 'New Group Name' },
    });

    const graph = store.list({ freshWithinSeconds: 604800 });
    expect(graph.users).toEqual([]);
    expect(graph.groups[0]).toMatchObject({
      id: '-100',
      label: 'New Group Name',
      lastObservedAt: '2026-07-18T12:00:00.000Z',
    });
    expect(graph.groups[0]?.users[0]).toMatchObject({
      id: '42',
      label: 'New Name',
      lastObservedAt: '2026-07-18T12:00:00.000Z',
    });
  });

  it('filters stale users, groups, and group-user relationships', () => {
    const store = createStore();
    store.observe('wecom', {
      user: { id: 'stale-user', label: 'Stale User' },
      group: { id: 'group-1', label: 'group-1' },
    });
    now = new Date('2026-07-25T12:00:01.000Z');

    expect(store.list({ freshWithinSeconds: 7 * 24 * 60 * 60 })).toEqual({
      users: [],
      groups: [],
    });
  });

  it('keeps the newest bounded relationship observations', () => {
    const store = createStore(2);
    for (const id of ['1', '2', '3']) {
      store.observe('feishu', { user: { id, label: `User ${id}` } });
      now = new Date(now.getTime() + 1000);
    }

    expect(
      store.list({ freshWithinSeconds: 604800 }).users.map((user) => user.id),
    ).toEqual(['3', '2']);
  });

  it('uses private file permissions where supported', () => {
    createStore().observe('telegram', {
      user: { id: '1', label: 'User One' },
    });

    if (process.platform !== 'win32') {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(statSync(join(filePath, '..')).mode & 0o777).toBe(0o700);
    }
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({
      version: 1,
    });
  });

  it('rejects malformed or unsupported registries', () => {
    writeFileSync(filePath, JSON.stringify({ version: 2, observations: [] }));
    expect(() => createStore().list({ freshWithinSeconds: 604800 })).toThrow(
      'Unsupported observed contact registry version',
    );

    writeFileSync(filePath, '{');
    expect(() => createStore().list({ freshWithinSeconds: 604800 })).toThrow(
      'Invalid observed contact registry',
    );
  });
});
