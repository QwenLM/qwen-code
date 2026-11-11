/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { SpellCheckerProcess } from './spellCheckerProcess.js';

const ASPELL_BANNER =
  '@(#) International Ispell Version 3.1.20 (but really Aspell 0.60.8)\n';
const HUNSPELL_BANNER =
  '@(#) International Ispell Version 3.2.06 (but really Hunspell 1.7.2)\n';

/** A stand-in for the checker, driven by the test rather than by a dictionary. */
class FakeChecker extends EventEmitter {
  readonly stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    unref: vi.fn(),
  });
  readonly stdout = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
    unref: vi.fn(),
  });
  readonly stderr = Object.assign(new EventEmitter(), {
    resume: vi.fn(),
    unref: vi.fn(),
  });
  readonly kill = vi.fn(() => {
    this.exitCode = 0;
    return true;
  });
  readonly unref = vi.fn();
  exitCode: number | null = null;
  signalCode: string | null = null;

  /** What the checker was asked to check, one entry per request line. */
  get requests(): string[] {
    return this.stdin.write.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('^'))
      .map((line) => line.slice(1).trimEnd());
  }

  say(text: string): void {
    this.stdout.emit('data', text);
  }
}

interface Harness {
  checker: SpellCheckerProcess;
  spawnFn: ReturnType<typeof vi.fn>;
  children: FakeChecker[];
  /** The most recently spawned fake. */
  child: () => FakeChecker;
}

function createHarness(
  options: {
    checker?: 'auto' | 'aspell' | 'hunspell' | 'ispell';
    language?: string;
    resolve?: (exe: string) => Promise<string | undefined>;
  } = {},
): Harness {
  const children: FakeChecker[] = [];
  const spawnFn = vi.fn(() => {
    const child = new FakeChecker();
    children.push(child);
    return child as unknown as ChildProcess;
  });

  const checker = new SpellCheckerProcess({
    checker: options.checker ?? 'auto',
    language: options.language,
    spawnFn: spawnFn as never,
    resolveExecutableFn:
      options.resolve ?? (async (exe) => `/usr/bin/${exe}`),
  });

  return {
    checker,
    spawnFn,
    children,
    child: () => children[children.length - 1]!,
  };
}

