/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { describe, it, expect } from 'vitest';
import {
  parseMultipleKeypresses,
  INITIAL_STATE,
  type ParsedInput,
  type ParsedKey,
} from './parse-keypress.js';
import { InputEvent } from './events/input-event.js';

/** Helper: parse a raw string and return the first ParsedKey. */
function parse(raw: string): ParsedKey {
  const [keys] = parseMultipleKeypresses(INITIAL_STATE, raw);
  const first = keys[0];
  expect(first).toBeDefined();
  expect(first!.kind).toBe('key');
  return first as ParsedKey;
}

describe('parseMultipleKeypresses – text tokens', () => {
  it('preserves ordinary text tokens as one keypress', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, 'hello!');
    expect(keys).toHaveLength(1);
    const key = keys[0] as ParsedKey;
    expect(key.sequence).toBe('hello!');
    expect(key.name).toBe('');
  });

  it('preserves coalesced text plus carriage return as one keypress', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '2\r');
    expect(keys).toHaveLength(1);
    const key = keys[0] as ParsedKey;
    expect(key.sequence).toBe('2\r');
    expect(key.name).toBe('');
  });

  it('preserves coalesced text plus CRLF as one keypress', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, 'hello\r\n');
    expect(keys).toHaveLength(1);
    const key = keys[0] as ParsedKey;
    expect(key.sequence).toBe('hello\r\n');
    expect(key.name).toBe('');
  });

  it('parses bare CRLF as a single return key', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '\r\n');
    expect(keys).toHaveLength(1);
    const key = keys[0] as ParsedKey;
    expect(key.sequence).toBe('\r');
    expect(key.name).toBe('return');
  });

  it('preserves embedded carriage returns inside ordinary text tokens', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, 'a\rb');
    expect(keys).toHaveLength(1);
    const key = keys[0] as ParsedKey;
    expect(key.sequence).toBe('a\rb');
    expect(key.name).toBe('');
  });
});

describe('parseKeypress – printable punctuation', () => {
  it('names a legacy question-mark keypress', () => {
    const key = parse('?');
    expect(key.name).toBe('?');
    expect(key.shift).toBe(false);
    expect(key.sequence).toBe('?');
  });

  it('preserves the base key for Kitty shifted punctuation', () => {
    const key = parse('\x1b[47:63;2u');
    expect(key.name).toBe('/');
    expect(key.shift).toBe(true);
  });

  it('names xterm shifted punctuation by its emitted character', () => {
    const key = parse('\x1b[27;2;63~');
    expect(key.name).toBe('?');
    expect(key.shift).toBe(true);
  });
});

describe('parseKeypress – Kitty CSI u text codepoints', () => {
  it('restores a single CJK character sent as CSI u (IME commit path)', () => {
    // A terminal may encode text as CSI u. This verifies decoding that input,
    // independently of which keyboard protocol flags the terminal requires.
    const key = parse('\x1b[19968u');
    expect(key.name).toBe('一');
    expect(key.ctrl).toBe(false);
    expect(key.meta).toBe(false);
    expect(new InputEvent(key).input).toBe('一');
  });

  it('restores a CJK character with a NumLock-modified modifier param', () => {
    // modifier 129 = 1 + NumLock bit (128); the bit is stripped before decode
    const key = parse('\x1b[19968;129u');
    expect(key.name).toBe('一');
    expect(new InputEvent(key).input).toBe('一');
  });

  it('restores accented Latin-1 letters', () => {
    const key = parse('\x1b[233u'); // U+00E9 é
    expect(key.name).toBe('é');
    expect(new InputEvent(key).input).toBe('é');
  });

  it('restores astral-plane characters as their full surrogate pair', () => {
    const key = parse('\x1b[128077u'); // U+1F44D 👍
    expect(key.name).toBe('👍');
    expect(new InputEvent(key).input).toBe('👍');
  });

  it('still swallows unmapped Kitty functional keys in the private-use block', () => {
    // 57358 = CAPS_LOCK (mapped to undefined on purpose); 57450 sits in the
    // PUA functional-key block without an individual mapping.
    expect(parse('\x1b[57358u').name).toBeUndefined();
    const unmapped = parse('\x1b[57450u');
    expect(unmapped.name).toBeUndefined();
    expect(new InputEvent(unmapped).input).toBe('');
  });

  it('keeps C1 control codepoints unmapped', () => {
    expect(parse('\x1b[128u').name).toBeUndefined();
  });
});

