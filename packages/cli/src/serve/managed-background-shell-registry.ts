/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ManagedChildRunProcess,
  ChildRunExitEvidence,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';
import type { ToolResultExpectedIdentity } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import type {
  ManagedShellCapturePublisher,
  ManagedShellCaptureSink,
} from './managed-runtime-tool-executor.js';
import { constants } from 'node:os';

// H3 of #12827: the managed-runtime worker's registry of supervised
// background Shells. A start call settles with the durable handle while the
// physical process lives on here: the registry owns the hold that keeps the
// Runtime from being released, finishes the bounded output capture once the
// process ends, and answers terminate by the same evidence rules as the
// supervisor. Incremental output publication and record orchestration are
// the next increments; this registry only guarantees hold, bounded capture
// and a proven end.

export interface BackgroundShellReceipt {
  readonly unitName: string;
  readonly evidence: ChildRunExitEvidence | null;
  /** The finalized output was not delivered, with its reason. */
  readonly captureError: string | null;
}

interface Entry {
  readonly unitName: string;
  readonly sessionId: string;
  readonly process: ManagedChildRunProcess;
  readonly sink: ManagedShellCaptureSink;
  readonly publisher: ManagedShellCapturePublisher;
  readonly identity: ToolResultExpectedIdentity;
  /**
   * Set when any stop path (terminate/stopSession/stopAll) asks for the
   * process's end: the finalize then carries the platform-stop marker, so
   * the record can project `stop_requested` instead of a bare exit
   * (#13856 A8). A natural exit never sets it, and a stop the supervisor
   * cannot prove clears it again (#13930 R1-42). The mark belongs to the
   * unit's shared in-flight stop attempt, never to one caller: concurrent
   * stops on this unit merge into the same supervisor attempt, so an
   * early caller's unproven answer cannot erase the proof a late caller
   * earned (#14464 P2).
   */
  stopRequested: boolean;
  /** The unit's shared in-flight supervisor stop attempt. */
  stop: Promise<ChildRunExitEvidence | null> | null;
  completion: Promise<BackgroundShellReceipt>;
}

export class ManagedBackgroundShellRegistry {
  private readonly entries = new Map<string, Entry>();
  // A completed entry's receipt stays until the worker ends: the Broker can
  // only ever know the Shell exited from here, and a repeated exited answer
  // is idempotent, so nothing is consumed on read.
  private readonly finished = new Map<
    string,
    { readonly sessionId: string; readonly receipt: BackgroundShellReceipt }
  >();

  constructor(private readonly eofGraceMs = 5_000) {}

  get size(): number {
    return this.entries.size;
  }

  /** Read-only: an attached or running process holds its Session's Runtime. */
  hasHolds(sessionId: string): boolean {
    return this.countBySession(sessionId) > 0;
  }

