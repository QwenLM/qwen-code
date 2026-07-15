import { describe, expect, it } from 'vitest';
import { parseChannelMemoryIntent } from './channel-memory-intent.js';

describe('parseChannelMemoryIntent', () => {
  it('parses Chinese remember prefixes', () => {
    expect(parseChannelMemoryIntent('记住：默认使用 staging 环境')).toEqual({
      kind: 'remember',
      text: '默认使用 staging 环境',
    });
    expect(
      parseChannelMemoryIntent('帮我记一下，发布前跑 npm run build'),
    ).toEqual({
      kind: 'remember',
      text: '发布前跑 npm run build',
    });
    expect(parseChannelMemoryIntent('以后记住要先看 CI')).toEqual({
      kind: 'remember',
      text: '要先看 CI',
    });
  });

  it('parses English remember prefixes', () => {
    expect(parseChannelMemoryIntent('remember: use staging')).toEqual({
      kind: 'remember',
      text: 'use staging',
    });
  });

  it('does not parse empty remember text', () => {
    expect(parseChannelMemoryIntent('记住：   ')).toBeNull();
    expect(parseChannelMemoryIntent('remember:')).toBeNull();
  });

  it('parses list requests', () => {
    expect(parseChannelMemoryIntent('你现在记住了什么？')).toEqual({
      kind: 'list',
      page: 1,
    });
    expect(parseChannelMemoryIntent('查看记忆')).toEqual({
      kind: 'list',
      page: 1,
    });
    expect(parseChannelMemoryIntent('查看记忆\u200b')).toEqual({
      kind: 'list',
      page: 1,
    });
    expect(parseChannelMemoryIntent('what do you remember?')).toEqual({
      kind: 'list',
      page: 1,
    });
  });

  it('parses deterministic item intents', () => {
    expect(parseChannelMemoryIntent('查看第 2 页记忆')).toEqual({
      kind: 'list',
      page: 2,
    });
    expect(parseChannelMemoryIntent('show memory page 3')).toEqual({
      kind: 'list',
      page: 3,
    });
    expect(parseChannelMemoryIntent('查看记忆 m-a31f0d82c7e4')).toEqual({
      kind: 'inspect',
      id: 'm-a31f0d82c7e4',
    });
    expect(parseChannelMemoryIntent('show memory m-a31f0d82c7e4')).toEqual({
      kind: 'inspect',
      id: 'm-a31f0d82c7e4',
    });
    expect(parseChannelMemoryIntent('忘掉 m-a31f0d82c7e4')).toEqual({
      kind: 'remove',
      id: 'm-a31f0d82c7e4',
    });
    expect(parseChannelMemoryIntent('forget m-a31f0d82c7e4')).toEqual({
      kind: 'remove',
      id: 'm-a31f0d82c7e4',
    });
    expect(
      parseChannelMemoryIntent('把 m-a31f0d82c7e4 改成默认使用 production'),
    ).toEqual({
      kind: 'update',
      id: 'm-a31f0d82c7e4',
      text: '默认使用 production',
    });
    expect(
      parseChannelMemoryIntent('update m-a31f0d82c7e4 to use production'),
    ).toEqual({
      kind: 'update',
      id: 'm-a31f0d82c7e4',
      text: 'use production',
    });
  });

  it('rejects invalid item intent arguments', () => {
    expect(parseChannelMemoryIntent('忘掉 m-not-valid')).toBeNull();
    expect(parseChannelMemoryIntent('查看第 0 页记忆')).toBeNull();
    expect(parseChannelMemoryIntent('查看第 -1 页记忆')).toBeNull();
    expect(parseChannelMemoryIntent('show memory page 1.5')).toBeNull();
    expect(parseChannelMemoryIntent('把 m-a31f0d82c7e4 改成   ')).toBeNull();
    expect(parseChannelMemoryIntent('/forget m-a31f0d82c7e4')).toBeNull();
  });

  it('parses item updates before broad clear requests', () => {
    expect(
      parseChannelMemoryIntent('把 m-a31f0d82c7e4 改成默认的记忆清空'),
    ).toEqual({
      kind: 'update',
      id: 'm-a31f0d82c7e4',
      text: '默认的记忆清空',
    });
  });

  it('parses clear request and clear confirmation', () => {
    expect(parseChannelMemoryIntent('清空记忆')).toEqual({
      kind: 'clear_request',
    });
    expect(parseChannelMemoryIntent('忘掉这个聊天的所有记忆')).toEqual({
      kind: 'clear_request',
    });
    expect(parseChannelMemoryIntent('确认清空记忆')).toEqual({
      kind: 'clear_confirm',
    });
    expect(parseChannelMemoryIntent('confirm clear memory')).toEqual({
      kind: 'clear_confirm',
    });
  });

  it('leaves ambiguous prose alone', () => {
    expect(parseChannelMemoryIntent('保存配置到本地')).toBeNull();
    expect(parseChannelMemoryIntent('我想讨论一下记忆模块')).toBeNull();
    expect(
      parseChannelMemoryIntent('Remember that bug we fixed last week?'),
    ).toBeNull();
    expect(
      parseChannelMemoryIntent('remember this might be tricky later'),
    ).toBeNull();
    expect(
      parseChannelMemoryIntent('/remember-channel use staging'),
    ).toBeNull();
  });
});
