/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type ResumeReadLimits = {
  readonly maxLineBytes: number;
  readonly maxRetainedBytes: number;
  readonly maxRetainedEntries: number;
  readonly maxStructureBytes: number;
  readonly maxStructureEntries: number;
  readonly maxMetadataBytes: number;
  readonly maxNestedItemsPerEntry: number;
  readonly maxNestedItems: number;
  readonly maxDepth: number;
  readonly maxReadBytes: number;
  readonly timeoutMs: number;
};

/**
 * Persisted transcripts have no size, count, depth or duration ceiling. Normal
 * restores rely on streaming reads and compact-tail projection, not rejection
 * of previously readable history. Finite limits remain opt-in for callers
 * that explicitly need them; admission, cancellation and snapshot checks are
 * independent of these limits.
 */
export const DEFAULT_RESUME_READ_LIMITS: ResumeReadLimits = Object.freeze({
  maxLineBytes: Infinity,
  maxRetainedBytes: Infinity,
  maxRetainedEntries: Infinity,
  maxStructureBytes: Infinity,
  maxStructureEntries: Infinity,
  maxMetadataBytes: Infinity,
  maxNestedItemsPerEntry: Infinity,
  maxNestedItems: Infinity,
  maxDepth: Infinity,
  maxReadBytes: Infinity,
  timeoutMs: Infinity,
});

/** Returns Infinity if the entry exceeds a limit. The text budget can reject an entry before serialization. */
export function countResumeEntryItems(
  value: unknown,
  limits: Pick<ResumeReadLimits, 'maxDepth' | 'maxNestedItemsPerEntry'>,
  {check, maxTextChars = Infinity}: { check?: () => void; maxTextChars?: number } = {},
): number {
  let stringBudget = maxTextChars;
  const stack: Array<{ value: unknown; depth: number }> = [
    { value, depth: 1 },
  ];
  let count = 0;
  const addChild = (child: unknown, depth: number) => {
    ++count;
    if (typeof child === 'string') stringBudget -= child.length;
    if ((count & 255) === 0) check?.();
    if (child !== null && typeof child === 'object')
      stack.push({ value: child, depth });
  };
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.value === null || typeof current.value !== 'object') continue;
    if (current.depth > limits.maxDepth) return Infinity;
    if (Array.isArray(current.value)) {
      if (current.value.length > limits.maxNestedItemsPerEntry - count)
        return Infinity;
      for (let index = 0; index < current.value.length; index++) {
        addChild(current.value[index], current.depth + 1);
      }
    } else {
      const record = current.value as Record<string, unknown>;
      for (const key in record) {
        if (Object.hasOwn(record, key)) {
          stringBudget -= key.length;
          if (count >= limits.maxNestedItemsPerEntry || stringBudget < 0) return Infinity;
          addChild(record[key], current.depth + 1);
        }
      }
    }
  }
  return stringBudget < 0 ? Infinity : count;
}

export type ResumeReadErrorReason =
  | 'budget'
  | 'snapshot'
  | 'conflict'
  | 'cancelled'
  | 'timeout'
  | 'busy'
  | 'unsafe';

export class ResumeReadError extends Error {
  readonly code: string;
  readonly reason: ResumeReadErrorReason;

  constructor(reason: ResumeReadErrorReason) {
    // reason/code 是稳定契约；对外日志把 budget 明确写成 budget-over-limit，
    // 与“结构不安全”区分开。
    const label = reason === 'budget' ? 'budget-over-limit' : reason;
    super(`Transcript resume failed: ${label}.`);
    this.name = 'ResumeReadError';
    this.reason = reason;
    this.code = `RESUME_READ_${reason.toUpperCase()}`;
  }
}

export function isResumeReadError(value: unknown): value is ResumeReadError {
  return value instanceof ResumeReadError;
}

export interface ResumeReadStats {
  readonly bytesRead: number;
  readonly retainedBytes: number;
  readonly retainedEntries: number;
  readonly nestedItems: number;
  readonly metadataBytes: number;
  readonly metadataEntries: number;
  readonly structureBytes: number;
  readonly structureEntries: number;
  readonly snapshotRetries: number;
}

