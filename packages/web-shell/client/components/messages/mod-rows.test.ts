import { describe, expect, it, vi } from 'vitest';
import type { DaemonModRow, DaemonModRowAnswer } from '@qwen-code/sdk/daemon';
import type { Message } from '../../adapters/types';
import { ModRowAsker, modReplyRows } from './mod-rows';

const row = (text: string): DaemonModRow => ({
  component: 'AssistantMessage',
  props: { text, isFirstOfReply: true },
});

function asked() {
  const pending: Array<{
    row: DaemonModRow;
    answer: (answer: DaemonModRowAnswer) => void;
    fail: () => void;
  }> = [];
  const ask = vi.fn(
    (asked: DaemonModRow) =>
      new Promise<DaemonModRowAnswer>((resolve, reject) =>
        pending.push({
          row: asked,
          answer: resolve,
          fail: () => reject(new Error('daemon gone')),
        }),
      ),
  );
  return { ask, pending };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('ModRowAsker', () => {
  it('asks one row at a time and skips a row released before its turn', async () => {
    const { ask, pending } = asked();
    const asker = new ModRowAsker(ask);
    const heard = vi.fn();
    asker.watch(row('one'), heard);
    const release = asker.watch(row('two'), () => {});
    asker.watch(row('three'), () => {});
    expect(ask).toHaveBeenCalledOnce();
    release();
    pending[0]!.answer({
      status: 'answered',
      props: { text: '一', isFirstOfReply: true },
    });
    await settle();
    expect(heard).toHaveBeenCalledOnce();
    expect(asker.answer(row('one'))).toEqual({
      text: '一',
      isFirstOfReply: true,
    });
    expect(ask.mock.calls.map(([asked]) => asked.props['text'])).toEqual([
      'one',
      'three',
    ]);
    pending[1]!.answer({ status: 'answered' });
    await settle();
    // Answered and left as it is: drawn from the cache, never asked again.
    expect(asker.answer(row('three'))).toBeNull();
    asker.watch(row('three'), () => {});
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('asks again for a row that failed or went unanswered', async () => {
    const { ask, pending } = asked();
    const asker = new ModRowAsker(ask);
    asker.watch(row('one'), () => {});
    pending[0]!.fail();
    await settle();
    expect(asker.answer(row('one'))).toBeUndefined();
    asker.watch(row('one'), () => {});
    pending[1]!.answer({ status: 'unanswered' });
    await settle();
    expect(asker.answer(row('one'))).toBeUndefined();
    asker.watch(row('one'), () => {});
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('asks no more once the session says no hook hears the site', async () => {
    const { ask, pending } = asked();
    const asker = new ModRowAsker(ask);
    asker.watch(row('one'), () => {});
    asker.watch(row('two'), () => {});
    pending[0]!.answer({ status: 'unhooked' });
    await settle();
    asker.watch(row('three'), () => {});
    expect(ask).toHaveBeenCalledOnce();
  });

  it('keeps asking for reply rows once thinking rows are unhooked', async () => {
    const { ask, pending } = asked();
    const asker = new ModRowAsker(ask);
    const thought = (text: string): DaemonModRow => ({
      component: 'Thinking',
      props: { text },
    });
    asker.watch(thought('plan'), () => {});
    asker.watch(row('one'), () => {});
    pending[0]!.answer({ status: 'unhooked' });
    await settle();
    asker.watch(thought('another plan'), () => {});
    expect(ask.mock.calls.map(([asked]) => asked.component)).toEqual([
      'Thinking',
      'AssistantMessage',
    ]);
    pending[1]!.answer({
      status: 'answered',
      props: { text: '一', isFirstOfReply: true },
    });
    await settle();
    expect(asker.answer(row('one'))).toEqual({
      text: '一',
      isFirstOfReply: true,
    });
    expect(ask).toHaveBeenCalledTimes(2);
  });
});

it('classifies main replies and preserves continuation across thoughts and Mod logs', () => {
  const reply = (id: string) => ({
    id,
    role: 'assistant' as const,
    content: id,
  });
  const messages: Message[] = [
    { id: 'user', role: 'user', content: 'prompt' },
    reply('first'),
    {
      id: 'log',
      role: 'system',
      variant: 'info',
      source: 'mod_log',
      content: 'log',
    },
    { id: 'thought', role: 'thinking', content: 'thought' },
    reply('continuation'),
    { id: 'tool', role: 'tool_group', tools: [] },
    reply('afterTool'),
    { ...reply('command'), source: 'slash_command' },
    { ...reply('agent'), agentMessage: { kind: 'agent_message' } },
    { ...reply('local'), localCommandId: 'local-command' },
    reply('afterNonReplies'),
    {
      id: 'background-start',
      role: 'system',
      variant: 'info',
      source: 'background_notification_turn_started',
      content: 'Processing background results',
    },
    {
      ...reply('background-answer'),
      source: 'background_notification_response',
    },
  ];
  expect([...modReplyRows(messages)]).toEqual([
    ['first', true],
    ['continuation', false],
    ['afterTool', true],
    ['afterNonReplies', true],
    ['background-answer', true],
  ]);
});