  countBySession(sessionId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId) count++;
    }
    return count;
  }

  /** The live registration of one unit, for the maintenance route. */
  describe(unitName: string): { readonly sessionId: string } | undefined {
    const entry = this.entries.get(unitName);
    return entry ? { sessionId: entry.sessionId } : undefined;
  }

  /** The retained receipt of one unit that ended on this worker. */
  describeFinished(unitName: string):
    | {
        readonly sessionId: string;
        readonly receipt: BackgroundShellReceipt;
      }
    | undefined {
    return this.finished.get(unitName);
  }

  /**
   * Registers a freshly started process and its capture pipeline, and
   * returns the completion promise that resolves with the physical end
   * evidence and the delivered output — or the reason the output never
   * arrived. The hold drops only when that promise resolves.
   */
  register(params: {
    unitName: string;
    sessionId: string;
    process: ManagedChildRunProcess;
    sink: ManagedShellCaptureSink;
    publisher: ManagedShellCapturePublisher;
    identity: ToolResultExpectedIdentity;
  }): Promise<BackgroundShellReceipt> {
    const entry: Entry = {
      ...params,
      stopRequested: false,
      stop: null,
      completion: undefined as unknown as Promise<BackgroundShellReceipt>,
    };
    entry.completion = this.complete(entry);
    this.entries.set(params.unitName, entry);
    return entry.completion;
  }

  receipt(unitName: string): Promise<BackgroundShellReceipt> | undefined {
    return this.entries.get(unitName)?.completion;
  }

  /**
   * Stops and drains one entry through the supervisor. An end it cannot
   * prove answers immediately as unproven — the hold stays registered and
   * nothing waits on a completion that may only come later.
   */
  async terminate(
    unitName: string,
    graceMs: number,
  ): Promise<BackgroundShellReceipt | undefined> {
    const entry = this.entries.get(unitName);
    if (!entry) return undefined;
    // The platform asked for this end: mark it before the stop so the
    // completion's finalize projects a requested stop, not a bare exit.
    // The mark is cleared only when the unit's shared attempt proves
    // nothing — an end the supervisor cannot prove keeps the hold, and a
    // run that survives and later exits on its own must record its real
    // end, not a requested stop nobody observed (#13930 R1-42).
    entry.stopRequested = true;
    // Overlapping stops on this unit share ONE in-flight supervisor
    // attempt: a late caller joins the first caller's answer instead of
    // earning its own, so the unproven one's unmark cannot erase the
    // proof another caller is still owed (#14464 P2).
    const pending = (entry.stop ??= entry.process.terminate(graceMs));
    try {
      const evidence = await pending;
      if (evidence === null) {
        entry.stopRequested = false;
        return { unitName, evidence: null, captureError: null };
      }
      return entry.completion;
    } finally {
      if (entry.stop === pending) entry.stop = null;
    }
  }

  /** Worker close: terminate everything; holds release as each drain ends. */
  async stopAll(graceMs: number): Promise<void> {
    const completions = [...this.entries.values()].map(async (entry) => {
      await this.terminate(entry.unitName, graceMs);
    });
    await Promise.allSettled(completions);
  }

  /**
   * Ordered close of one Session's background Shells: terminate each with
   * the same supervisor evidence rules, then wait its completion so the
   * drain's finalizations land before the caller proceeds. A Shell whose
   * stop cannot be proven keeps its hold, and the caller sees it through
   * {@link hasHolds}.
   */
  async stopSession(sessionId: string, graceMs: number): Promise<void> {
    await Promise.allSettled(
      [...this.entries.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .map(async (entry) => {
          await this.terminate(entry.unitName, graceMs);
        }),
    );
  }

  private async complete(entry: Entry): Promise<BackgroundShellReceipt> {
    const { unitName, process, sink, publisher, identity } = entry;
    let evidence: ChildRunExitEvidence | null = null;
    let captureError: string | null = null;
    try {
      const ended =
        process.exited && process.evidence !== null
          ? Promise.resolve(process.evidence)
          : // A spawn-time 'error' emits no 'exit'; drain either way, or the
            // entry — and its Runtime hold — would outlive the worker.
            new Promise<ChildRunExitEvidence | null>((resolve) => {
              process.child.once('exit', () => resolve(process.evidence));
              process.child.once('error', (cause: unknown) => {
                captureError ??=
                  cause instanceof Error ? cause.message : String(cause);
                resolve(null);
              });
            });
      const root = await ended;
      // The root's exit alone is never proof: the SHELL ended only once its
      // unit empties. A `setsid` daemon that outlives its launcher keeps
      // this coroutine — and the hold — until membership drains or a stop
      // forces it, instead of settling exited over live members.
      evidence = root === null ? null : await process.settleOnEmpty();
      // A stream seals only after its pipe EOF actually arrived; the exit
      // event may lead it, so wait for each end first. A descendant that
      // inherited the pipes keeps them open past the process's end, so the
      // wait is bounded: past the grace the stream is capped, like a worker
      // cut, never a hang.
      const eof = { stdout: false, stderr: false };
      await Promise.all(
        (['stdout', 'stderr'] as const).map(async (name) => {
          const stream = process.child[name];
          if (!stream || stream.readableEnded) {
            eof[name] = true;
            return;
          }
          await Promise.race([
            once(stream, 'end').then(() => {
              eof[name] = true;
            }),
            delay(this.eofGraceMs),
          ]);
        }),
      );
      sink.setStarted(process.child.pid ?? 0);
      sink.setProcessResult({
        rawOutput: Buffer.alloc(0),
        output: '',
        exitCode: evidence?.exitCode ?? null,
        signal: signalNumber(evidence?.exitSignal ?? null),
        error: null,
        aborted: false,
        pid: process.child.pid,
        executionMethod: 'child_process',
      });
      if (entry.stopRequested) sink.setStopRequested();
      await sink.finish('stdout', eof.stdout && evidence !== null);
      await sink.finish('stderr', eof.stderr && evidence !== null);
      const envelope = await sink.finalize(
        evidence?.exitCode === 0 ? 'success' : 'error',
        [],
        evidence?.exitCode === 0
          ? undefined
          : {
              message:
                evidence === null
                  ? 'Background Shell ended without exit evidence.'
                  : evidence.exitSignal !== null
                    ? `Background Shell terminated with ${evidence.exitSignal}.`
                    : 'Background Shell exited nonzero.',
            },
      );
      try {
        if (publisher.finish) {
          await publisher.finish(identity, envelope);
        } else if (publisher.accept) {
          await publisher.accept(identity, envelope);
        }
      } catch (cause) {
        captureError = cause instanceof Error ? cause.message : String(cause);
      }
    } catch (cause) {
      captureError ??= cause instanceof Error ? cause.message : String(cause);
    } finally {
      this.entries.delete(unitName);
    }
    const receipt = { unitName, evidence, captureError };
    // The hold drops here; the receipt itself stays answerable for the
    // maintenance route until the worker ends.
    this.finished.set(entry.unitName, {
      sessionId: entry.sessionId,
      receipt,
    });
    return receipt;
  }
}

function signalNumber(name: string | null): number | null {
  if (name === null) return null;
  const number = (constants.signals as Record<string, number>)[name];
  return typeof number === 'number' ? number : null;
}
