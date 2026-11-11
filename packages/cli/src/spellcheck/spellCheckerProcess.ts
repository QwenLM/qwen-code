/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A long-lived spell checker driven over the ispell `-a` pipe protocol.
 *
 * Every failure here is silent. Spell checking is a decoration on the prompt
 * input, so a missing dictionary, a checker that stopped answering, or a stream
 * that turned out not to speak the protocol all end the same way: the underlines
 * stop appearing and a line lands in the debug log. Nothing reaches the UI.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { resolveExecutable, runLogger } from '@qwen-code/core';
import type { SpellcheckCheckerSetting } from '../config/settingsSchema.js';
import {
  BATCH_WORD_LIMITS,
  CHECKERS,
  buildCheckerArgs,
  encodeCheckLine,
  isCheckerName,
  isSendableWord,
  MAX_REQUEST_LINE_BYTES,
  MAX_RESPONSE_LINE_BYTES,
  parseBanner,
  parseResponseLine,
  TERSE_MODE_COMMAND,
  type CheckerName,
} from './protocol.js';

/** How long the greeting may take before the checker counts as broken. */
const BANNER_TIMEOUT_MS = 3_000;

/** How long one batch may go unanswered before the checker counts as too slow. */
const RESPONSE_TIMEOUT_MS = 15_000;

/** Automatic restarts allowed per session, for fault-class failures. */
const RESTART_BUDGET = 1;

const RESTART_DELAY_MS = 1_000;

/** Unanswered batches tolerated before spell checking gives up for the session. */
const MAX_TIMEOUT_STRIKES = 3;

/** Answered batches that clear both failure counters. */
const HEALTHY_BATCH_STREAK = 20;

/** Verdicts held at once. Prompt input never approaches this. */
const MAX_CACHED_VERDICTS = 10_000;

/**
 * The child's environment, built up rather than filtered down.
 *
 * A checker needs to find its dictionaries and nothing else, so it is given the
 * handful of variables that decide where those live. Starting from `{}` means a
 * secret added to this process's environment later cannot leak into it.
 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  // Windows equivalents.
  'Path',
  'PATHEXT',
  'SystemRoot',
  'USERPROFILE',
  'TEMP',
  'TMP',
] as const;

/** A child's pipes are sockets at runtime, but not in the stream typings. */
function unrefStream(stream: unknown): void {
  (stream as { unref?: () => void } | null)?.unref?.();
}

function buildCheckerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * `restarting` is idle with a respawn already scheduled. It is distinct from
 * `idle` so that a keystroke arriving inside the restart delay queues its words
 * instead of starting a second checker that the pending timer would then
 * orphan.
 */
type State =
  | 'idle'
  | 'resolving'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'unavailable';

/**
 * Reads a verdict: true for misspelled, false for known good, undefined for
 * not checked yet.
 *
 * A fresh function is published whenever verdicts change, so its identity is
 * the signal a `useSyncExternalStore` subscriber re-renders on.
 */
export type VerdictLookup = (word: string) => boolean | undefined;

export interface SpellCheckerProcessOptions {
  checker: SpellcheckCheckerSetting;
  language?: string;
  /** Test seam. */
  spawnFn?: typeof spawn;
  /** Test seam. */
  resolveExecutableFn?: (exe: string) => Promise<string | undefined>;
}

export class SpellCheckerProcess {
  constructor(options: SpellCheckerProcessOptions) {
    this.#checker = options.checker;
    this.#language = options.language;
    this.#spawnFn = options.spawnFn ?? spawn;
    this.#resolveExecutableFn = options.resolveExecutableFn ?? resolveExecutable;
  }

  readonly #checker: SpellcheckCheckerSetting;
  readonly #language: string | undefined;
  readonly #spawnFn: typeof spawn;
  readonly #resolveExecutableFn: (exe: string) => Promise<string | undefined>;

  #state: State = 'idle';
  #child: ChildProcess | null = null;
  /** Which engine answered, which sets the batch size. */
  #engine: CheckerName = 'ispell';
  #resolved: { command: string; args: string[] } | null = null;

  #stdoutBuffer = '';
  #bannerSeen = false;

  readonly #verdicts = new Map<string, boolean>();
  #lookup: VerdictLookup = () => undefined;
  readonly #listeners = new Set<() => void>();

  /** Words waiting for a batch slot. Insertion order is checking order. */
  #queued = new Set<string>();
  #inFlight: string[] | null = null;
  #inFlightMisspelled = new Set<string>();

  #bannerTimer: NodeJS.Timeout | null = null;
  #responseTimer: NodeJS.Timeout | null = null;
  #restartTimer: NodeJS.Timeout | null = null;

