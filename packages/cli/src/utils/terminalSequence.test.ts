/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseAllowedTerminalSequences,
  emitTerminalSequence,
} from './terminalSequence.js';

describe('parseAllowedTerminalSequences', () => {
  describe('accepted sequences', () => {
    it('accepts bare BEL', () => {
      expect(parseAllowedTerminalSequences('\x07')).toEqual(['\x07']);
    });

    it('accepts OSC 0 with BEL terminator', () => {
      const seq = '\x1b]0;window title\x07';
      expect(parseAllowedTerminalSequences(seq)).toEqual([seq]);
    });

    it('accepts OSC 1 with ST terminator', () => {
      const seq = '\x1b]1;icon name\x1b\\';
      expect(parseAllowedTerminalSequences(seq)).toEqual([seq]);
    });

    it('accepts OSC 2 title', () => {
      const seq = '\x1b]2;tab title\x07';
      expect(parseAllowedTerminalSequences(seq)).toEqual([seq]);
    });

    it('accepts OSC 9 notification', () => {
      const seq = '\x1b]9;hello world\x07';
      expect(parseAllowedTerminalSequences(seq)).toEqual([seq]);
    });

    it('accepts OSC 9 with subcommand (progress)', () => {
      const seq = '\x1b]9;4;1;50\x07';
      expect(parseAllowedTerminalSequences(seq)).toEqual([seq]);
    });

    it('accepts OSC 99 Kitty notification', () => {
      const seq = '\x1b]99;i=1:d=0:p=title;VGl0bGU=\x1b\\';
      expect(parseAllowedTerminalSequences(seq)).toEqual([seq]);
    });

    it('accepts OSC 777 Ghostty notification', () => {
      const seq = '\x1b]777;notify;Title;Body\x07';
      expect(parseAllowedTerminalSequences(seq)).toEqual([seq]);
    });

    it('accepts multiple valid sequences concatenated', () => {
      const bel = '\x07';
      const osc9 = '\x1b]9;hello\x07';
      const osc0 = '\x1b]0;title\x1b\\';
      const input = bel + osc9 + osc0;
      expect(parseAllowedTerminalSequences(input)).toEqual([bel, osc9, osc0]);
    });
  });

  describe('rejected sequences', () => {
    it('rejects empty string', () => {
      expect(parseAllowedTerminalSequences('')).toBeNull();
    });

    it('rejects plain text', () => {
      expect(parseAllowedTerminalSequences('hello world')).toBeNull();
    });

    it('rejects CSI color sequence', () => {
      expect(parseAllowedTerminalSequences('\x1b[31m')).toBeNull();
    });

    it('rejects OSC 8 hyperlink', () => {
      expect(
        parseAllowedTerminalSequences('\x1b]8;;https://example.com\x07'),
      ).toBeNull();
    });

    it('rejects OSC 52 clipboard', () => {
      expect(
        parseAllowedTerminalSequences('\x1b]52;c;dGVzdA==\x07'),
      ).toBeNull();
    });

    it('rejects OSC 1337', () => {
      expect(parseAllowedTerminalSequences('\x1b]1337;SetMark\x07')).toBeNull();
    });

    it('rejects OSC 4 palette change', () => {
      expect(
        parseAllowedTerminalSequences('\x1b]4;1;rgb:ff/00/00\x07'),
      ).toBeNull();
    });

    it('rejects unterminated OSC', () => {
      expect(parseAllowedTerminalSequences('\x1b]9;hello')).toBeNull();
    });

    it('rejects OSC with nested ESC that is not ST', () => {
      expect(
        parseAllowedTerminalSequences('\x1b]9;he\x1b[31mllo\x07'),
      ).toBeNull();
    });

    it('rejects mixed valid and invalid content', () => {
      const valid = '\x07';
      const invalid = 'plain text';
      expect(parseAllowedTerminalSequences(valid + invalid)).toBeNull();
    });

    it('rejects OSC with no numeric code', () => {
      expect(parseAllowedTerminalSequences('\x1b];hello\x07')).toBeNull();
    });
  });
});

describe('emitTerminalSequence', () => {
  const originalEnv = { ...process.env };
  const writeRaw = vi.fn();

  afterEach(() => {
    writeRaw.mockReset();
    process.env = { ...originalEnv };
  });

  it('emits bare BEL without multiplexer wrapping', () => {
    process.env['TMUX'] = '/tmp/tmux';
    expect(emitTerminalSequence('\x07', writeRaw)).toBe(true);
    expect(writeRaw).toHaveBeenCalledTimes(1);
    expect(writeRaw).toHaveBeenCalledWith('\x07');
    // BEL must NOT be wrapped in DCS passthrough
    expect(writeRaw.mock.calls[0]![0]).not.toContain('\x1bPtmux');
  });

  it('emits OSC through wrapForMultiplexer under tmux', () => {
    process.env['TMUX'] = '/tmp/tmux';
    delete process.env['STY'];
    const osc = '\x1b]9;hello\x07';
    expect(emitTerminalSequence(osc, writeRaw)).toBe(true);
    expect(writeRaw).toHaveBeenCalledTimes(1);
    const written = writeRaw.mock.calls[0]![0] as string;
    expect(written).toContain('\x1bPtmux;');
  });

  it('emits OSC without wrapping outside multiplexer', () => {
    delete process.env['TMUX'];
    delete process.env['STY'];
    const osc = '\x1b]9;hello\x07';
    expect(emitTerminalSequence(osc, writeRaw)).toBe(true);
    expect(writeRaw).toHaveBeenCalledWith(osc);
  });

  it('returns false and writes nothing for invalid input', () => {
    expect(emitTerminalSequence('plain text', writeRaw)).toBe(false);
    expect(writeRaw).not.toHaveBeenCalled();
  });

  it('emits multiple tokens separately', () => {
    delete process.env['TMUX'];
    delete process.env['STY'];
    const input = '\x07\x1b]0;title\x07';
    expect(emitTerminalSequence(input, writeRaw)).toBe(true);
    expect(writeRaw).toHaveBeenCalledTimes(2);
    expect(writeRaw.mock.calls[0]![0]).toBe('\x07');
    expect(writeRaw.mock.calls[1]![0]).toBe('\x1b]0;title\x07');
  });
});