/** Let the async PATH lookup inside `request()` settle. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('SpellCheckerProcess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('startup', () => {
    it('spawns the first checker on PATH and greets it', async () => {
      const harness = createHarness();
      harness.checker.request(['helo']);
      await settle();

      expect(harness.spawnFn).toHaveBeenCalledTimes(1);
      const [command, args] = harness.spawnFn.mock.calls[0]!;
      expect(command).toBe('/usr/bin/aspell');
      expect(args).toEqual(['-a', '--encoding=utf-8', '--sug-mode=ultra']);
    });

    it('restricts the search when a checker is named', async () => {
      const resolve = vi.fn(async (exe: string) =>
        exe === 'hunspell' ? '/usr/bin/hunspell' : undefined,
      );
      const harness = createHarness({ checker: 'hunspell', resolve });
      harness.checker.request(['helo']);
      await settle();

      expect(resolve).toHaveBeenCalledExactlyOnceWith('hunspell');
      expect(harness.spawnFn).toHaveBeenCalledTimes(1);
    });

    it('keeps the checker away from the project and the environment', async () => {
      process.env['SPELLCHECK_TEST_SECRET'] = 'do-not-leak';
      try {
        const harness = createHarness();
        harness.checker.request(['helo']);
        await settle();

        const options = harness.spawnFn.mock.calls[0]![2] as {
          env: NodeJS.ProcessEnv;
          cwd: string;
          windowsHide: boolean;
        };
        expect(options.env['SPELLCHECK_TEST_SECRET']).toBeUndefined();
        expect(options.env['PATH']).toBe(process.env['PATH']);
        expect(options.cwd).toBe(os.homedir());
        expect(options.windowsHide).toBe(true);
      } finally {
        delete process.env['SPELLCHECK_TEST_SECRET'];
      }
    });

    it('enters terse mode once the banner arrives', async () => {
      const harness = createHarness();
      harness.checker.request(['helo']);
      await settle();
      harness.child().say(ASPELL_BANNER);

      expect(harness.child().stdin.write).toHaveBeenCalledWith('!\n');
    });

    it('stays off when no checker is installed', async () => {
      const harness = createHarness({ resolve: async () => undefined });
      expect(() => harness.checker.request(['helo'])).not.toThrow();
      await settle();

      expect(harness.spawnFn).not.toHaveBeenCalled();
    });
  });

  describe('checking', () => {
    async function ready(banner = ASPELL_BANNER): Promise<Harness> {
      const harness = createHarness();
      harness.checker.request(['helo', 'world']);
      await settle();
      harness.child().say(banner);
      return harness;
    }

    it('sends the queued words as one escaped line', async () => {
      const harness = await ready();
      expect(harness.child().requests).toEqual(['helo world']);
    });

    it('records a verdict for every word in the batch', async () => {
      const harness = await ready();
      harness.child().say('& helo 3 0: hello, halo\n');
      harness.child().say('\n');

      const verdicts = harness.checker.getVerdicts();
      expect(verdicts('helo')).toBe(true);
      // Terse mode says nothing about correct words, so silence is the verdict.
      expect(verdicts('world')).toBe(false);
      expect(verdicts('unseen')).toBeUndefined();
    });

    it('publishes a new reader so subscribers know to look again', async () => {
      const harness = await ready();
      const before = harness.checker.getVerdicts();
      const listener = vi.fn();
      harness.checker.subscribe(listener);

      harness.child().say('# helo 0\n\n');

      expect(listener).toHaveBeenCalled();
      expect(harness.checker.getVerdicts()).not.toBe(before);
    });

    it('never asks about a word whose verdict it already has', async () => {
      const harness = await ready();
      harness.child().say('# helo 0\n\n');

      harness.checker.request(['helo', 'wrold']);
      expect(harness.child().requests).toEqual(['helo world', 'wrold']);
    });

    it('splits batches to what hunspell will answer', async () => {
      const harness = createHarness();
      const words = Array.from({ length: 20 }, (_, i) => `word${i}zz`);
      harness.checker.request(words);
      await settle();
      harness.child().say(HUNSPELL_BANNER);

      // 16 for hunspell, the rest once the first batch is answered.
      expect(harness.child().requests[0]!.split(' ')).toHaveLength(16);
      harness.child().say('\n');
      expect(harness.child().requests[1]!.split(' ')).toHaveLength(4);
    });

    it('reads a response that arrives split across chunks', async () => {
      const harness = await ready();
      harness.child().say('& he');
      harness.child().say('lo 3 0: hello\n\n');

      expect(harness.checker.getVerdicts()('helo')).toBe(true);
    });

    it('reads a checker that answers with CRLF', async () => {
      const harness = createHarness();
      harness.checker.request(['helo']);
      await settle();
      harness.child().say(ASPELL_BANNER.replace('\n', '\r\n'));
      harness.child().say('# helo 0\r\n\r\n');

      expect(harness.checker.getVerdicts()('helo')).toBe(true);
      expect(harness.spawnFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('failure handling', () => {
    async function ready(): Promise<Harness> {
      const harness = createHarness();
      harness.checker.request(['helo']);
      await settle();
      harness.child().say(ASPELL_BANNER);
      return harness;
    }

    it('restarts once after a crash, then gives up', async () => {
      const harness = await ready();

      harness.child().emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.spawnFn).toHaveBeenCalledTimes(2);

      harness.child().say(ASPELL_BANNER);
      harness.child().emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.spawnFn).toHaveBeenCalledTimes(2);
    });

    it('gives up when the greeting is not the protocol', async () => {
      const harness = createHarness();
      harness.checker.request(['helo']);
      await settle();

      harness.child().say('bash: aspell: command not found\n');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.spawnFn).toHaveBeenCalledTimes(2);

      harness.child().say('still not a checker\n');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.spawnFn).toHaveBeenCalledTimes(2);
    });

    it('gives up when the greeting never comes', async () => {
      const harness = createHarness();
      harness.checker.request(['helo']);
      await settle();

      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.spawnFn).toHaveBeenCalledTimes(2);
    });

    it('commits what arrived when a batch times out', async () => {
      const harness = createHarness();
      harness.checker.request(['helo', 'wrold']);
      await settle();
      harness.child().say(ASPELL_BANNER);
      // Only the first of the two words is answered for.
      harness.child().say('& helo 3 0: hello\n');

      await vi.advanceTimersByTimeAsync(15_000);

      const verdicts = harness.checker.getVerdicts();
      expect(verdicts('helo')).toBe(true);
      // Unanswered, and taken as correct rather than left pending: the input
      // keeps up at the cost of missing one underline.
      expect(verdicts('wrold')).toBe(false);
    });

    it('reconnects on a timeout without spending the restart budget', async () => {
      const harness = await ready();

      // Three unanswered batches, each reconnecting immediately.
      for (let strike = 1; strike <= 2; strike++) {
        await vi.advanceTimersByTimeAsync(15_000);
        expect(harness.spawnFn).toHaveBeenCalledTimes(strike + 1);
        harness.checker.request([`word${strike}zz`]);
        harness.child().say(ASPELL_BANNER);
      }

      await vi.advanceTimersByTimeAsync(15_000);
      // The third strike ends it, and no restart delay revives it.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.spawnFn).toHaveBeenCalledTimes(3);

      harness.checker.request(['another']);
      await settle();
      expect(harness.spawnFn).toHaveBeenCalledTimes(3);
    });

    it('does not let the dead checker timers fire at the replacement', async () => {
      // The banner timeout belongs to the child that was starting, not to the
      // one that replaces it. Left armed it would kill a healthy checker, and
      // with the restart budget already spent that ends spell checking.
      const harness = createHarness();
      harness.checker.request(['helo']);
      await settle();

      await vi.advanceTimersByTimeAsync(500);
      harness.child().emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.spawnFn).toHaveBeenCalledTimes(2);

      const replacement = harness.child();
      replacement.say(ASPELL_BANNER);
      // Past the dead child's 3s banner deadline.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(replacement.kill).not.toHaveBeenCalled();
      replacement.say('# helo 0\n\n');
      expect(harness.checker.getVerdicts()('helo')).toBe(true);
    });

    it('gives an unanswered batch back to the replacement', async () => {
      const harness = await ready();
      expect(harness.child().requests).toEqual(['helo']);

      harness.child().say('Segmentation fault\n');
      await vi.advanceTimersByTimeAsync(1_000);

      // The words the dead checker never answered for go straight back out.
      // With the old batch left in flight this would have sent nothing, and
      // the stale timeout would have recorded "helo" as correctly spelled.
      const replacement = harness.child();
      replacement.say(ASPELL_BANNER);
      expect(replacement.requests).toEqual(['helo']);

      replacement.say('# helo 0\n\n');
      expect(harness.checker.getVerdicts()('helo')).toBe(true);
    });

    it('does not spawn a rival checker when typing during the restart delay', async () => {
      const harness = await ready();
      harness.child().emit('exit', 1, null);

      // A keystroke lands inside the one-second restart window.
      await vi.advanceTimersByTimeAsync(500);
      harness.checker.request(['wrold']);
      await settle();
      expect(harness.spawnFn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(harness.spawnFn).toHaveBeenCalledTimes(2);

      // The word typed during the wait is not lost.
      harness.child().say(ASPELL_BANNER);
      expect(harness.child().requests[0]).toContain('wrold');
    });

    it('treats an unrecognized response as a broken checker', async () => {
      const harness = await ready();
      harness.child().say('Segmentation fault\n');

      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.spawnFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('dispose', () => {
    it('closes stdin before killing the checker', async () => {
      const harness = createHarness();
      harness.checker.request(['helo']);
      await settle();
      const child = harness.child();

      harness.checker.dispose();

      expect(child.stdin.end).toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalled();
      expect(child.stdin.end.mock.invocationCallOrder[0]!).toBeLessThan(
        child.kill.mock.invocationCallOrder[0]!,
      );
    });

    it('leaves an already-exited checker alone', async () => {
      const harness = createHarness();
      harness.checker.request(['helo']);
      await settle();
      const child = harness.child();
      child.exitCode = 0;

      harness.checker.dispose();
      expect(child.kill).not.toHaveBeenCalled();
    });

    it('stops checking once disposed', async () => {
      const harness = createHarness();
      harness.checker.dispose();
      harness.checker.request(['helo']);
      await settle();

      expect(harness.spawnFn).not.toHaveBeenCalled();
    });
  });
});
