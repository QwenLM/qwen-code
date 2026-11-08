import { describe, expect, it } from 'vitest';
import type { ChannelTaskLifecycleEvent } from '@qwen-code/channel-base';
import {
  lifecyclePresentationPhase,
  presentationPhaseLabel,
} from './presentation-phase.js';

function toolEvent(
  kind: string,
  status = 'in_progress',
): ChannelTaskLifecycleEvent {
  return {
    channelName: 'dingtalk',
    chatId: 'chat-1',
    sessionId: 'session-1',
    identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
    memoryScope: {
      namespace: 'channel:dingtalk',
      mode: 'metadata-only',
    },
    type: 'tool_call',
    toolCall: {
      sessionId: 'session-1',
      toolCallId: `tool-${kind}`,
      kind,
      title: kind,
      status,
    },
  };
}

describe('lifecyclePresentationPhase', () => {
  it.each([
    ['read', 'reading'],
    ['edit', 'editing'],
    ['delete', 'deleting'],
    ['move', 'moving'],
    ['search', 'searching'],
    ['execute', 'running'],
    ['think', 'thinking'],
    ['fetch', 'fetching'],
    ['switch_mode', 'switching'],
    ['other', 'working'],
  ] as const)('maps ACP kind %s to %s', (kind, phase) => {
    expect(lifecyclePresentationPhase(toolEvent(kind))).toBe(phase);
  });

  it('prioritizes terminal statuses over ACP kinds', () => {
    expect(lifecyclePresentationPhase(toolEvent('fetch', 'failed'))).toBe(
      'failed',
    );
    expect(lifecyclePresentationPhase(toolEvent('delete', 'completed'))).toBe(
      'thinking',
    );
  });

  it('localizes the new ACP phases', () => {
    expect(presentationPhaseLabel('fetching', 'zh-CN')).toBe('🌐 获取中');
    expect(presentationPhaseLabel('deleting', 'en-US')).toBe('🗑️ Deleting');
    expect(presentationPhaseLabel('moving', 'zh')).toBe('📦 移动中');
    expect(presentationPhaseLabel('switching', 'en')).toBe('🔄 Switching mode');
  });

  it.each([
    ['thinking', '🤔 思考中'],
    ['reading', '📖 读取中'],
    ['searching', '🔎 搜索中'],
    ['running', '🖥️ 执行中'],
    ['editing', '🛠️ 编辑中'],
    ['deleting', '🗑️ 删除中'],
    ['moving', '📦 移动中'],
    ['fetching', '🌐 获取中'],
    ['switching', '🔄 切换模式中'],
    ['working', '🛠️ 处理中'],
    ['failed', '⚠️ 工具失败'],
    ['replying', '✍️ 回复中'],
  ] as const)('localizes %s to %s', (phase, label) => {
    expect(presentationPhaseLabel(phase, 'zh')).toBe(label);
  });

  it('labels a failed tool call without claiming a retry', () => {
    expect(presentationPhaseLabel('failed', 'en')).toBe('⚠️ Tool failed');
    expect(presentationPhaseLabel('failed', 'zh')).toBe('⚠️ 工具失败');
  });

  it('falls back to English for Traditional Chinese locales', () => {
    expect(presentationPhaseLabel('reading', 'zh-TW')).toBe('📖 Reading');
    expect(presentationPhaseLabel('reading', 'zh-HK')).toBe('📖 Reading');
    expect(presentationPhaseLabel('reading', 'zh_cn')).toBe('📖 读取中');
  });

  it('keeps legacy Bridge kind matching', () => {
    expect(lifecyclePresentationPhase(toolEvent('run_shell_command'))).toBe(
      'running',
    );
    expect(lifecyclePresentationPhase(toolEvent('web_search'))).toBe(
      'searching',
    );
    expect(lifecyclePresentationPhase(toolEvent('write_file'))).toBe('editing');
    expect(lifecyclePresentationPhase(toolEvent('read_file'))).toBe('reading');
    expect(lifecyclePresentationPhase(toolEvent('custom_tool'))).toBe(
      'working',
    );
  });
});
