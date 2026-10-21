/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * Pure-logic coverage for the live-turn driver: composer attachment folding
 * (unsupported/unreadable images must surface as notices, never vanish), the
 * replay-batch fold (the transcript reset path for session switches), the
 * mid-turn queue hand-off to the next turn, and the queue taking back a
 * steering batch the stream layer could not resolve.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  ToolConfirmationOutcome,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { LivePromptOptions, WaitingCallInfo } from './live-session.js';
import {
  foldBatch,
  imagePathsToParts,
  useOpenTuiLiveTurn,
} from './live-turn.js';

// Stream-layer stub: records what each turn was handed and holds the first
// turn open until the test releases it, so a second submission lands mid-turn.
// `declines` marks 1-based turn numbers that end without yielding — the
// @-expansion decline path (an abort landing inside the read).
const live = vi.hoisted(() => ({
  turns: [] as Array<{ prompt: unknown; options: unknown }>,
  waiters: [] as Array<() => void>,
  declines: new Set<number>(),
  signals: [] as AbortSignal[],
  /** Events a 1-based turn yields ahead of the stub's bare `done`. */
  script: new Map<number, Array<Record<string, unknown>>>(),
  holds: new Set<number>(),
  errors: new Map<number, Error>(),
}));

vi.mock('./live-session.js', () => ({
  nextLivePromptId: () => `session-1########${live.turns.length}`,
  async *livePromptEvents(
    _config: unknown,
    prompt: unknown,
    signal: AbortSignal,
    options: unknown,
  ) {
    live.signals.push(signal);
    live.turns.push({ prompt, options });
    const turn = live.turns.length;
    if (turn === 1 || live.holds.has(turn)) {
      await new Promise<void>((resolve) => live.waiters.push(resolve));
    }
    if (live.errors.has(turn)) throw live.errors.get(turn);
    if (live.declines.has(turn)) return;
    for (const event of live.script.get(turn) ?? []) yield event;
    yield { type: 'done' };
  },
}));

describe('imagePathsToParts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opentui-live-turn-'));

  it('encodes a readable image as an inlineData part', () => {
    const path = join(dir, 'ok.png');
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { parts, notices } = imagePathsToParts([path]);
    expect(notices).toEqual([]);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.inlineData?.mimeType).toBe('image/png');
    expect(parts[0]?.inlineData?.data).toBe(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
    );
  });

  it('reports unsupported extensions as notices instead of parts', () => {
    const path = join(dir, 'notes.txt');
    writeFileSync(path, 'not an image');
    const { parts, notices } = imagePathsToParts([path]);
    expect(parts).toEqual([]);
    expect(notices).toEqual([`Unsupported image type: ${path}`]);
  });

  it('reports unreadable image paths as notices instead of parts', () => {
    const missing = join(dir, 'missing.jpg');
    const { parts, notices } = imagePathsToParts([missing]);
    expect(parts).toEqual([]);
    expect(notices).toEqual([`Could not read image: ${missing}`]);
  });
});

describe('foldBatch', () => {
  it('folds a replay batch into transcript items in order', () => {
    const items = foldBatch([
      { type: 'user', text: 'hello', sentToModel: true },
      { type: 'text', delta: 'hi ' },
      { type: 'text', delta: 'there' },
      { type: 'error', text: 'boom', hint: 'retry later' },
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      'user',
      'assistant',
      'error',
    ]);
    const assistant = items[1];
    // Consecutive text deltas merge into one streaming assistant row.
    expect(assistant && 'text' in assistant ? assistant.text : '').toBe(
      'hi there',
    );
  });

  it('returns an empty transcript for an empty batch', () => {
    expect(foldBatch([])).toEqual([]);
  });
});

