import { describe, expect, it, vi } from 'vitest';
import type { DaemonModRow, DaemonModRowAnswer } from '@qwen-code/sdk/daemon';
import { ModRowAsker, modRowAsker } from './mod-rows';

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

  it("keeps a session's answers across remounts, asking with the latest ask", async () => {
    const first = asked();
    const asker = modRowAsker('session-a', first.ask);
    const second = asked();
    expect(modRowAsker('session-a', second.ask)).toBe(asker);
    expect(modRowAsker('session-b', second.ask)).not.toBe(asker);
    asker.watch(row('one'), () => {});
    expect(first.ask).not.toHaveBeenCalled();
    expect(second.ask).toHaveBeenCalledOnce();
  });
});