describe('parseKeypress – legacy ESC+letter meta keys', () => {
  it('should parse ESC+v as meta=true, name="v"', () => {
    const key = parse('\x1bv');
    expect(key.name).toBe('v');
    expect(key.meta).toBe(true);
    expect(key.shift).toBe(false);
    expect(key.ctrl).toBe(false);
  });

  it('should parse ESC+b as meta=true, name="b"', () => {
    const key = parse('\x1bb');
    // Note: iTerm natural text editing maps ESC+b to left arrow with meta,
    // but the underlying parsed name should still be captured
    expect(key.meta).toBe(true);
    expect(key.name).toBe('left'); // remapped by iTerm handler
  });

  it('should parse ESC+f as meta=true, name="f"', () => {
    const key = parse('\x1bf');
    expect(key.meta).toBe(true);
    expect(key.name).toBe('right'); // remapped by iTerm handler
  });

  it('should parse ESC+d as meta=true, name="d"', () => {
    const key = parse('\x1bd');
    expect(key.name).toBe('d');
    expect(key.meta).toBe(true);
    expect(key.shift).toBe(false);
  });

  it('should parse ESC+m as meta=true, name="m"', () => {
    const key = parse('\x1bm');
    expect(key.name).toBe('m');
    expect(key.meta).toBe(true);
    expect(key.shift).toBe(false);
  });

  it('should parse ESC+z as meta=true, name="z"', () => {
    const key = parse('\x1bz');
    expect(key.name).toBe('z');
    expect(key.meta).toBe(true);
    expect(key.shift).toBe(false);
  });

  it('should parse ESC+V (uppercase) as meta=true, shift=true, name="v"', () => {
    const key = parse('\x1bV');
    expect(key.name).toBe('v');
    expect(key.meta).toBe(true);
    expect(key.shift).toBe(true);
  });

  it('should parse ESC+Z (uppercase) as meta=true, shift=true, name="z"', () => {
    const key = parse('\x1bZ');
    expect(key.name).toBe('z');
    expect(key.meta).toBe(true);
    expect(key.shift).toBe(true);
  });

  it('should parse ESC+5 (digit) as meta=true, name="5"', () => {
    const key = parse('\x1b5');
    expect(key.name).toBe('5');
    expect(key.meta).toBe(true);
    expect(key.shift).toBe(false);
  });
});