describe('useOpenTuiLiveTurn submit paths', () => {
  beforeEach(() => {
    live.turns.length = 0;
    live.waiters.length = 0;
    live.declines.clear();
    live.signals.length = 0;
    live.script.clear();
    live.holds.clear();
    live.errors.clear();
  });

  function approval(title: string): WaitingCallInfo {
    return {
      callId: 'same-call',
      name: 'read_file',
      confirmationDetails: {
        type: 'info',
        title,
        prompt: 'Continue?',
        onConfirm: vi.fn(async () => {}),
      },
    };
  }
  function park(turn: number, call: WaitingCallInfo) {
    (live.turns[turn - 1].options as LivePromptOptions).onWaitingCall?.(call);
  }

  it.each([false, true])(
    'retains editable paste content independently from display after completion (queued: %s)',
    async (queued) => {
      const { result } = renderHook(() =>
        useOpenTuiLiveTurn({ config: {} as Config }),
      );
      const placeholder = '[Pasted Content 1200 chars]';
      const body = 'workflow pasted body'.padEnd(1200, 'x');
      const literal = '<system-reminder>literal</system-reminder>';
      const displayText = `${literal}\n${placeholder}`;
      const recallText = `${literal}\n${body}`;
      if (queued) act(() => result.current.submit('active turn'));
      act(() => {
        result.current.submit(
          `managed model-only notice\n${recallText}`,
          undefined,
          {
            displayText,
            humanInput: { text: displayText },
            pasteExpansions: new Map([[placeholder, body]]),
          },
        );
      });
      await act(async () => {
        for (const wake of live.waiters.splice(0)) wake();
      });
      await vi.waitFor(() => expect(result.current.streaming).toBe(false));
      const users = result.current.items.filter((item) => item.kind === 'user');
      expect(users.at(-1)).toMatchObject({ text: displayText, recallText });
      expect(users.at(-1)?.text).not.toContain(body);
      expect(users.at(-1)?.recallText).not.toContain(
        'managed model-only notice',
      );
    },
  );

  it.each(['error', 'abort'])(
    'clears terminal approval state without another key after %s',
    async (kind) => {
      const { result } = renderHook(() =>
        useOpenTuiLiveTurn({ config: {} as Config }),
      );
      const call = approval('old');
      const onComplete = vi.fn();
      act(() => {
        result.current.submit('first', undefined, { onComplete });
        park(1, call);
      });
      expect(result.current.waitingCalls[0]).toBe(call);
      expect(result.current.streaming).toBe(true);
      if (kind === 'error')
        live.errors.set(1, new DOMException('Owner revoked', 'AbortError'));
      else act(() => result.current.interrupt());
      await act(async () => live.waiters.shift()!());
      await vi.waitFor(() => expect(result.current.streaming).toBe(false));
      expect(result.current.waitingCalls).toEqual([]);
      expect(call.confirmationDetails.onConfirm).not.toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();
    },
  );

  it('keeps a queued successor approval with the same callId', async () => {
    live.holds.add(2);
    live.errors.set(1, new Error('Owner revoked'));
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );
    const old = approval('old');
    const next = approval('next');
    act(() => {
      result.current.submit('first');
      park(1, old);
      result.current.submit('queued');
    });
    await act(async () => live.waiters.shift()!());
    await vi.waitFor(() => expect(live.turns).toHaveLength(2));
    act(() => park(2, next));
    expect(result.current.waitingCalls).toEqual([next]);
    expect(result.current.waitingCalls[0]).toBe(next);
    expect(old.confirmationDetails.onConfirm).not.toHaveBeenCalled();
    await act(async () => live.waiters.shift()!());
  });

  it('does not clear the new same-ID approval when a reset turn exits late', async () => {
    live.holds.add(2);
    live.errors.set(1, new Error('Old owner revoked'));
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );
    const old = approval('old');
    const next = approval('next');
    act(() => {
      result.current.submit('first');
      park(1, old);
    });
    act(() => {
      result.current.resetTranscript([]);
      result.current.submit('new');
      park(2, next);
    });
    expect(result.current.waitingCalls[0]).toBe(next);
    await act(async () => live.waiters.shift()!());
    expect(result.current.waitingCalls[0]).toBe(next);
    expect(result.current.streaming).toBe(true);
    expect(next.confirmationDetails.onConfirm).not.toHaveBeenCalled();
    await act(async () => live.waiters.shift()!());
  });

  it('keeps live approval actionable until normal confirmation', async () => {
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );
    const call = approval('normal');
    const onComplete = vi.fn();
    act(() => {
      result.current.submit('first', undefined, { onComplete });
      park(1, call);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.waitingCalls[0]).toBe(call);
    expect(result.current.streaming).toBe(true);
    await act(async () => {
      await call.confirmationDetails.onConfirm(
        ToolConfirmationOutcome.ProceedOnce,
      );
      result.current.settleWaitingCall(call.callId);
      live.waiters.shift()!();
    });
    expect(result.current.waitingCalls).toEqual([]);
    expect(call.confirmationDetails.onConfirm).toHaveBeenCalledExactlyOnceWith(
      ToolConfirmationOutcome.ProceedOnce,
    );
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('fires onComplete once when a turn completes without an abort', async () => {
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );
    const onComplete = vi.fn();

    act(() => {
      result.current.submit('plain prompt', undefined, { onComplete });
    });
    await act(async () => {
      for (const wake of live.waiters.splice(0)) wake();
    });
    await vi.waitFor(() => expect(result.current.streaming).toBe(false));

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('does not fire onComplete when the turn ends on an aborted signal (R6-6)', async () => {
    // Esc while a tool batch is out: the generator's abort paths (the
    // all-cancelled batch above them) end with a normal return, so the seq
    // guard alone passes and the signal has to settle it — a command's
    // onComplete (e.g. /dream's manual-run recording) must not run for a turn
    // the user cancelled.
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );
    const onComplete = vi.fn();

    act(() => {
      result.current.submit('dream prompt', undefined, { onComplete });
    });
    act(() => {
      result.current.interrupt();
    });
    expect(live.signals[0]?.aborted).toBe(true);

    await act(async () => {
      for (const wake of live.waiters.splice(0)) wake();
    });
    await vi.waitFor(() => expect(result.current.streaming).toBe(false));

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('forwards per-turn options through the idle submit hop (R1-4)', () => {
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );

    act(() => {
      result.current.submit('first prompt', undefined, {
        submittedPrompt: 'first prompt',
        modelOverride: 'qwen3-max',
      });
    });

    // The idle path is the dominant one for submitted_prompt provenance; a
    // dropped `options` argument on the forwarding hop would silently lose it.
    expect(live.turns[0]?.options).toMatchObject({
      submittedPrompt: 'first prompt',
      modelOverride: 'qwen3-max',
    });
  });

  it('echoes an idle submit once as a user row', () => {
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );

    act(() => {
      result.current.submit('plain prompt');
    });

    expect(
      result.current.items.filter((item) => item.kind === 'user'),
    ).toMatchObject([{ kind: 'user', text: 'plain prompt' }]);
  });

  it('adds no user row for a submit whose invocation was already echoed', () => {
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );

    act(() => {
      // A skill command: the transcript already holds the row projected from
      // the recorded `/skill-name …` invocation; the expanded prompt is
      // generated text the user never typed (ink skips its USER item too).
      result.current.submit('expanded skill prompt', undefined, {
        invocationEchoed: true,
      });
    });

    expect(result.current.items.filter((item) => item.kind === 'user')).toEqual(
      [],
    );
    // Suppression covers the echo only — the turn still sends its prompt.
    expect(live.turns[0]?.prompt).toBe('expanded skill prompt');
  });

  it('keeps the transcript seam callbacks stable across turn state', () => {
    const { result, rerender } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );
    const applyEvent = result.current.applyEvent;
    const resetTranscript = result.current.resetTranscript;

    // The app shell memoizes its host on these identities, so a dependency on
    // anything that moves during a turn rebuilds the host on every render.
    act(() => {
      result.current.submit('first prompt');
    });
    rerender();
    act(() => {
      applyEvent({ type: 'info', text: 'a notice' });
    });
    rerender();

    expect(result.current.items.some((item) => item.kind === 'user')).toBe(
      true,
    );
    expect(result.current.applyEvent).toBe(applyEvent);
    expect(result.current.resetTranscript).toBe(resetTranscript);
  });

  it('keeps per-entry human intent through queued turns and never upgrades unknown entries', async () => {
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );
    const humanInput = { text: 'ultracode inspect' };
    act(() => result.current.submit('first prompt'));
    act(() => {
      result.current.submit('expanded human payload', undefined, {
        humanInput,
        displayText: 'visible human prompt',
      });
      result.current.submit('unknown workflow payload');
    });
    expect(result.current.messageQueue).toEqual([
      'visible human prompt',
      'unknown workflow payload',
    ]);
    await act(async () => {
      for (const wake of live.waiters.splice(0)) wake();
      await vi.waitFor(() => expect(live.turns).toHaveLength(3));
    });
    expect(live.turns[1]?.options).toMatchObject({ humanInput });
    expect(live.turns[2]?.options).toMatchObject({ humanInput: undefined });
    expect(
      result.current.items.filter((item) => item.kind === 'user'),
    ).toMatchObject([
      { text: 'first prompt' },
      { text: 'visible human prompt' },
      { text: 'unknown workflow payload' },
    ]);
  });

  it('pops display text and restores the model copy with only the original human members eligible', async () => {
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );
    act(() => result.current.submit('first prompt'));
    act(() => {
      result.current.submit('expanded body with ultracode', undefined, {
        displayText: '[Pasted Content]',
        humanInput: { text: '[Pasted Content]' },
      });
      result.current.submit('unknown workflow body', undefined, {
        displayText: 'unknown visible text',
      });
    });
    let popped: string | null = null;
    act(() => {
      popped = result.current.popQueue();
    });
    expect(popped).toBe('[Pasted Content]\n\nunknown visible text');
    act(() =>
      result.current.submit(popped!, undefined, {
        displayText: popped!,
        humanInput: { text: popped! },
      }),
    );
    await act(async () => {
      for (const wake of live.waiters.splice(0)) wake();
      await vi.waitFor(() => expect(live.turns).toHaveLength(2));
    });
    expect(live.turns[1]?.prompt).toBe(
      'expanded body with ultracode\n\nunknown workflow body',
    );
    expect(live.turns[1]?.options).toMatchObject({
      humanInput: { text: '[Pasted Content]' },
    });
  });

  it('restores the original human descriptor when an in-flight steering read is aborted', () => {
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );
    const humanInput = { text: 'ultracode inspect' };
    act(() => result.current.submit('first prompt'));
    act(() =>
      result.current.submit('expanded payload', undefined, {
        humanInput,
        displayText: 'original display',
      }),
    );
    const options = live.turns[0]?.options as {
      drainSteering: () => string[];
      restoreSteering: (texts: string[]) => void;
    };
    act(() => {
      const drained = options.drainSteering();
      expect(drained).toEqual(['expanded payload']);
      options.restoreSteering(drained);
    });
    expect(result.current.messageQueue).toEqual(['original display']);
  });

  it.each([false, true])(
    'keeps a popped paste editable after appending instructions (interrupt: %s)',
    async (interrupt) => {
      const { result } = renderHook(() =>
        useOpenTuiLiveTurn({ config: {} as Config }),
      );
      const placeholder = '[Pasted Content 1200 chars]';
      const body = 'ultracode workflow payload'.padEnd(1200, 'x');
      const literal = '<system-reminder>user literal</system-reminder>';
      const displayText = `${literal}\n${placeholder}`;
      const pasteExpansions = new Map([[placeholder, body]]);
      act(() => result.current.submit('first prompt'));
      act(() => {
        result.current.submit(`${literal}\n${body}`, undefined, {
          displayText,
          humanInput: { text: displayText },
          pasteExpansions,
        });
      });
      const restorePastes = vi.fn();
      act(() => {
        expect(result.current.popQueue(new Map(), restorePastes)).toBe(
          displayText,
        );
      });
      expect(restorePastes).toHaveBeenCalledWith(
        expect.objectContaining({ pasteExpansions, hasUnknownInput: false }),
        expect.any(Function),
      );
      if (interrupt) {
        act(() => result.current.interrupt());
        await act(async () => {
          for (const wake of live.waiters.splice(0)) wake();
        });
        await vi.waitFor(() => expect(result.current.streaming).toBe(false));
      }
      const edited = `${displayText}\nappend instruction`;
      act(() => {
        result.current.submit(edited, undefined, {
          displayText: edited,
          humanInput: { text: edited },
        });
      });
      await act(async () => {
        for (const wake of live.waiters.splice(0)) wake();
        await vi.waitFor(() => expect(live.turns).toHaveLength(2));
      });
      expect(live.turns[1]?.prompt).toBe(
        `${literal}\n${body}\nappend instruction`,
      );
      expect(live.turns[1]?.options).toMatchObject({
        humanInput: { text: edited },
      });
      expect(result.current.items).toContainEqual(
        expect.objectContaining({ kind: 'user', text: edited }),
      );
    },
  );

  it('replays queued mid-turn text as the next turn, raw and with provenance', async () => {
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );

    act(() => {
      result.current.submit('first prompt');
    });
    expect(result.current.streaming).toBe(true);

    act(() => {
      result.current.submit('look @notes.md');
    });
    expect(result.current.messageQueue).toEqual(['look @notes.md']);

    await act(async () => {
      for (const wake of live.waiters.splice(0)) wake();
      await vi.waitFor(() => expect(live.turns).toHaveLength(2));
    });

    // The queue holds what was typed, and the follow-on turn hands it over
    // unchanged: resolving `@path` mentions is the stream layer's job, so a
    // pre-expanded payload here would arrive with its provenance lost. The
    // rest of the options object is the driver's own plumbing.
    expect(live.turns[1]?.prompt).toBe('look @notes.md');
    expect(live.turns[1]?.options).toMatchObject({
      submittedPrompt: 'look @notes.md',
    });
    expect(result.current.messageQueue).toEqual([]);
  });

  it('consumes only its own submission when a replayed turn declines (R2-2)', async () => {
    // The one reachable decline of the expander — an abort landing inside the
    // @-mention read — ends the replayed turn without a send. Each queued
    // submission rides its own chained turn, so the sibling must survive the
    // decline instead of being swallowed with a joined payload.
    live.declines.add(2);
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );

    act(() => {
      result.current.submit('first prompt');
    });
    act(() => {
      result.current.submit('look @notes.md');
    });
    act(() => {
      result.current.submit('then do the other thing');
    });
    expect(result.current.messageQueue).toEqual([
      'look @notes.md',
      'then do the other thing',
    ]);

    await act(async () => {
      for (const wake of live.waiters.splice(0)) wake();
      await vi.waitFor(() => expect(live.turns).toHaveLength(3));
    });

    expect(live.turns[1]?.prompt).toBe('look @notes.md');
    expect(live.turns[2]?.prompt).toBe('then do the other thing');
    expect(result.current.messageQueue).toEqual([]);
  });

  it('restores a dropped steering batch at the front of the queue', () => {
    // The stream layer owns `@path` expansion and can hand a drained batch
    // back when the turn dies resolving it. Front-prepend (ink's
    // restoreMessages) keeps the steering order: restored first, then whatever
    // the composer queued since.
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );

    act(() => {
      result.current.submit('first prompt');
    });
    act(() => {
      result.current.submit('queued after');
    });
    expect(result.current.messageQueue).toEqual(['queued after']);

    const { restoreSteering } = live.turns[0]?.options as unknown as {
      restoreSteering: (texts: readonly string[]) => void;
    };
    act(() => {
      restoreSteering(['  steer me  ', '', 'then @b.ts']);
    });
    expect(result.current.messageQueue).toEqual([
      'steer me',
      'then @b.ts',
      'queued after',
    ]);

    let popped: string | null = null;
    act(() => {
      popped = result.current.popQueue();
    });

    expect(result.current.messageQueue).toEqual([]);
    expect(popped).toBe('steer me\n\nthen @b.ts\n\nqueued after');
  });

  it('drops the visible queue rows when the transcript resets', () => {
    // `/clear` and a session switch rebuild the transcript. A stale row would
    // keep advertising a prompt the following turn never runs.
    const { result } = renderHook(() =>
      useOpenTuiLiveTurn({ config: {} as Config }),
    );

    act(() => {
      result.current.submit('first prompt');
    });
    act(() => {
      result.current.submit('queued after');
    });
    expect(result.current.messageQueue).toEqual(['queued after']);

    act(() => {
      result.current.resetTranscript([]);
    });
    expect(result.current.messageQueue).toEqual([]);
  });
});

