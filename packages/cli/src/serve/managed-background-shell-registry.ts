/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
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

  get size(): number {
    return this.entries.size;
  }

  /** Read-only: an attached or running process is a Runtime hold. */
  hasHolds(sessionId?: string): boolean {
    for (const entry of this.entries.values()) {
      if (sessionId === undefined || entry.sessionId === sessionId) {
        return true;
      }
    }
    return false;
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

  /** Stop and drain one entry, waiting for real exit via the supervisor. */
  async terminate(
    unitName: string,
    graceMs: number,
  ): Promise<BackgroundShellReceipt | undefined> {
    const entry = this.entries.get(unitName);
    if (!entry) return undefined;
    await entry.process.terminate(graceMs);
    return entry.completion;
  }

  /** Worker close: terminate everything; holds release as each drain ends. */
  async stopAll(graceMs: number): Promise<void> {
    const completions = [...this.entries.values()].map(async (entry) => {
      await this.terminate(entry.unitName, graceMs);
    });
    await Promise.allSettled(completions);
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
          : new Promise<ChildRunExitEvidence | null>((resolve) => {
              process.child.once('exit', () => resolve(process.evidence));
            });
      evidence = await ended;
      // A stream seals only after its pipe EOF actually arrived; the exit
      // event may lead it, so wait for each end first.
      const eof = { stdout: false, stderr: false };
      await Promise.allSettled([
        process.child.stdout && process.child.stdout.readableEnded
          ? Promise.resolve((eof.stdout = true))
          : once(process.child.stdout!, 'end').then(() => {
              eof.stdout = true;
            }),
        process.child.stderr && process.child.stderr.readableEnded
          ? Promise.resolve((eof.stderr = true))
          : once(process.child.stderr!, 'end').then(() => {
              eof.stderr = true;
            }),
      ]);
      sink.setStarted(process.child.pid ?? 0);
      sink.setProcessResult({
        rawOutput: Buffer.alloc(0),
        output: '',
        exitCode: evidence?.exitCode ?? null,
        signal: signalNumber(evidence?.exitSignal ?? null),
        error: null,
        aborted: false,
      } as Parameters<ManagedShellCaptureSink['setProcessResult']>[0]);
      await sink.finish('stdout', eof.stdout && evidence !== null);
      await sink.finish('stderr', eof.stderr && evidence !== null);
      const envelope = await sink.finalize(
        evidence?.exitCode === 0 ? 'success' : 'error',
        [],
        evidence?.exitCode === 0
          ? undefined
          : {
              message:
                evidence?.exitSignal !== null
                  ? `Background Shell terminated with ${evidence?.exitSignal}.`
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
    return { unitName, evidence, captureError };
  }
}

function signalNumber(name: string | null): number | null {
  if (name === null) return null;
  const number = (constants.signals as Record<string, number>)[name];
  return typeof number === 'number' ? number : null;
}