describe('parseKeypress – legacy ESC+control meta keys', () => {
  // Terminals without kitty keyboard protocol or modifyOtherKeys encode
  // Option+Enter as ESC CR. Left unhandled, it parses as a nameless insertable
  // key whose sequence still holds the ESC, which the coalesced-submit path
  // then sends as a message.
  it('should parse ESC+CR as meta+return (Option+Enter)', () => {
    const key = parse('\x1b\r');
    expect(key.name).toBe('return');
    expect(key.meta).toBe(true);
    expect(key.ctrl).toBe(false);
    expect(key.shift).toBe(false);
    expect(key.sequence).toBe('\x1b\r');
  });

  it('should parse ESC+LF as meta+enter', () => {
    const key = parse('\x1b\n');
    expect(key.name).toBe('enter');
    expect(key.meta).toBe(true);
    expect(key.ctrl).toBe(false);
  });

  it('should parse ESC+CRLF as meta+return', () => {
    // Terminals whose Enter emits CRLF send ESC CR LF for Option+Enter. Bare
    // CRLF is normalized to CR upstream, but the ESC-prefixed form is not, so
    // it has to be matched here.
    const key = parse('\x1b\r\n');
    expect(key.name).toBe('return');
    expect(key.meta).toBe(true);
    expect(key.ctrl).toBe(false);
  });

  it('should NOT name ESC+TAB as a tab key', () => {
    // Naming it would make Option+Tab a real {name:'tab', alt:true}, which
    // handlers that check `key.name === 'tab'` without looking at modifiers
    // (InputPrompt ghost-text acceptance, ModelDialog persist toggle, …) would
    // then act on. Leaving it nameless keeps Option+Tab inert, as it was.
    const key = parse('\x1b\t');
    expect(key.name).toBe('');
    expect(key.meta).toBe(false);
  });

  it('should keep bare CR/LF/TAB unmodified', () => {
    const cr = parse('\r');
    expect(cr.name).toBe('return');
    expect(cr.meta).toBe(false);
    // Cleared for bare CR only (the ESC-prefixed forms keep their raw bytes).
    expect(cr.raw).toBeUndefined();

    const lf = parse('\n');
    expect(lf.name).toBe('enter');
    expect(lf.meta).toBe(false);

    const tab = parse('\t');
    expect(tab.name).toBe('tab');
    expect(tab.meta).toBe(false);
  });

  it('should keep the other ESC-prefixed control keys unmodified', () => {
    const del = parse('\x1b\x7f');
    expect(del.name).toBe('backspace');
    expect(del.meta).toBe(true);

    // ESC ESC never reaches parseKeypress as a two-byte sequence: the tokenizer
    // emits the first ESC on its own, so this is a plain escape key.
    const esc = parse('\x1b\x1b');
    expect(esc.name).toBe('escape');
    expect(esc.sequence).toBe('\x1b');
  });

  it('should still parse modern Alt+Enter encodings', () => {
    const kitty = parse('\x1b[13;3u');
    expect(kitty.name).toBe('return');
    expect(kitty.meta).toBe(true);

    const modifyOtherKeys = parse('\x1b[27;3;13~');
    expect(modifyOtherKeys.name).toBe('return');
    expect(modifyOtherKeys.meta).toBe(true);
  });

  it('should parse ESC and CR arriving in separate chunks as one meta+return', () => {
    // The tokenizer holds an incomplete ESC and prepends it to the next chunk,
    // so Option+Enter split across reads still lands as a single key.
    const [firstKeys, state] = parseMultipleKeypresses(INITIAL_STATE, '\x1b');
    expect(firstKeys).toHaveLength(0);
    expect(state.incomplete).toBe('\x1b');

    const [keys] = parseMultipleKeypresses(state, '\r');
    expect(keys).toHaveLength(1);
    const key = keys[0] as ParsedKey;
    expect(key.name).toBe('return');
    expect(key.meta).toBe(true);
  });
});

