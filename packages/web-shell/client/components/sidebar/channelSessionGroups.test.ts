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

  it('uses the raw type or fallback group when catalog metadata is incomplete', () => {
    const groups = groupSessionsByChannelType(
      [session('github', 'github'), session('legacy')],
      catalog,
      { github: instance('github', 'github') },
      'Other channels',
    );

    expect(groups.map(({ label }) => label)).toEqual([
      'github',
      'Other channels',
    ]);
  });
});
