/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MEMORY_CONFIG } from './config.js';
import { DialogueRecorder } from './recorder.js';

const at = (seconds: number) => new Date(2026, 8, 5, 12, 0, seconds);

describe('DialogueRecorder', () => {
  it('records only an authoritative answer and lets it replace a filler', () => {
    const recorder = new DialogueRecorder();
    recorder.onUserText('以前种辣椒的间距是多少？', at(0));
    expect(
      recorder.onAssistantText('我查一下', { source: 'filler', moment: at(1) }),
    ).toEqual({});
    recorder.onAssistantText('烤箱响了', {
      source: 'background',
      moment: at(2),
    });
    recorder.onAssistantText('别的后台回答', {
      source: 'realtime',
      moment: at(3),
    });
    recorder.onAssistantText('第二段回执', { source: 'filler', moment: at(4) });
    expect(recorder.pendingTurn?.asstText).toBe('我查一下');
    const result = recorder.onAssistantText('留三十厘米。', { moment: at(5) });
    expect(result.turn).toMatchObject({
      turnIdx: 0,
      userText: '以前种辣椒的间距是多少？',
      asstText: '留三十厘米。',
      provisionalAnswer: false,
    });
    expect(recorder.pendingTurn).toBeUndefined();
  });

  it('keeps unanswered user speech and a provisional last answer on close', () => {
    const recorder = new DialogueRecorder();
    recorder.onUserText('还记得我的名字吗', at(0));
    expect(recorder.onUserText('我叫小王', at(1)).turn).toMatchObject({
      asstText: '',
      userText: '还记得我的名字吗',
    });
    recorder.onAssistantText('我记一下', { source: 'filler', moment: at(2) });
    expect(recorder.flush().turn?.asstText).toBe('我记一下');
    expect(recorder.cutTail()).toMatchObject({
      cutReason: 'session_end',
      turns: [{ userText: '还记得我的名字吗' }, { userText: '我叫小王' }],
    });
    expect(recorder.cutTail()).toBeUndefined();
  });

  it('cuts before the incoming turn without including it twice', () => {
    const recorder = new DialogueRecorder({
      ...DEFAULT_MEMORY_CONFIG.segment,
      maxTurns: 2,
    });
    for (let i = 0; i < 2; i++) {
      recorder.onUserText(`问题${i}`, at(i * 2));
      recorder.onAssistantText(`回答${i}`, { moment: at(i * 2 + 1) });
    }
    recorder.onUserText('问题2', at(6));
    const result = recorder.onAssistantText('回答2', { moment: at(7) });
    expect(result.segment?.turns.map((turn) => turn.turnIdx)).toEqual([0, 1]);
    expect(result.turn?.turnIdx).toBe(2);
    expect(recorder.tailTurns.map((turn) => turn.turnIdx)).toEqual([2]);
  });

  it('requires enough prior turns before a silence gap can cut', () => {
    const recorder = new DialogueRecorder();
    recorder.onUserText('first', at(0));
    recorder.onAssistantText('answer', { moment: at(1) });
    recorder.onUserText('second', at(100));
    expect(
      recorder.onAssistantText('answer', { moment: at(101) }).segment,
    ).toBeUndefined();
    recorder.onUserText('third', at(200));
    expect(
      recorder.onAssistantText('answer', { moment: at(201) }).segment
        ?.cutReason,
    ).toBe('silence_gap');
  });

  it('honors character cuts, resumed indices and interruption markers', () => {
    const recorder = new DialogueRecorder(
      { ...DEFAULT_MEMORY_CONFIG.segment, maxChars: 5 },
      7,
    );
    recorder.onUserText('long question', at(0));
    expect(
      recorder.onAssistantText('partial', { interrupted: true, moment: at(1) })
        .turn,
    ).toMatchObject({ turnIdx: 7, interrupted: true });
    recorder.onUserText('next', at(2));
    expect(recorder.flush().segment?.cutReason).toBe('max_chars');
    const tail = recorder.tailTurns;
    tail[0]!.userText = 'mutation';
    expect(recorder.tailTurns[0]?.userText).toBe('next');
  });
});