describe('parseMultipleKeypresses – flush-split terminal responses', () => {
  /** Feed chunks, flushing (input=null) between them like App's 50ms timer. */
  function feedWithFlushes(...chunks: Array<string | null>) {
    let state = INITIAL_STATE;
    const all: ParsedInput[] = [];
    for (const chunk of chunks) {
      const [keys, next] = parseMultipleKeypresses(
        state,
        chunk,
        (sequence) =>
          ['\x1b]11;', '\x1bP>|'].some(
            (prefix) =>
              sequence.length > 2 &&
              (prefix.startsWith(sequence) || sequence.startsWith(prefix)),
          ),
      );
      all.push(...keys);
      state = next;
    }
    return { keys: all, state };
  }

  const OSC11 = '\x1b]11;rgb:2828/2c2c/3434\x1b\\';

  it('parses a complete OSC 11 reply as a terminal response', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, OSC11);
    expect(keys).toEqual([
      {
        kind: 'response',
        sequence: OSC11,
        response: { type: 'osc', code: 11, data: 'rgb:2828/2c2c/3434' },
      },
    ]);
  });

  it('reassembles an OSC 11 reply split by a flush instead of leaking it', () => {
    // Windows Terminal over SSH delivers the reply in two reads more than
    // 50ms apart, so the flush timer fires between them.
    const { keys } = feedWithFlushes(
      '\x1b]11;r',
      null,
      'gb:2828/2c2c/3434\x1b\\',
    );
    expect(keys).toEqual([
      {
        kind: 'response',
        sequence: OSC11,
        response: { type: 'osc', code: 11, data: 'rgb:2828/2c2c/3434' },
      },
    ]);
  });

  it('preserves Enter delivered after the response tail in the same read', () => {
    const { keys } = feedWithFlushes(
      '\x1b]11;r',
      null,
      'gb:2828/2c2c/3434\x1b\\\r',
    );
    expect(keys).toEqual([
      {
        kind: 'response',
        sequence: OSC11,
        response: { type: 'osc', code: 11, data: 'rgb:2828/2c2c/3434' },
      },
      expect.objectContaining({ kind: 'key', name: 'return', sequence: '\r' }),
    ]);
  });

  it('leaves nothing in the prompt when the reply is split three ways', () => {
    const { keys } = feedWithFlushes(
      '\x1b]11',
      null,
      ';rgb:2828',
      null,
      '/2c2c/3434\x1b\\',
    );
    expect(keys.map((k) => k.kind)).toEqual(['response']);
  });

  it('reassembles a response whose ST terminator is split after ESC', () => {
    const { keys } = feedWithFlushes(
      '\x1b]11;r',
      null,
      'gb:2828/2c2c/3434\x1b',
      null,
      '\\',
    );
    expect(keys).toEqual([
      {
        kind: 'response',
        sequence: OSC11,
        response: { type: 'osc', code: 11, data: 'rgb:2828/2c2c/3434' },
      },
    ]);
  });

  it('does not re-arm the flush timer while a response head is pending', () => {
    // App re-arms its timer from `incomplete`; a pending head must not keep it
    // spinning when the terminal never sends the tail.
    const { state } = feedWithFlushes('\x1b]11;r', null);
    expect(state.incomplete).toBe('');
    expect(state.pendingResponse).toBe('\x1b]11;r');
  });

  it('reassembles a split XTVERSION reply', () => {
    const { keys } = feedWithFlushes('\x1bP>|ghost', null, 'ty 1.2.0\x1b\\');
    expect(keys).toEqual([
      {
        kind: 'response',
        sequence: '\x1bP>|ghostty 1.2.0\x1b\\',
        response: { type: 'xtversion', name: 'ghostty 1.2.0' },
      },
    ]);
  });

  it('still reports a flushed bare ESC ] as an Alt+] keypress', () => {
    const { keys, state } = feedWithFlushes('\x1b]', null);
    expect(keys.map((k) => k.kind)).toEqual(['key']);
    expect((keys[0] as ParsedKey).sequence).toBe('\x1b]');
    expect(state.pendingResponse).toBe('');
  });

  it('does not classify Alt+] followed by digits and a semicolon as a response head', () => {
    const [initialKeys, state] = parseMultipleKeypresses(
      INITIAL_STATE,
      '\x1b]11;',
    );
    const [keys, finalState] = parseMultipleKeypresses(state, null);
    expect([...initialKeys, ...keys].map((key) => key.sequence)).toEqual([
      '\x1b]11;',
    ]);
    expect(finalState.pendingResponse).toBe('');
  });

  it('delivers Enter between a response head and tail without leaking the tail', () => {
    const { keys, state } = feedWithFlushes(
      '\x1b]11;r',
      null,
      '\r',
      'gb:2828/2c2c/3434\x1b\\',
    );
    expect(keys).toEqual([
      expect.objectContaining({ kind: 'key', name: 'return', sequence: '\r' }),
      {
        kind: 'response',
        sequence: OSC11,
        response: { type: 'osc', code: 11, data: 'rgb:2828/2c2c/3434' },
      },
    ]);
    expect(state.pendingResponse).toBe('');
  });

  it('preserves Enter coalesced into a partial response head', () => {
    const { keys } = feedWithFlushes(
      '\x1b]11;r\r',
      null,
      'gb:2828/2c2c/3434\x1b\\',
    );
    expect(keys).toEqual([
      expect.objectContaining({ kind: 'key', name: 'return', sequence: '\r' }),
      {
        kind: 'response',
        sequence: OSC11,
        response: { type: 'osc', code: 11, data: 'rgb:2828/2c2c/3434' },
      },
    ]);
  });

  it('preserves Enter interleaved into a response continuation', () => {
    const { keys } = feedWithFlushes(
      '\x1b]11;r',
      null,
      'gb:28\r28/2c2c/3434\x1b\\',
    );
    expect(keys).toEqual([
      expect.objectContaining({ kind: 'key', name: 'return', sequence: '\r' }),
      {
        kind: 'response',
        sequence: OSC11,
        response: { type: 'osc', code: 11, data: 'rgb:2828/2c2c/3434' },
      },
    ]);
  });

  it('preserves Enter interleaved into a complete response', () => {
    const [keys] = parseMultipleKeypresses(
      INITIAL_STATE,
      '\x1b]11;r\rgb:2828/2c2c/3434\x1b\\',
    );
    expect(keys).toEqual([
      expect.objectContaining({ kind: 'key', name: 'return', sequence: '\r' }),
      {
        kind: 'response',
        sequence: OSC11,
        response: { type: 'osc', code: 11, data: 'rgb:2828/2c2c/3434' },
      },
    ]);
  });

  it('delivers an arrow between a response head and tail without leaking the tail', () => {
    const { keys } = feedWithFlushes(
      '\x1b]11;r',
      null,
      '\x1b[A',
      'gb:2828/2c2c/3434\x1b\\',
    );
    expect(keys).toEqual([
      expect.objectContaining({ kind: 'key', name: 'up', sequence: '\x1b[A' }),
      {
        kind: 'response',
        sequence: OSC11,
        response: { type: 'osc', code: 11, data: 'rgb:2828/2c2c/3434' },
      },
    ]);
  });

  it('delivers bare Escape between a response head and tail', () => {
    const { keys } = feedWithFlushes(
      '\x1b]11;r',
      null,
      '\x1b',
      null,
      'gb:2828/2c2c/3434\x1b\\',
    );
    expect(keys).toEqual([
      expect.objectContaining({ kind: 'key', name: 'escape', sequence: '\x1b' }),
      {
        kind: 'response',
        sequence: OSC11,
        response: { type: 'osc', code: 11, data: 'rgb:2828/2c2c/3434' },
      },
    ]);
  });

  it('preserves an arrow key coalesced into a partial response head', () => {
    const { keys } = feedWithFlushes(
      '\x1b]11;r\x1b[A',
      null,
      'gb:2828/2c2c/3434\x1b\\',
    );
    expect(keys).toEqual([
      expect.objectContaining({ kind: 'key', name: 'up', sequence: '\x1b[A' }),
      {
        kind: 'response',
        sequence: OSC11,
        response: { type: 'osc', code: 11, data: 'rgb:2828/2c2c/3434' },
      },
    ]);
  });

  it('gives up on a truncated reply after the carry limit', () => {
    // Terminal sent a head and never terminated it: the head is dropped after
    // a bounded number of chunks so typing keeps working.
    const { keys, state } = feedWithFlushes(
      '\x1b]11;r',
      null,
      'a',
      null,
      'b',
      null,
      'c',
    );
    expect(state.pendingResponse).toBe('');
    expect((keys.at(-1) as ParsedKey).sequence).toBe('c');
  });
});

