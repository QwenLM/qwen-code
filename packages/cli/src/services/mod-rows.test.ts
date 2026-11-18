/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ModAssistantMessageInput } from '@qwen-code/qwen-code-core/mods/render-tree.js';
import { ModRows } from './mod-rows.js';

const row = (requestId: string, text = `text ${requestId}`) =>
  ({
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId,
    props: { text, isFirstOfReply: true },
  }) satisfies ModAssistantMessageInput;

// A session's dispatch queue: tasks run one after another, in order.
function queue() {
  let tail = Promise.resolve();
  const ran: string[] = [];
  return {
    ran,
    schedule: (task: () => Promise<void>) => {
      tail = tail.then(task);
    },
    other: (name: string) => {
      tail = tail.then(async () => void ran.push(name));
    },
    settled: async () => {
      for (let i = 0; i < 20; i++) await tail;
    },
  };
}

describe('ModRows', () => {
  it('renders one row at a time, so other dispatches wait behind one row', async () => {
    const dispatches = queue();
    const releases: Array<() => void> = [];
    const rows = new ModRows(dispatches.schedule, async (input) => {
      dispatches.ran.push(`row ${input.requestId}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { ...input.props, text: `译 ${input.requestId}` };
    });
    for (const id of ['1', '2', '3']) rows.watch(row(id), () => {});
    dispatches.other('tool.call');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]!();
    await vi.waitFor(() => expect(dispatches.ran).toContain('tool.call'));
    expect(dispatches.ran.slice(0, 2)).toEqual(['row 1', 'tool.call']);
    for (let i = 1; i < 3; i++) {
      await vi.waitFor(() => expect(releases).toHaveLength(i + 1));
      releases[i]!();
    }
    await dispatches.settled();
    expect(rows.get(row('3'))).toEqual({
      text: '译 3',
      isFirstOfReply: true,
    });
  });

  it('skips a row no longer shown and keeps answers for a remount', async () => {
    const dispatches = queue();
    const render = vi.fn(async (input: ModAssistantMessageInput) => ({
      ...input.props,
      text: `译 ${input.requestId}`,
    }));
    const rows = new ModRows(dispatches.schedule, async (input) =>
      render(input as ModAssistantMessageInput),
    );
    const heard = vi.fn();
    const releaseFirst = rows.watch(row('1'), heard);
    const release = rows.watch(row('2'), () => {});
    release();
    await dispatches.settled();
    expect(render.mock.calls.map(([input]) => input.requestId)).toEqual(['1']);
    expect(heard).toHaveBeenCalledTimes(1);
    // A remount can read the answer before its subscription runs.
    releaseFirst();
    expect(rows.get(row('1'))).toEqual({
      text: '译 1',
      isFirstOfReply: true,
    });
    const edited = row('1', 'edited');
    expect(rows.get(edited)).toBeUndefined();
    rows.watch(row('1'), () => {});
    await dispatches.settled();
    expect(render).toHaveBeenCalledTimes(1);
    // A changed input renders again.
    rows.watch(edited, () => {});
    expect(rows.get(edited)).toBeUndefined();
    await dispatches.settled();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('skips a row hidden while waiting behind another dispatch', async () => {
    const dispatches = queue();
    const render = vi.fn(async () => undefined);
    const rows = new ModRows(dispatches.schedule, render);
    dispatches.other('tool.call');
    const release = rows.watch(row('1'), () => {});
    release();
    await dispatches.settled();
    expect(dispatches.ran).toEqual(['tool.call']);
    expect(render).not.toHaveBeenCalled();

    rows.watch(row('1'), () => {});
    await dispatches.settled();
    expect(render).toHaveBeenCalledOnce();
  });

  it('trims the cache once queued rows are skipped', async () => {
    const dispatches = queue();
    const render = vi.fn(async () => undefined);
    const rows = new ModRows(dispatches.schedule, render);
    dispatches.other('tool.call');
    for (let id = 0; id < 1_100; id++) rows.watch(row(String(id)), () => {})();

    await dispatches.settled();
    expect(render).not.toHaveBeenCalled();
    expect(rows['rows'].size).toBeLessThanOrEqual(1_000);
  });

  it('renders shown rows again on invalidate, drawing the old answer meanwhile', async () => {
    const dispatches = queue();
    let round = 0;
    const releases: Array<() => void> = [];
    const rows = new ModRows(dispatches.schedule, async (input) => {
      const answer = { ...input.props, text: `round ${round}` };
      if (round === 1) await new Promise<void>((r) => releases.push(r));
      return answer;
    });
    const heard = vi.fn();
    rows.watch(row('1'), heard);
    await dispatches.settled();
    round = 1;
    rows.invalidate('AssistantMessage');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(rows.get(row('1'))).toMatchObject({ text: 'round 0' });
    // Asked again while it renders: it renders once more after.
    round = 2;
    rows.invalidate('AssistantMessage');
    releases[0]!();
    await dispatches.settled();
    expect(rows.get(row('1'))).toMatchObject({ text: 'round 2' });
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it('on clear drops old rows and waits for new subscriptions', async () => {
    const dispatches = queue();
    let session = 'old';
    const render = vi.fn(async (input: ModAssistantMessageInput) => ({
      ...input.props,
      text: `${session} ${input.requestId}`,
    }));
    const rows = new ModRows(dispatches.schedule, async (input) =>
      render(input as ModAssistantMessageInput),
    );
    const heard = vi.fn();
    const releaseOld = rows.watch(row('1'), heard);
    rows.watch(row('2'), () => {})();
    await dispatches.settled();
    expect(render).toHaveBeenCalledTimes(1);
    session = 'new';
    rows.clear();
    expect(rows.get(row('1'))).toBeUndefined();
    await dispatches.settled();
    expect(render).toHaveBeenCalledTimes(1);

    rows.watch(row('1'), heard);
    releaseOld();
    await dispatches.settled();
    expect(rows.get(row('1'))).toMatchObject({ text: 'new 1' });
    expect(render.mock.calls.map(([input]) => input.requestId)).toEqual([
      '1',
      '1',
    ]);
    // Answer, clear, answer.
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it('keeps the row as it is when its render fails', async () => {
    const dispatches = queue();
    const render = vi.fn(async () => {
      throw new Error('worker closed');
    });
    const rows = new ModRows(dispatches.schedule, render);
    const release = rows.watch(row('1'), () => {});
    await dispatches.settled();
    expect(rows.get(row('1'))).toBeUndefined();
    release();
    rows.watch(row('1'), () => {});
    await dispatches.settled();
    expect(render).toHaveBeenCalledOnce();
  });

  describe('a client that asks once', () => {
    it('answers a rewrite, then from the cache, and a row its hooks left alone', async () => {
      const dispatches = queue();
      const render = vi.fn(async (input: ModAssistantMessageInput) =>
        input.requestId === '1'
          ? { ...input.props, text: `译 ${input.requestId}` }
          : undefined,
      );
      const rows = new ModRows(dispatches.schedule, async (input) =>
        render(input as ModAssistantMessageInput),
      );
      const signal = new AbortController().signal;
      await expect(rows.ask(row('1'), signal)).resolves.toEqual({
        props: { text: '译 1', isFirstOfReply: true },
      });
      await expect(rows.ask(row('1'), signal)).resolves.toEqual({
        props: { text: '译 1', isFirstOfReply: true },
      });
      await expect(rows.ask(row('2'), signal)).resolves.toEqual({});
      await expect(rows.ask(row('2'), signal)).resolves.toEqual({});
      expect(render).toHaveBeenCalledTimes(2);
    });

    it('settles every client when an invalidated desktop row fails and retries on the next ask', async () => {
      const dispatches = queue();
      const input = { ...row('1'), surface: 'desktop' } as const;
      const render = vi
        .fn(async () => ({ ...input.props, text: 'retried' }))
        .mockResolvedValueOnce({ ...input.props, text: 'first' })
        .mockRejectedValueOnce(new Error('render failed'));
      const rows = new ModRows(dispatches.schedule, render);
      const signal = new AbortController().signal;
      await expect(rows.ask(input, signal)).resolves.toEqual({
        props: { ...input.props, text: 'first' },
      });

      rows.invalidate('AssistantMessage');
      const results = await Promise.all([
        rows.ask(input, signal),
        rows.ask(input, signal),
      ]);
      expect(results).toEqual([undefined, undefined]);
      await dispatches.settled();
      expect(render).toHaveBeenCalledTimes(2);

      await expect(rows.ask(input, signal)).resolves.toEqual({
        props: { ...input.props, text: 'retried' },
      });
      expect(render).toHaveBeenCalledTimes(3);
    });

    it('asks again for a row invalidated since, and once for two clients', async () => {
      const dispatches = queue();
      let round = 0;
      const render = vi.fn(async (input: ModAssistantMessageInput) => ({
        ...input.props,
        text: `${++round} ${input.requestId}`,
      }));
      const rows = new ModRows(dispatches.schedule, async (input) =>
        render(input as ModAssistantMessageInput),
      );
      const signal = new AbortController().signal;
      const [first, second] = await Promise.all([
        rows.ask(row('1'), signal),
        rows.ask(row('1'), signal),
      ]);
      expect(first).toEqual(second);
      expect(render).toHaveBeenCalledTimes(1);
      rows.invalidate('AssistantMessage');
      await expect(rows.ask(row('1'), signal)).resolves.toEqual({
        props: { text: '2 1', isFirstOfReply: true },
      });
    });

    it('answers none once aborted or cleared, and leaves no row in the queue', async () => {
      const dispatches = queue();
      const releases: Array<() => void> = [];
      const render = vi.fn(async (input: ModAssistantMessageInput) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return { ...input.props, text: `译 ${input.requestId}` };
      });
      const rows = new ModRows(dispatches.schedule, async (input) =>
        render(input as ModAssistantMessageInput),
      );
      const running = rows.ask(row('1'), new AbortController().signal);
      const aborted = new AbortController();
      const waiting = rows.ask(row('2'), aborted.signal);
      aborted.abort();
      await expect(waiting).resolves.toBeUndefined();
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      rows.clear();
      await expect(running).resolves.toBeUndefined();
      releases[0]!();
      await dispatches.settled();
      // The aborted row was never rendered.
      expect(render.mock.calls.map(([input]) => input.requestId)).toEqual([
        '1',
      ]);
      await expect(
        rows.ask(row('3'), AbortSignal.abort()),
      ).resolves.toBeUndefined();
    });
  });
});
