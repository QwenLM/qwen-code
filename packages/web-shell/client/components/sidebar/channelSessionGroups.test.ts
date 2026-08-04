import { describe, expect, it } from 'vitest';
import type {
  DaemonChannelInstanceSnapshot,
  DaemonChannelTypeCatalog,
  DaemonSessionSummary,
} from '@qwen-code/sdk/daemon';
import { groupSessionsByChannelType } from './channelSessionGroups';

function session(sessionId: string, sourceId?: string): DaemonSessionSummary {
  return {
    sessionId,
    workspaceCwd: '/workspace',
    sourceType: 'channel',
    sourceId,
  };
}

const catalog: DaemonChannelTypeCatalog = [
  { type: 'dingtalk', displayName: 'DingTalk', manageable: true, fields: [] },
  { type: 'feishu', displayName: 'Feishu', manageable: true, fields: [] },
];

function instance(name: string, type: string): DaemonChannelInstanceSnapshot {
  return {
    name,
    config: { type },
    secrets: {},
    startsWithServe: false,
    runtime: { state: 'stopped' },
  };
}

describe('groupSessionsByChannelType', () => {
  it('combines channel instances of the same type in first-seen order', () => {
    const groups = groupSessionsByChannelType(
      [
        session('d1', 'ding-one'),
        session('f1', 'feishu'),
        session('d2', 'ding-two'),
      ],
      catalog,
      {
        'ding-one': instance('ding-one', 'dingtalk'),
        'ding-two': instance('ding-two', 'dingtalk'),
        feishu: instance('feishu', 'feishu'),
      },
      'Other channels',
    );

    expect(
      groups.map(({ id, label, sessions }) => ({
        id,
        label,
        sessions: sessions.map((item) => item.sessionId),
      })),
    ).toEqual([
      {
        id: 'channel-type:dingtalk',
        label: 'DingTalk',
        sessions: ['d1', 'd2'],
      },
      {
        id: 'channel-type:feishu',
        label: 'Feishu',
        sessions: ['f1'],
      },
    ]);
  });

  it('treats prototype-member sourceIds as missing instances instead of crashing', () => {
    // Instance names are portable path components, so a deleted instance can
    // leave orphaned sessions whose sourceId is 'constructor'/'__proto__'.
    // A bare index read would resolve through Object.prototype and throw
    // inside the sidebar render path; they must land in the fallback group.
    const groups = groupSessionsByChannelType(
      [
        session('orphan-constructor', 'constructor'),
        session('orphan-proto', '__proto__'),
        session('d1', 'ding-one'),
      ],
      catalog,
      { 'ding-one': instance('ding-one', 'dingtalk') },
      'Other channels',
    );

    expect(
      groups.map(({ id, label, sessions }) => ({
        id,
        label,
        sessions: sessions.map((item) => item.sessionId),
      })),
    ).toEqual([
      {
        id: 'channel-type-fallback',
        label: 'Other channels',
        sessions: ['orphan-constructor', 'orphan-proto'],
      },
      {
        id: 'channel-type:dingtalk',
        label: 'DingTalk',
        sessions: ['d1'],
      },
    ]);
  });

  it('uses the raw type or fallback group when catalog metadata is incomplete', () => {
    const groups = groupSessionsByChannelType(
      [
        session('github', 'github'),
        session('legacy-one'),
        session('legacy-two'),
      ],
      catalog,
      { github: instance('github', 'github') },
      'Other channels',
    );

    expect(
      groups.map(({ id, label, sessions }) => ({
        id,
        label,
        sessions: sessions.map((item) => item.sessionId),
      })),
    ).toEqual([
      {
        id: 'channel-type:github',
        label: 'github',
        sessions: ['github'],
      },
      {
        id: 'channel-type-fallback',
        label: 'Other channels',
        sessions: ['legacy-one', 'legacy-two'],
      },
    ]);
  });
});
