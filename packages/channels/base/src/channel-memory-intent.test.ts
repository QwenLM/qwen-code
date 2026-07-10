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
    });
    expect(parseChannelMemoryIntent('查看记忆')).toEqual({ kind: 'list' });
    expect(parseChannelMemoryIntent('查看记忆\u200b')).toEqual({
      kind: 'list',
    });
    expect(parseChannelMemoryIntent('what do you remember?')).toEqual({
      kind: 'list',
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