  #restartsUsed = 0;
  #timeoutStrikes = 0;
  #healthyBatches = 0;
  #disposed = false;

  // Stable identities: `useSyncExternalStore` compares these across renders.
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * The current verdict reader.
   *
   * Stable between batches and replaced whenever verdicts land.
   */
  readonly getVerdicts = (): VerdictLookup => this.#lookup;

  /**
   * Queue words for checking, starting the checker if this is the first ask.
   *
   * Words with a verdict already are dropped, so repeated calls with a growing
   * prompt only ever cost the new words.
   */
  request(words: readonly string[]): void {
    if (this.#isStopped()) return;

    for (const word of words) {
      if (!isSendableWord(word)) continue;
      if (this.#verdicts.has(word)) continue;
      this.#queued.add(word);
    }

    if (this.#queued.size === 0) return;

    if (this.#state === 'idle') {
      void this.#start();
      return;
    }
    // While `restarting`, the pending timer owns the next spawn; the words wait
    // in the queue and go out when it reports ready.
    if (this.#state === 'restarting') return;
    this.#flush();
  }

  dispose(): void {
    this.#disposed = true;
    this.#teardown();
    this.#queued.clear();
    this.#listeners.clear();
  }

  // --- startup ------------------------------------------------------------

  async #start(): Promise<void> {
    this.#state = 'resolving';

    if (!this.#resolved) {
      const resolved = await this.#resolveChecker();
      if (this.#disposed) return;
      if (!resolved) {
        // Nothing installed is not a failure to recover from — there is no
        // checker to restart. Stay quiet for the rest of the session.
        this.#state = 'unavailable';
        this.#queued.clear();
        return;
      }
      this.#resolved = resolved;
    }

    this.#spawnChecker();
  }

  async #resolveChecker(): Promise<{ command: string; args: string[] } | null> {
    const candidates =
      this.#checker !== 'auto' && isCheckerName(this.#checker)
        ? [this.#checker]
        : [...CHECKERS];

    for (const name of candidates) {
      let command: string | undefined;
      try {
        command = await this.#resolveExecutableFn(name);
      } catch (error) {
        runLogger.debug(`[spellcheck] failed to look for ${name} on PATH:`, error);
        continue;
      }
      if (command) {
        return { command, args: buildCheckerArgs(name, this.#language) };
      }
    }

    runLogger.debug(
      `[spellcheck] no checker found on PATH (looked for ${candidates.join(
        ', ',
      )}); spell checking stays off`,
    );
    return null;
  }

  #spawnChecker(): void {
    const resolved = this.#resolved;
    if (!resolved || this.#disposed) return;

    // Whatever came before is finished with. Killing here as well as on the
    // failure paths means no caller can leave a checker running untracked,
    // which would outlive the CLI and keep writing into the protocol state.
    this.#killChild();
    this.#clearTimer('restart');
    this.#resetChildState();

    this.#state = 'starting';
    this.#bannerSeen = false;
    this.#stdoutBuffer = '';

    let child: ChildProcess;
    try {
      child = this.#spawnFn(resolved.command, resolved.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildCheckerEnv(),
        // Not the project directory: a checker has no business reading the
        // files the user happens to be working on.
        cwd: os.homedir(),
        windowsHide: true,
      });
    } catch (error) {
      runLogger.debug('[spellcheck] failed to spawn checker:', error);
      this.#handleFault();
      return;
    }

    this.#child = child;
    // The checker must never be what keeps the CLI alive at exit. The pipes
    // hold their own handles, so they are released too.
    child.unref?.();
    unrefStream(child.stdin);
    unrefStream(child.stdout);
    unrefStream(child.stderr);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      // Same identity check as the error and exit handlers: output from a
      // checker this instance has moved on from must not reach the parser.
      if (this.#child !== child) return;
      this.#onStdout(chunk);
    });
    // Drained and dropped: a checker's warnings are not this feature's business,
    // but an unread pipe would eventually block it.
    child.stderr?.resume();

    child.on('error', (error) => {
      if (this.#child !== child) return;
      runLogger.debug('[spellcheck] checker process error:', error);
      this.#handleFault();
    });
    child.stdin?.on('error', (error) => {
      if (this.#child !== child) return;
      runLogger.debug('[spellcheck] checker stdin error:', error);
      this.#handleFault();
    });
    child.on('exit', () => {
      if (this.#child !== child) return;
      if (this.#state === 'starting') {
        runLogger.debug(
          '[spellcheck] checker exited before it was ready; a missing ' +
            'dictionary usually means spellcheck.language needs setting',
        );
      } else {
        runLogger.debug('[spellcheck] checker exited unexpectedly');
      }
      this.#handleFault();
    });

    this.#bannerTimer = this.#setTimer(() => {
      runLogger.debug('[spellcheck] checker did not greet in time');
      this.#handleFault();
    }, BANNER_TIMEOUT_MS);
  }

  // --- protocol -----------------------------------------------------------

  #onStdout(chunk: string): void {
    if (this.#isStopped()) return;

    this.#stdoutBuffer += chunk;

    let newlineIndex = this.#stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      let line = this.#stdoutBuffer.slice(0, newlineIndex);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1);
      // A checker answering with CRLF would otherwise turn the batch's
      // terminating blank line into "\r" and read as a protocol error.
      if (line.endsWith('\r')) line = line.slice(0, -1);

      this.#onLine(line);
      if (this.#isStopped()) return;

      newlineIndex = this.#stdoutBuffer.indexOf('\n');
    }

    if (this.#stdoutBuffer.length > MAX_RESPONSE_LINE_BYTES) {
      runLogger.debug('[spellcheck] checker sent an oversized line');
      this.#handleFault();
    }
  }

  #onLine(line: string): void {
    if (!this.#bannerSeen) {
      this.#bannerSeen = true;
      const engine = parseBanner(line);
      if (!engine) {
        runLogger.debug('[spellcheck] checker did not send an ispell banner');
        this.#handleFault();
        return;
      }
      this.#engine = engine;
      this.#clearTimer('banner');
      this.#state = 'ready';
      this.#child?.stdin?.write(TERSE_MODE_COMMAND);
      runLogger.debug(`[spellcheck] ready (${engine})`);
      this.#flush();
      return;
    }

    const parsed = parseResponseLine(line);
    switch (parsed.type) {
      case 'misspelled':
        this.#inFlightMisspelled.add(parsed.word);
        return;
      case 'correct':
        return;
      case 'end':
        this.#completeBatch();
        return;
      case 'unrecognized':
        runLogger.debug('[spellcheck] unrecognized response line');
        this.#handleFault();
        return;
      default: {
        const exhaustive: never = parsed;
        throw new Error(`Unhandled response: ${String(exhaustive)}`);
      }
    }
  }

  /** Record the batch's verdicts and let the next one go. */
  #completeBatch(): void {
    const inFlight = this.#inFlight;
    if (!inFlight) {
      // A blank line with nothing outstanding is not the protocol.
      runLogger.debug('[spellcheck] unexpected end of batch');
      this.#handleFault();
      return;
    }

    if (this.#stdoutBuffer.length > 0) {
      runLogger.debug('[spellcheck] trailing bytes at end of batch');
      this.#handleFault();
      return;
    }

    this.#commitInFlight(inFlight);

    this.#healthyBatches += 1;
    if (this.#healthyBatches >= HEALTHY_BATCH_STREAK) {
      // A long session should not accumulate its way to disabled on the
      // strength of failures it has long since recovered from.
      this.#healthyBatches = 0;
      this.#restartsUsed = 0;
      this.#timeoutStrikes = 0;
    }

    this.#flush();
  }

  #commitInFlight(inFlight: readonly string[]): void {
    this.#clearTimer('response');
    for (const word of inFlight) {
      this.#verdicts.set(word, this.#inFlightMisspelled.has(word));
    }
    this.#inFlight = null;
    this.#inFlightMisspelled.clear();
    this.#evictIfFull();

    // A new reader over the same map: the contents are already current, the
    // fresh identity is what tells subscribers to look again.
    const verdicts = this.#verdicts;
    this.#lookup = (word) => verdicts.get(word);
    this.#notify();
  }

  #evictIfFull(): void {
    if (this.#verdicts.size <= MAX_CACHED_VERDICTS) return;
    // Drop the older half wholesale. A word whose verdict is discarded is
    // simply checked again the next time it is typed.
    const drop = Math.floor(this.#verdicts.size / 2);
    let dropped = 0;
    for (const word of this.#verdicts.keys()) {
      this.#verdicts.delete(word);
      if (++dropped >= drop) break;
    }
  }

  #flush(): void {
    if (this.#state !== 'ready' || this.#inFlight || this.#disposed) return;
    if (this.#queued.size === 0) return;

    const limit = BATCH_WORD_LIMITS[this.#engine];
    const batch: string[] = [];
    let bytes = 1; // the leading `^`

    for (const word of this.#queued) {
      if (batch.length >= limit) break;
      const cost = Buffer.byteLength(word, 'utf8') + 1;
      if (batch.length > 0 && bytes + cost > MAX_REQUEST_LINE_BYTES) break;
      batch.push(word);
      bytes += cost;
    }
    if (batch.length === 0) return;

    for (const word of batch) this.#queued.delete(word);

    this.#inFlight = batch;
    this.#inFlightMisspelled.clear();
    this.#responseTimer = this.#setTimer(
      () => this.#handleResponseTimeout(),
      RESPONSE_TIMEOUT_MS,
    );
    this.#child?.stdin?.write(encodeCheckLine(batch));
  }

  // --- failure handling ---------------------------------------------------

  /**
   * A checker that stopped answering.
   *
   * Kept apart from {@link #handleFault} and its restart budget: a slow checker
   * is not a broken one, and charging both counters for the same event would
   * spend the budget before the strikes could ever run out.
   */
  #handleResponseTimeout(): void {
    const inFlight = this.#inFlight;
    if (!inFlight) return;

    // Take what arrived and call the rest correct. That trades dictionary
    // accuracy for an input that never stalls, and the words are re-checked
    // once eviction drops them.
    this.#commitInFlight(inFlight);

    this.#timeoutStrikes += 1;
    this.#healthyBatches = 0;
    runLogger.debug(
      `[spellcheck] checker did not answer within ${RESPONSE_TIMEOUT_MS}ms ` +
        `(${this.#timeoutStrikes}/${MAX_TIMEOUT_STRIKES})`,
    );

    if (this.#timeoutStrikes >= MAX_TIMEOUT_STRIKES) {
      this.#disable('checker too slow');
      return;
    }

    // Straight back up: a slow checker gets a fresh process without spending
    // the restart budget. `#spawnChecker` clears the old child's state.
    this.#spawnChecker();
  }

  /** A checker that failed, crashed, or turned out not to speak the protocol. */
  #handleFault(): void {
    if (this.#isStopped()) return;

    this.#killChild();
    this.#resetChildState();
    this.#healthyBatches = 0;

    if (this.#restartsUsed >= RESTART_BUDGET) {
      this.#disable('checker failed');
      return;
    }
    this.#restartsUsed += 1;
    this.#state = 'restarting';
    this.#restartTimer = this.#setTimer(() => {
      this.#restartTimer = null;
      if (this.#isStopped()) return;
      this.#spawnChecker();
    }, RESTART_DELAY_MS);
  }

  /**
   * Forget everything that belonged to the checker that just went away.
   *
   * Its timers must not outlive it: a banner timeout left armed would fire
   * against the replacement and spend the last restart on a checker that was
   * working, and a response timeout left armed would block the replacement's
   * first batch and then record a batch nobody answered as correctly spelled.
   * The unanswered words go back to the queue for the replacement to check.
   */
  #resetChildState(): void {
    this.#clearTimer('banner');
    this.#clearTimer('response');
    if (this.#inFlight) {
      for (const word of this.#inFlight) this.#queued.add(word);
      this.#inFlight = null;
    }
    this.#inFlightMisspelled.clear();
  }

  #disable(reason: string): void {
    runLogger.debug(`[spellcheck] ${reason}; spell checking is off for this session`);
    this.#teardown();
    this.#state = 'unavailable';
    this.#queued.clear();
  }

