import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlockStreamer } from './BlockStreamer.js';

describe('BlockStreamer', () => {
  let sent: string[];
  let send: (text: string) => Promise<void>;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    send = async (text: string) => {
      sent.push(text);
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createStreamer(
    overrides: Partial<{
      minChars: number;
      maxChars: number;
      idleMs: number;
      send: (text: string) => Promise<void>;
    }> = {},
  ) {
    return new BlockStreamer({
      minChars: overrides.minChars ?? 20,
      maxChars: overrides.maxChars ?? 60,
      idleMs: overrides.idleMs ?? 500,
      send: overrides.send ?? send,
    });
  }

  it('does not emit below minChars', () => {
    const s = createStreamer();
    s.push('short');
    expect(sent).toEqual([]);
    expect(s.blockCount).toBe(0);
  });

  it('emits at paragraph boundary when buffer >= minChars', async () => {
    const s = createStreamer({ minChars: 10 });
    s.push('Hello world, this is a paragraph.\n\nSecond part');
    // Should have emitted the first paragraph
    await s.flush();
    expect(sent).toEqual(['Hello world, this is a paragraph.', 'Second part']);
    expect(s.blockCount).toBe(2);
  });

  it('does not split at paragraph boundary when text before it < minChars', async () => {
    const s = createStreamer({ minChars: 100 });
    s.push('Short.\n\nAlso short.');
    // Neither section exceeds minChars, and total < maxChars
    expect(sent).toEqual([]);
    await s.flush();
    expect(sent).toEqual(['Short.\n\nAlso short.']);
  });

  it('force-splits at maxChars', async () => {
    const s = createStreamer({ minChars: 10, maxChars: 30 });
    // 40 chars, no newlines — should force-split at space near 30
    s.push('aaaa bbbb cccc dddd eeee ffff gggg hhhh');
    await s.flush();
    // First block splits around 30 chars at a space boundary
    expect(sent.length).toBe(2);
    expect(sent[0]!.length).toBeLessThanOrEqual(30);
    expect(sent[0]! + ' ' + sent[1]!).toBe(
      'aaaa bbbb cccc dddd eeee ffff gggg hhhh',
    );
  });

  it('force-splits at maxChars with no break points', async () => {
    const s = createStreamer({ minChars: 5, maxChars: 10 });
    s.push('abcdefghijklmnop'); // 16 chars, no spaces
    await s.flush();
    expect(sent).toEqual(['abcdefghij', 'klmnop']);
  });

  it('prefers paragraph break over newline when force-splitting', async () => {
    const s = createStreamer({ minChars: 5, maxChars: 30 });
    s.push('line one\n\nline two\nline three xx');
    await s.flush();
    // Should split at \n\n (pos 10) since it's within maxChars
    expect(sent[0]).toBe('line one');
    expect(sent.length).toBe(2);
  });

  it('emits on idle timer when buffer >= minChars', async () => {
    const s = createStreamer({ minChars: 5, idleMs: 500 });
    s.push('Hello world'); // 11 chars, no boundary
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(500);
    // idle timer should have fired
    await s.flush();
    expect(sent).toEqual(['Hello world']);
  });

  it('does not emit on idle timer when buffer < minChars', async () => {
    const s = createStreamer({ minChars: 100, idleMs: 500 });
    s.push('tiny');
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
    // flush still sends remaining
    await s.flush();
    expect(sent).toEqual(['tiny']);
  });

  it('resets idle timer on each push', async () => {
    const s = createStreamer({ minChars: 20, idleMs: 500 });
    s.push('Hello ');
    vi.advanceTimersByTime(400);
    s.push('world, how are you?'); // total 25 chars
    vi.advanceTimersByTime(400);
    // Only 400ms since last push, shouldn't fire yet
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(100);
    // Now 500ms since last push
    await s.flush();
    expect(sent).toEqual(['Hello world, how are you?']);
  });

  it('flush sends everything remaining', async () => {
    const s = createStreamer({ minChars: 1000 }); // very high min
    s.push('some text that will never hit minChars');
    await s.flush();
    expect(sent).toEqual(['some text that will never hit minChars']);
  });

  it('flush with empty buffer is a no-op', async () => {
    const s = createStreamer();
    await s.flush();
    expect(sent).toEqual([]);
    expect(s.blockCount).toBe(0);
  });

  it('trims whitespace from emitted blocks', async () => {
    const s = createStreamer({ minChars: 5 });
    s.push('  \n  Hello world  \n\n  Next  ');
    await s.flush();
    // The first block includes leading whitespace up to \n\n, trimmed
    expect(sent.every((t) => t === t.trim())).toBe(true);
  });

  it('does not emit empty blocks after trimming', async () => {
    const s = createStreamer({ minChars: 1 });
    s.push('\n\n\n\n');
    await s.flush();
    // All whitespace — nothing to emit after trim
    expect(sent).toEqual([]);
    expect(s.blockCount).toBe(0);
  });

  it('serializes sends', async () => {
    vi.useRealTimers();
    const order: string[] = [];
    let callIndex = 0;
    const slowSend = async (text: string) => {
      const idx = callIndex++;
      // Simulate async delay
      await new Promise<void>((r) => setTimeout(r, 10));
      order.push(`${idx}:${text}`);
    };

    const s = new BlockStreamer({
      minChars: 5,
      maxChars: 20,
      idleMs: 0,
      send: slowSend,
    });

    s.push('aaaa bbbb cccc dddd eeee ffff');
    await s.flush();
    // All sends completed in order
    expect(order.length).toBeGreaterThanOrEqual(2);
    // Verify sequential ordering
    for (let i = 0; i < order.length; i++) {
      expect(order[i]).toMatch(new RegExp(`^${i}:`));
    }
  });

  it('handles multiple paragraph boundaries', async () => {
    const s = createStreamer({ minChars: 5, maxChars: 200 });
    s.push('Para one.\n\nPara two.\n\nPara three.');
    await s.flush();
    // Should emit paras 1+2 as one block (last \n\n boundary), then para 3
    expect(sent).toEqual(['Para one.\n\nPara two.', 'Para three.']);
  });

  it('works with idleMs=0 (idle timer disabled)', async () => {
    const s = createStreamer({ minChars: 10, idleMs: 0 });
    s.push('Hello world, no timer');
    vi.advanceTimersByTime(10000);
    expect(sent).toEqual([]);
    await s.flush();
    expect(sent).toEqual(['Hello world, no timer']);
  });

  describe('error handling', () => {
    it('collects send errors and throws AggregateError on flush', async () => {
      const error = new Error('send failed');
      const s = createStreamer({
        minChars: 5,
        send: async () => {
          throw error;
        },
      });

      s.push('Hello world');
      await expect(s.flush()).rejects.toThrow(AggregateError);
      await expect(s.flush()).rejects.toThrow('1 block send(s) failed');
      expect(s.sendErrors).toEqual([error]);
    });

    it('collects multiple errors across blocks', async () => {
      let callCount = 0;
      const s = createStreamer({
        minChars: 5,
        maxChars: 20,
        send: async () => {
          callCount++;
          throw new Error(`fail ${callCount}`);
        },
      });

      // Push enough to trigger multiple blocks via force-split
      s.push('aaaa bbbb cccc dddd eeee ffff');

      try {
        await s.flush();
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        expect((err as AggregateError).errors.length).toBeGreaterThanOrEqual(2);
      }
      expect(s.sendErrors.length).toBeGreaterThanOrEqual(2);
    });

    it('tracks errors even when some sends succeed', async () => {
      let callCount = 0;
      const s = createStreamer({
        minChars: 5,
        maxChars: 20,
        send: async (text: string) => {
          callCount++;
          if (callCount === 2) throw new Error('second failed');
          sent.push(text);
        },
      });

      s.push('aaaa bbbb cccc dddd eeee ffff gggg hhhh');

      try {
        await s.flush();
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        expect((err as AggregateError).errors).toHaveLength(1);
      }
      // Some blocks were sent successfully
      expect(sent.length).toBeGreaterThanOrEqual(1);
      // The error is tracked
      expect(s.sendErrors).toHaveLength(1);
      expect((s.sendErrors[0] as Error).message).toBe('second failed');
    });

    it('flush succeeds when all sends succeed', async () => {
      const s = createStreamer({ minChars: 5 });
      s.push('Hello world');
      await s.flush(); // should not throw
      expect(s.sendErrors).toEqual([]);
    });
  });
});
