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
import type { LocalShellReceipt } from '@qwen-code/qwen-code-core/managed-runtime/managed-shell-result-session.js';
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
  readonly completion: Promise<BackgroundShellReceipt>;
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
    const completion = this.complete(params);
    const entry: Entry = { ...params, completion };
    this.entries.set(params.unitName, entry);
    return completion;
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
    const evidence = await entry.process.terminate(graceMs);
    if (evidence === null) {
      return { unitName, evidence: null, captureError: null };
    }
    return entry.completion;
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

  private async complete(params: {
    unitName: string;
    sessionId: string;
    process: ManagedChildRunProcess;
    sink: ManagedShellCaptureSink;
    publisher: ManagedShellCapturePublisher;
    identity: ToolResultExpectedIdentity;
  }): Promise<BackgroundShellReceipt> {
    const { unitName, process, sink, publisher, identity } = params;
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
          const receipt: LocalShellReceipt = await publisher.accept(
            identity,
            envelope,
          );
          void receipt;
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
    this.finished.set(params.unitName, {
      sessionId: params.sessionId,
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
