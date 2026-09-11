/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  MemoryDialogueCollector,
  type MemoryDialogueEvent,
} from './dialogue.js';
import { DialogueRecorder, type DialogueTurn } from './recorder.js';

function fixture() {
  const turns: DialogueTurn[] = [];
  const recorder = new DialogueRecorder();
  const recordUser = vi.fn((text: string) => {
    const result = recorder.onUserText(text);
    if (result.turn) turns.push(result.turn);
  });
  const recordAssistant = vi.fn(
    (
      text: string,
      options: { source: 'normal' | 'filler'; interrupted: boolean },
    ) => {
      const result = recorder.onAssistantText(text, options);
      if (result.turn) turns.push(result.turn);
    },
  );
  const collector = new MemoryDialogueCollector({
    recordUser,
    recordAssistant,
  });
  const finish = () => {
    collector.close();
    const result = recorder.flush();
    if (result.turn) turns.push(result.turn);
    return turns.map((turn) => ({
      user: turn.userText,
      answer: turn.asstText,
      interrupted: turn.interrupted,
    }));
  };
  return { collector, recordUser, recordAssistant, turns, finish };
}

function user(inputItemId: string, text: string): MemoryDialogueEvent {
  return { inputItemId, role: 'user', text };
}

function answer(
  inputItemId: string,
  text: string,
  source: 'normal' | 'filler' = 'normal',
  interrupted = false,
): MemoryDialogueEvent {
  return { inputItemId, role: 'assistant', text, source, interrupted };
}