describe('useOpenTuiLiveTurn streaming counters', () => {
  beforeEach(() => {
    live.turns.length = 0;
    live.waiters.length = 0;
    live.declines.clear();
    live.signals.length = 0;
    live.script.clear();
    live.holds.clear();
    live.errors.clear();
  });

  function renderTurn() {
    return renderHook(() => useOpenTuiLiveTurn({ config: {} as Config }));
  }

  async function settle(result: { current: { streaming: boolean } }) {
    await act(async () => {
      for (const wake of live.waiters.splice(0)) wake();
    });
    await vi.waitFor(() => expect(result.current.streaming).toBe(false));
  }

  it('counts model text, thoughts and tool args, but never tool output', async () => {
    live.script.set(1, [
      { type: 'thinking', delta: 'hmm' },
      { type: 'text', delta: 'hello there' },
      {
        type: 'tool-start',
        id: 'c1',
        tool: 'run_shell_command',
        title: 'ls',
      },
      { type: 'tool-args', id: 'c1', args: '{"command":"ls"}' },
      // Tool-generated, not model-generated: ink leaves it out of the estimate.
      { type: 'tool-output', id: 'c1', output: 'a lot of stdout' },
      { type: 'tool-end', id: 'c1', success: true, summary: '' },
    ]);
    const { result } = renderTurn();

    act(() => {
      result.current.submit('go');
    });
    await settle(result);

    expect(result.current.streamingCharsRef.current).toBe(
      'hmm'.length + 'hello there'.length + '{"command":"ls"}'.length,
    );
  });

  it('marks content as receiving once model text arrives', async () => {
    live.script.set(1, [{ type: 'text', delta: 'here you go' }]);
    const { result } = renderTurn();

    act(() => {
      result.current.submit('go');
    });
    await settle(result);

    expect(result.current.isReceivingContent).toBe(true);
  });

  it('returns to the waiting-on-API state once the tool batch ends', async () => {
    live.script.set(1, [
      { type: 'text', delta: 'let me look' },
      {
        type: 'tool-start',
        id: 'c1',
        tool: 'run_shell_command',
        title: 'ls',
      },
      { type: 'tool-end', id: 'c1', success: true, summary: '' },
    ]);
    const { result } = renderTurn();

    act(() => {
      result.current.submit('go');
    });
    await settle(result);

    expect(result.current.isReceivingContent).toBe(false);
  });

  it('restarts the counter for each new user turn', async () => {
    live.script.set(1, [{ type: 'text', delta: 'aaaa' }]);
    live.script.set(2, [{ type: 'text', delta: 'bb' }]);
    const { result } = renderTurn();

    act(() => {
      result.current.submit('one');
    });
    await settle(result);
    expect(result.current.streamingCharsRef.current).toBe(4);

    act(() => {
      result.current.submit('two');
    });
    await vi.waitFor(() =>
      expect(result.current.streamingCharsRef.current).toBe(2),
    );
  });
});
