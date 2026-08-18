/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveBoardPromptContext,
  getBoardSection,
  BOARD_ENV,
  BOARD_PARTICIPANT_ENV,
} from './board-prompt.js';

describe('board prompt', () => {
  // The common case is a session that is not on a board. The section has to
  // cost nothing there, or every single-agent prompt pays for a feature it
  // does not use.
  it('is absent unless the session was started onto a board', () => {
    expect(resolveBoardPromptContext({})).toBeNull();
    expect(resolveBoardPromptContext({ [BOARD_ENV]: '' })).toBeNull();
  });

  it('reads the board and participant from the environment', () => {
    expect(
      resolveBoardPromptContext({
        [BOARD_ENV]: 'demo',
        [BOARD_PARTICIPANT_ENV]: 'api-worker',
      }),
    ).toEqual({ board: 'demo', as: 'api-worker' });
  });

  it('works without a participant name', () => {
    expect(resolveBoardPromptContext({ [BOARD_ENV]: 'demo' })).toEqual({
      board: 'demo',
      as: undefined,
    });
  });

  it('names the board and the participant it is addressed to', () => {
    const section = getBoardSection({ board: 'demo', as: 'api-worker' });
    expect(section).toContain('demo');
    expect(section).toContain('api-worker');
  });

  // Each of the three nouns has to be reachable, and the model has to be told
  // when to use which — verbs alone produce asks for things it could read.
  it('covers all three item kinds and how to reach them', () => {
    const section = getBoardSection({ board: 'demo' });
    for (const verb of [
      'qwen board show',
      'qwen board claim',
      'qwen board done',
      'qwen board ask',
      'qwen board answer',
      'qwen board decline',
      'qwen board raise',
    ]) {
      expect(section).toContain(verb);
    }
  });

  // The boundaries are what keep the board from degrading into a chat channel
  // or a hierarchy, so they are pinned rather than left to prose drift.
  it('states the boundaries the design depends on', () => {
    const section = getBoardSection({ board: 'demo' });
    expect(section).toContain('no general-purpose message');
    expect(section).toContain('a proposal, not an assignment');
    expect(section).toContain('No agent resolves one');
    expect(section).toContain('not visible to anyone else');
  });

  it('tells the model to look, since nothing is delivered', () => {
    const section = getBoardSection({ board: 'demo' });
    expect(section).toContain('Nothing is delivered to you');
    expect(section).toMatch(/check it at the start of a turn/i);
  });
});