export interface ResumeReadAttempt {
  readonly signal: AbortSignal;
  readonly limits: ResumeReadLimits;
  readonly stats: ResumeReadStats;
  check(): void;
  addReadBytes(n: number): void;
  checkLineBytes(n: number): void;
  validateValue(value: unknown): number;
  retain(bytes: number, nestedItems?: number, metadata?: boolean): void;
  resetRetained(): void;
  addStructure(bytes: number, entries?: number): void;
  resetStructure(): void;
  retrySnapshot(): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
  /** 是否有外层 run() 仍在执行；用于避免嵌套持有者提前释放共享名额。 */
  hasActiveRun(): boolean;
  finish(): void;
}

let activeAttempt: ManagedResumeReadAttempt | undefined;
const waitingAttempts: ManagedResumeReadAttempt[] = [];
const MAX_WAITING_ATTEMPTS = 8;

export async function beginResumeRead(
  options: { signal?: AbortSignal; limits?: Partial<ResumeReadLimits> } = {},
): Promise<ResumeReadAttempt> {
  const startedAt = performance.now();
  if (options.signal?.aborted) throw new ResumeReadError('cancelled');
  const limits = Object.freeze({
    ...DEFAULT_RESUME_READ_LIMITS,
    ...options.limits,
  });
  for (const value of Object.values(limits)) {
    if (value !== Infinity && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ResumeReadError('unsafe');
    }
  }
  if (activeAttempt && waitingAttempts.length >= MAX_WAITING_ATTEMPTS) {
    throw new ResumeReadError('busy');
  }
  const attempt = await new Promise<ManagedResumeReadAttempt>(
    (resolve, reject) => {
      const candidate = new ManagedResumeReadAttempt(
        limits,
        startedAt,
        options.signal,
        resolve,
        reject,
      );
      if (activeAttempt) waitingAttempts.push(candidate);
      else activeAttempt = candidate;
      candidate.start();
      if (activeAttempt === candidate) candidate.admit();
    },
  );
  attempt.check();
  return attempt;
}

function releaseAttempt(attempt: ManagedResumeReadAttempt): void {
  const index = waitingAttempts.indexOf(attempt);
  if (index >= 0) waitingAttempts.splice(index, 1);
  if (activeAttempt !== attempt) return;
  activeAttempt = waitingAttempts.shift();
  activeAttempt?.admit();
}

class ManagedResumeReadAttempt implements ResumeReadAttempt {
  private readonly abortController = new AbortController();
  readonly signal = this.abortController.signal;
  private readonly deadline: number;
  private timer?: ReturnType<typeof setTimeout>;
  private terminalError?: ResumeReadError;
  private finished = false;
  private released = false;
  private running = 0;
  private counters = {
    bytesRead: 0,
    retainedBytes: 0,
    retainedEntries: 0,
    nestedItems: 0,
    metadataBytes: 0,
    metadataEntries: 0,
    structureBytes: 0,
    structureEntries: 0,
    snapshotRetries: 0,
  };
  private readonly onAbort = () => this.stop(new ResumeReadError('cancelled'));

  constructor(
    readonly limits: ResumeReadLimits,
    startedAt: number,
    private readonly externalSignal: AbortSignal | undefined,
    private readonly resolveAdmission: (
      attempt: ManagedResumeReadAttempt,
    ) => void,
    private readonly rejectAdmission: (error: ResumeReadError) => void,
  ) {
    this.deadline = startedAt + limits.timeoutMs;
  }

  get stats(): ResumeReadStats {
    return Object.freeze({ ...this.counters });
  }

  start(): void {
    this.externalSignal?.addEventListener('abort', this.onAbort, {
      once: true,
    });
    if (this.externalSignal?.aborted) {
      this.onAbort();
      return;
    }
    // setTimeout(Infinity) overflows to a short timer; unlimited reads must
    // retain their cancellation listener without scheduling any deadline.
    if (this.deadline === Infinity) return;
    const remaining = this.deadline - performance.now();
    if (remaining <= 0) {
      this.stop(new ResumeReadError('timeout'));
      return;
    }
    this.timer = setTimeout(
      () => this.stop(new ResumeReadError('timeout')),
      remaining,
    );
    this.timer.unref();
  }

  admit(): void {
    try {
      this.check();
      this.resolveAdmission(this);
    } catch {
      // check 已完成终态和队列清理，排队 Promise 由 finish 拒绝。
    }
  }

  check(): void {
    if (this.terminalError) throw this.terminalError;
    if (performance.now() >= this.deadline) this.fail('timeout');
  }

