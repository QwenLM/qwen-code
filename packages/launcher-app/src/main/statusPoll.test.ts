import { describe, it, expect } from 'vitest';
import { nextPollState, type PollState } from './statusPoll.js';

const S = (over: Partial<PollState> = {}): PollState => ({
  running: false,
  url: undefined,
  lastError: undefined,
  ...over,
});

describe('nextPollState', () => {
  it('transitions to running with the url on a running status', () => {
    expect(nextPollState(S(), { running: true, url: 'https://h/ui/' })).toEqual(
      { running: true, url: 'https://h/ui/', lastError: undefined },
    );
  });
  it('clears url when stopped', () => {
    expect(
      nextPollState(S({ running: true, url: 'https://h/ui/' }), {
        running: false,
      }),
    ).toEqual({ running: false, url: undefined, lastError: undefined });
  });
});