describe('MemoryDialogueCollector', () => {
  it.each(['user-first', 'answer-first'] as const)(
    'pairs a normal response when its transcript is %s',
    (order) => {
      const { collector, recordUser, recordAssistant, finish } = fixture();
      collector.beginInput('input-1');
      if (order === 'answer-first') {
        collector.accept(answer('input-1', 'Your meeting is tomorrow.'));
        expect(recordUser).not.toHaveBeenCalled();
        expect(recordAssistant).not.toHaveBeenCalled();
        collector.accept(user('input-1', 'When is my meeting?'));
      } else {
        collector.accept(user('input-1', 'When is my meeting?'));
        collector.accept(answer('input-1', 'Your meeting is tomorrow.'));
      }
      expect(finish()).toEqual([
        {
          user: 'When is my meeting?',
          answer: 'Your meeting is tomorrow.',
          interrupted: false,
        },
      ]);
    },
  );

  it('holds later inputs until earlier ASR arrives and emits in input order', () => {
    const { collector, recordUser, recordAssistant, finish } = fixture();
    collector.beginInput('first');
    collector.beginInput('second');
    collector.accept(user('second', 'Second question'));
    collector.accept(answer('second', 'Second answer'));
    collector.accept(answer('first', 'First answer'));
    expect(recordUser).not.toHaveBeenCalled();
    expect(recordAssistant).not.toHaveBeenCalled();
    collector.accept(user('first', 'First question'));
    expect(recordUser.mock.calls).toEqual([
      ['First question'],
      ['Second question'],
    ]);
    expect(finish()).toEqual([
      { user: 'First question', answer: 'First answer', interrupted: false },
      { user: 'Second question', answer: 'Second answer', interrupted: false },
    ]);
  });

  it('keeps filler provisional and replaces it with the final normal answer', () => {
    const { collector, turns, recordAssistant, finish } = fixture();
    collector.beginInput('request');
    collector.accept(user('request', 'What is in the picture?'));
    collector.accept(answer('request', 'Let me check.', 'filler'));
    collector.accept(
      answer('request', 'Another tool acknowledgement.', 'filler'),
    );
    expect(turns).toEqual([]);
    expect(recordAssistant).toHaveBeenCalledExactlyOnceWith('Let me check.', {
      source: 'filler',
      interrupted: false,
    });
    collector.accept(answer('request', 'There is a blue cup.'));
    expect(finish()).toEqual([
      {
        user: 'What is in the picture?',
        answer: 'There is a blue cup.',
        interrupted: false,
      },
    ]);
  });

  it('preserves filler and interrupted flags when a response precedes its ASR', () => {
    const { collector, recordAssistant, finish } = fixture();
    collector.beginInput('request');
    collector.accept(answer('request', 'Looking it up.', 'filler'));
    collector.accept(answer('request', 'The first finding is', 'normal', true));
    collector.accept(user('request', 'Tell me what you found.'));
    expect(recordAssistant.mock.calls).toEqual([
      ['Looking it up.', { source: 'filler', interrupted: false }],
      ['The first finding is', { source: 'normal', interrupted: true }],
    ]);
    expect(finish()).toEqual([
      {
        user: 'Tell me what you found.',
        answer: 'The first finding is',
        interrupted: true,
      },
    ]);
  });

  it.each(['empty', 'filler'] as const)(
    'settles an %s previous turn on the next user and discards its late response',
    (previous) => {
      const { collector, finish } = fixture();
      collector.beginInput('first');
      collector.accept(user('first', 'First question'));
      if (previous === 'filler') {
        collector.accept(answer('first', 'Please wait.', 'filler'));
      }
      collector.beginInput('second');
      collector.accept(user('second', 'Second question'));
      collector.accept(answer('first', 'Late first answer'));
      collector.accept(answer('second', 'Second answer'));
      expect(finish()).toEqual([
        {
          user: 'First question',
          answer: previous === 'filler' ? 'Please wait.' : '',
          interrupted: false,
        },
        {
          user: 'Second question',
          answer: 'Second answer',
          interrupted: false,
        },
      ]);
    },
  );

  it('does not mispair later ASR when multiple pending utterances lack an answer', () => {
    const { collector, finish } = fixture();
    collector.beginInput('first');
    collector.beginInput('second');
    collector.beginInput('third');
    collector.accept(user('third', 'Third question'));
    collector.accept(answer('third', 'Third answer'));
    collector.accept(user('second', 'Second question'));
    collector.accept(user('first', 'First question'));
    collector.accept(answer('second', 'Late second answer'));
    expect(finish()).toEqual([
      { user: 'First question', answer: '', interrupted: false },
      { user: 'Second question', answer: '', interrupted: false },
      { user: 'Third question', answer: 'Third answer', interrupted: false },
    ]);
  });

  it('deduplicates user/final events and never reopens a retired input', () => {
    const { collector, recordUser, recordAssistant, finish } = fixture();
    collector.beginInput('once');
    collector.beginInput('once');
    collector.accept(user('once', 'Original question'));
    collector.accept(user('once', 'Duplicate transcription'));
    collector.accept(answer('once', 'Original answer'));
    collector.accept(answer('once', 'Duplicate final'));
    collector.beginInput('once');
    collector.accept(user('once', 'Late transcription'));
    expect(recordUser).toHaveBeenCalledOnce();
    expect(recordAssistant).toHaveBeenCalledOnce();
    expect(finish()).toEqual([
      {
        user: 'Original question',
        answer: 'Original answer',
        interrupted: false,
      },
    ]);
  });

  it('flushes known later text past missing ASR, then accepts only new inputs', () => {
    const { collector, recordUser, finish } = fixture();
    collector.beginInput('missing');
    collector.accept(answer('missing', 'Answer with no reliable user text'));
    collector.beginInput('known');
    collector.accept(user('known', 'A known question'));
    collector.accept(answer('known', 'A known answer'));
    expect(recordUser).not.toHaveBeenCalled();
    collector.flush();
    collector.accept(user('missing', 'Late missing transcript'));
    collector.beginInput('next');
    collector.accept(user('next', 'New after flush'));
    expect(finish()).toEqual([
      {
        user: 'A known question',
        answer: 'A known answer',
        interrupted: false,
      },
      { user: 'New after flush', answer: '', interrupted: false },
    ]);
  });

  it('ignores unregistered input IDs and becomes inert after close', () => {
    const { collector, recordUser, recordAssistant, finish } = fixture();
    collector.accept(user('old-attachment', 'Old user text'));
    collector.accept(answer('old-attachment', 'Old answer'));
    collector.beginInput('registered');
    collector.accept(user('registered', 'Keep this'));
    collector.accept(
      answer('registered', 'Partial acknowledgement', 'filler', true),
    );
    expect(finish()).toEqual([
      {
        user: 'Keep this',
        answer: 'Partial acknowledgement',
        interrupted: true,
      },
    ]);
    collector.beginInput('after-close');
    collector.accept(user('after-close', 'Must not be recorded'));
    collector.accept(answer('registered', 'Late final answer'));
    collector.flush();
    collector.close();
    expect(recordUser).toHaveBeenCalledOnce();
    expect(recordAssistant).toHaveBeenCalledOnce();
  });

  it('bounds missing input placeholders and flushes the retained known input', () => {
    const { collector, recordUser, finish } = fixture();
    for (let index = 0; index < 256; index += 1) {
      collector.beginInput(`input-${index}`);
    }
    collector.accept(user('input-255', 'Still retained'));
    expect(recordUser).not.toHaveBeenCalled();
    for (let index = 256; index < 512; index += 1) {
      collector.beginInput(`input-${index}`);
    }
    expect(recordUser.mock.calls).toEqual([['Still retained']]);
    collector.accept(user('input-0', 'Evicted input must not return'));
    collector.accept(answer('input-255', 'Late evicted answer'));
    collector.accept(user('input-511', 'Newest known'));
    expect(finish()).toEqual([
      { user: 'Still retained', answer: '', interrupted: false },
      { user: 'Newest known', answer: '', interrupted: false },
    ]);
  });

  it('retires empty final ASR without blocking later dialogue and rejects synthetic answers', () => {
    const { collector, finish, turns } = fixture();
    collector.beginInput('noise');
    collector.beginInput('question');
    collector.accept(user('question', '  Real question  '));
    collector.accept({
      ...answer('question', 'Synthetic announcement'),
      source: 'synthetic',
    } as unknown as MemoryDialogueEvent);
    collector.accept({
      inputItemId: 'question',
      role: 'assistant',
      text: '  Actual answer  ',
    });
    expect(turns).toEqual([]);
    collector.accept(user('noise', '  '));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      userText: 'Real question',
      asstText: 'Actual answer',
      interrupted: false,
    });
    collector.accept(
      user('noise', 'Duplicate late ASR must not reopen this input'),
    );
    expect(finish()).toEqual([
      {
        user: 'Real question',
        answer: 'Actual answer',
        interrupted: false,
      },
    ]);
  });
});