  private stop(error: ResumeReadError): void {
    this.terminalError ??= error;
    this.finish();
  }

  private fail(reason: ResumeReadErrorReason): never {
    this.stop(new ResumeReadError(reason));
    throw this.terminalError;
  }

  private checkAddition(current: number, delta: number, limit: number): void {
    if (delta > limit - current) this.fail('budget');
  }

  addReadBytes(n: number): void {
    this.check();
    this.checkAddition(this.counters.bytesRead, n, this.limits.maxReadBytes);
    this.counters.bytesRead += n;
  }

  checkLineBytes(n: number): void {
    this.check();
    this.checkAddition(0, n, this.limits.maxLineBytes);
  }

  validateValue(value: unknown): number {
    this.check();
    const count = countResumeEntryItems(value, this.limits, { check: () => this.check() });
    if (!Number.isFinite(count)) this.fail('budget');
    this.check();
    return count;
  }

  retain(bytes: number, nestedItems = 0, metadata = false): void {
    this.check();
    this.checkAddition(
      this.counters.retainedBytes,
      bytes,
      this.limits.maxRetainedBytes,
    );
    this.checkAddition(
      this.counters.retainedEntries,
      1,
      this.limits.maxRetainedEntries,
    );
    this.checkAddition(0, nestedItems, this.limits.maxNestedItemsPerEntry);
    this.checkAddition(
      this.counters.nestedItems,
      nestedItems,
      this.limits.maxNestedItems,
    );
    if (metadata) {
      this.checkAddition(
        this.counters.metadataBytes,
        bytes,
        this.limits.maxMetadataBytes,
      );
    }
    this.counters.retainedBytes += bytes;
    this.counters.retainedEntries++;
    this.counters.nestedItems += nestedItems;
    if (metadata) {
      this.counters.metadataBytes += bytes;
      this.counters.metadataEntries++;
    }
  }

  resetRetained(): void {
    this.counters.retainedBytes = 0;
    this.counters.retainedEntries = 0;
    this.counters.nestedItems = 0;
    this.counters.metadataBytes = 0;
    this.counters.metadataEntries = 0;
  }

  addStructure(bytes: number, entries = 1): void {
    this.check();
    this.checkAddition(
      this.counters.structureBytes,
      bytes,
      this.limits.maxStructureBytes,
    );
    this.checkAddition(
      this.counters.structureEntries,
      entries,
      this.limits.maxStructureEntries,
    );
    this.counters.structureBytes += bytes;
    this.counters.structureEntries += entries;
  }

  resetStructure(): void {
    this.counters.structureBytes = 0;
    this.counters.structureEntries = 0;
  }

  retrySnapshot(): void {
    this.check();
    if (this.counters.snapshotRetries >= 1) this.fail('snapshot');
    this.counters.snapshotRetries++;
  }

  /**
   * 允许嵌套调用：running 计数保证只有所有外层都退出且已 finish 时才归还准入，
   * 内层不能提前释放外层仍在使用的共享名额。
   */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    this.running++;
    try {
      const result = await operation();
      this.check();
      return result;
    } catch (error) {
      if (!this.terminalError && performance.now() >= this.deadline) {
        this.stop(new ResumeReadError('timeout'));
      }
      const failure = this.terminalError ?? error;
      // 非恢复错误不改写终态：交给持有方 finally 释放，否则嵌套 run 会把真实
      // I/O / 投影错误覆盖成 cancelled，并让共享 attempt 的其余候选无法继续。
      if (isResumeReadError(failure)) this.stop(failure);
      throw failure;
    } finally {
      this.running--;
      this.releaseIfStopped();
    }
  }

  hasActiveRun(): boolean {
    return this.running > 0;
  }

  finish(): void {
    if (!this.finished) {
      this.finished = true;
      this.terminalError ??= new ResumeReadError('cancelled');
      clearTimeout(this.timer);
      this.timer = undefined;
      this.externalSignal?.removeEventListener('abort', this.onAbort);
      this.abortController.abort(this.terminalError);
      this.rejectAdmission(this.terminalError);
    }
    this.releaseIfStopped();
  }

  private releaseIfStopped(): void {
    // 取消只标记终态；仍在排空的读取必须先进入 finally，避免新旧扫描并行。
    if (!this.finished || this.running > 0 || this.released) return;
    this.released = true;
    releaseAttempt(this);
  }
}
