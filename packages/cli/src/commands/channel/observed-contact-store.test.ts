import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ObservedChannelContactStore } from './observed-contact-store.js';

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

  it('keeps the same user in both direct and group observations', () => {
    const store = createStore();
    store.observe('feishu', {
      user: { id: 'user-1', label: 'User One' },
    });
    store.observe('feishu', {
      user: { id: 'user-1', label: 'User One' },
      group: { id: 'group-1', label: 'group-1' },
    });

    const graph = store.list({ freshWithinSeconds: 604800 });
    expect(graph.users.map((user) => user.id)).toEqual(['user-1']);
    expect(graph.groups[0]?.users.map((user) => user.id)).toEqual(['user-1']);
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

  it('drops observations older than the maximum readable window on write', () => {
    const store = createStore();
    store.observe('wecom', {
      user: { id: 'stale-user', label: 'Stale User' },
    });
    now = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000 + 1000);
    store.observe('wecom', {
      user: { id: 'fresh-user', label: 'Fresh User' },
    });

    const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as {
      observations: Array<{ user: { id: string } }>;
    };
    expect(persisted.observations.map((item) => item.user.id)).toEqual([
      'fresh-user',
    ]);
  });

  it('preserves complete IDs while truncating fallback labels', () => {
    const store = createStore();
    const longId = 'x'.repeat(300);

    store.observe('telegram', {
      user: { id: longId, label: longId },
      group: { id: longId, label: longId },
    });

    const group = store.list({ freshWithinSeconds: 604800 }).groups[0];
    expect(group?.id).toBe(longId);
    expect(group?.label).toBe('x'.repeat(256));
    expect(group?.users[0]?.id).toBe(longId);
    expect(group?.users[0]?.label).toBe('x'.repeat(256));
  });

  it('does not split a Unicode surrogate pair when truncating labels', () => {
    const store = createStore();

    store.observe('feishu', {
      user: {
        id: 'user-1',
        label: `${'x'.repeat(255)}😀suffix`,
      },
    });

    expect(store.list({ freshWithinSeconds: 604800 }).users[0]?.label).toBe(
      'x'.repeat(255),
    );
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