  // Both callers clear the queue immediately afterwards, so the words
  // `#resetChildState` hands back go nowhere.
  #teardown(): void {
    this.#clearTimer('restart');
    this.#killChild();
    this.#resetChildState();
  }

  #killChild(): void {
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    this.#stdoutBuffer = '';
    this.#bannerSeen = false;
    child.removeAllListeners();
    child.stdout?.removeAllListeners();
    child.stdin?.removeAllListeners();
    try {
      // Ask first: a checker given a closed stdin exits on its own terms.
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    } catch {
      // A process that is already gone needs nothing.
    }
  }

  // --- plumbing -----------------------------------------------------------

  /** Nothing more will be checked, either for now or ever. */
  #isStopped(): boolean {
    return this.#disposed || this.#state === 'unavailable';
  }

  #setTimer(fn: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  }

  #clearTimer(which: 'banner' | 'response' | 'restart'): void {
    if (which === 'banner' && this.#bannerTimer) {
      clearTimeout(this.#bannerTimer);
      this.#bannerTimer = null;
    } else if (which === 'response' && this.#responseTimer) {
      clearTimeout(this.#responseTimer);
      this.#responseTimer = null;
    } else if (which === 'restart' && this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        runLogger.debug('[spellcheck] listener threw:', error);
      }
    }
  }
}