describe('parseMultipleKeypresses – bracketed paste', () => {
  it('aggregates chunked content into one paste key', () => {
    const [startKeys, pasteState] = parseMultipleKeypresses(
      INITIAL_STATE,
      '\x1b[200~hello',
    );

    expect(startKeys).toEqual([]);
    expect(pasteState.mode).toBe('IN_PASTE');
    expect(pasteState.pasteBuffer).toBe('hello');
    expect(pasteState.incomplete).toBe('');

    const [endKeys, finalState] = parseMultipleKeypresses(
      pasteState,
      ' world\x1b[201~',
    );

    expect(endKeys).toHaveLength(1);
    expect(endKeys[0]).toMatchObject({
      kind: 'key',
      isPasted: true,
      sequence: 'hello world',
    });
    expect(finalState.mode).toBe('NORMAL');
    expect(finalState.pasteBuffer).toBe('');
  });

  it('flushes an unterminated paste once and leaves paste mode', () => {
    const [, pasteState] = parseMultipleKeypresses(
      INITIAL_STATE,
      '\x1b[200~partial paste',
    );

    const [flushedKeys, finalState] = parseMultipleKeypresses(pasteState, null);

    expect(flushedKeys).toHaveLength(1);
    expect(flushedKeys[0]).toMatchObject({
      kind: 'key',
      isPasted: true,
      sequence: 'partial paste',
    });
    expect(finalState.mode).toBe('NORMAL');
    expect(finalState.pasteBuffer).toBe('');
  });

  it('leaves paste mode when an empty unterminated paste is flushed', () => {
    const [, pasteState] = parseMultipleKeypresses(
      INITIAL_STATE,
      '\x1b[200~',
    );

    const [flushedKeys, finalState] = parseMultipleKeypresses(pasteState, null);

    expect(flushedKeys).toEqual([]);
    expect(finalState.mode).toBe('NORMAL');
    expect(finalState.pasteBuffer).toBe('');
  });
});
