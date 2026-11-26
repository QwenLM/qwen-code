/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Inspector session creation is deferred until a heavy capture is requested,
// so the lightweight logging path stays free of node:inspector overhead.

import * as fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isRunningWithBun } from './bundledMode.js';
import { formatBytes } from './formatters.js';
import { getConfigHomeDir } from './paths.js';
import { runLogger } from './runLogger.js';

export type ProfileType = 'cpu' | 'heap-snapshot' | 'heap-allocation';

export interface ProfileResult {
  filePath: string;
  type: ProfileType;
  durationMs?: number;
  sizeBytes: number;
}

export interface RuntimeProfilerOptions {
  outputDir?: string;
  cpuSamplingInterval?: number;
  heapSamplingInterval?: number;
  lightweightLogIntervalMs?: number;
}

export interface LightweightProfileSample {
  reason: string;
  timestamp: string;
  runtime: 'bun' | 'node';
  pid: number;
  uptimeMs: number;
  intervalMs: number;
  elapsedMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuPercent: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes?: number;
  timerDelayMs?: number;
}

export const DEFAULT_PROFILE_LOG_INTERVAL_MS = 60_000;
export const MIN_PROFILE_LOG_INTERVAL_MS = 10_000;
export const BUN_CPU_PROFILING_UNSUPPORTED_MESSAGE =
  'CPU profiling is not supported under Bun because Bun does not implement node:inspector/promises. Use /profile snapshot for heap snapshots, or run with Node.js for V8 CPU profiles.';
const PROFILE_STREAM_CHUNK_SIZE = 1024 * 1024;

/** 流式 profile 加密器；超大 heap snapshot 按块加密写出。 */
export interface ProfileChunkEncryptor {
  /** 加密头部，写在大块数据之前。 */
  header(): Uint8Array;
  encryptChunk(data: Uint8Array, finalChunk: boolean): Uint8Array;
  free(): void;
}

/**
 * profile 落盘加密能力。实现（加密算法与密钥派生）属于产品侧，core 只声明
 * 接口，未注入时拒绝写出 profile 而不降级为明文。
 */
export interface ProfileEncryption {
  encrypt(data: Uint8Array): Promise<Uint8Array>;
  createChunkEncryptor(chunkSize: number): Promise<ProfileChunkEncryptor>;
}

let profileEncryption: ProfileEncryption | undefined;

export function setProfileEncryption(next: ProfileEncryption | undefined): void {
  profileEncryption = next;
}

function requireProfileEncryption(): ProfileEncryption {
  if (!profileEncryption) {
    throw new Error(
      '[runtime-profiler] Profile encryption is not configured; profile capture is unavailable.',
    );
  }
  return profileEncryption;
}

function bunGenerateHeapSnapshot(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Bun = (globalThis as any).Bun;
  if (!Bun?.generateHeapSnapshot) {
    throw new Error(
      '[runtime-profiler] Bun.generateHeapSnapshot is not available in this Bun version.',
    );
  }
  const snapshot = Bun.generateHeapSnapshot('v8');
  return typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot);
}

type InspectorSession = import('node:inspector/promises').Session;

interface PendingStoppedProfile {
  data: string | Buffer;
  durationMs: number;
}

let tempFileCounter = 0;
let sessionPromise: Promise<InspectorSession> | null = null;

async function getOrCreateSession(): Promise<InspectorSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        const { Session } = await import('node:inspector/promises');
        const session = new Session();
        session.connect();
        return session;
      } catch (err) {
        sessionPromise = null;
        throw new Error(
          `[runtime-profiler] Failed to create inspector session. ` +
            `This runtime may not support node:inspector/promises. ` +
            `Original error: ${err}`,
        );
      }
    })();
  }
  return sessionPromise;
}

export class RuntimeProfiler {
  private cpuProfilingActive = false;
  private cpuProfilingStartTime = 0;
  private pendingCpuProfile: PendingStoppedProfile | null = null;

  private heapAllocationProfilingActive = false;
  private heapAllocationProfilingStartTime = 0;
  private pendingHeapAllocationProfile: PendingStoppedProfile | null = null;

  private lightweightLogIntervalId: NodeJS.Timeout | null = null;
  private lightweightLogIntervalMs: number;
  private lastLightweightCpuUsage: NodeJS.CpuUsage | null = null;
  private lastLightweightSampleTime = 0;

  private readonly outputDir: string;
  private readonly cpuSamplingInterval: number;
  private readonly heapSamplingInterval: number;

  private outputDirPromise: Promise<void> | null = null;
  private heavyOperationQueue: Promise<void> = Promise.resolve();

  constructor(options?: RuntimeProfilerOptions) {
    const outputDir = options?.outputDir ?? getDefaultProfileDir();
    if (!path.isAbsolute(outputDir)) {
      throw new Error(
        `[runtime-profiler] Output directory must be an absolute path, got: ${outputDir}`,
      );
    }

    this.outputDir = outputDir;
    this.cpuSamplingInterval = options?.cpuSamplingInterval ?? 1000;
    this.heapSamplingInterval = options?.heapSamplingInterval ?? 524288;
    this.lightweightLogIntervalMs = normalizeProfileLogIntervalMs(
      options?.lightweightLogIntervalMs,
    );
  }

  getOutputDir(): string {
    return this.outputDir;
  }

  private ensureOutputDir(): Promise<void> {
    if (!this.outputDirPromise) {
      this.outputDirPromise = this.doEnsureOutputDir().catch((err) => {
        this.outputDirPromise = null;
        throw err;
      });
    }
    return this.outputDirPromise;
  }

  private async doEnsureOutputDir(): Promise<void> {
    await fs.mkdir(this.outputDir, { recursive: true, mode: 0o700 });

    const dirStat = await fs.lstat(this.outputDir);
    if (dirStat.isSymbolicLink()) {
      throw new Error(
        `[runtime-profiler] Refusing to write to symlinked output directory: ${this.outputDir}`,
      );
    }
  }

  private runHeavyOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.heavyOperationQueue.then(operation, operation);
    this.heavyOperationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  startLightweightLogging(intervalMs?: number): void {
    const nextIntervalMs = normalizeProfileLogIntervalMs(intervalMs);

    if (this.lightweightLogIntervalId) {
      if (nextIntervalMs === this.lightweightLogIntervalMs) {
        runLogger.warn(
          `[profile] Lightweight profile logging is already active (interval: ${this.lightweightLogIntervalMs}ms).`,
        );
        return;
      }

      this.stopLightweightLogging('reconfigure');
    }

    this.lightweightLogIntervalMs = nextIntervalMs;
    this.lastLightweightCpuUsage = null;
    this.lastLightweightSampleTime = 0;

    runLogger.log(
      `[profile] Lightweight profile logging started (interval: ${this.lightweightLogIntervalMs}ms). Heavy CPU/heap captures remain explicit-only.`,
    );
    this.recordLightweightSample('start');

    this.lightweightLogIntervalId = setInterval(() => {
      this.recordLightweightSample('periodic');
    }, this.lightweightLogIntervalMs);
    this.lightweightLogIntervalId.unref?.();
  }

  stopLightweightLogging(reason = 'stop'): void {
    if (!this.lightweightLogIntervalId) {
      return;
    }

    clearInterval(this.lightweightLogIntervalId);
    this.lightweightLogIntervalId = null;
    this.recordLightweightSample(reason);
    runLogger.log('[profile] Lightweight profile logging stopped.');
  }

  isLightweightLoggingActive(): boolean {
    return this.lightweightLogIntervalId !== null;
  }

  getLightweightLogIntervalMs(): number {
    return this.lightweightLogIntervalMs;
  }

  recordLightweightSample(reason = 'manual'): LightweightProfileSample {
    const sample = this.collectLightweightSample(reason);
    runLogger.log(formatLightweightProfileSample(sample));
    return sample;
  }

  private collectLightweightSample(reason: string): LightweightProfileSample {
    const now = Date.now();
    const cpuUsage = process.cpuUsage();
    const memoryUsage = process.memoryUsage();

    const previousCpuUsage = this.lastLightweightCpuUsage;
    const previousSampleTime = this.lastLightweightSampleTime;

    const elapsedMs =
      previousSampleTime > 0 ? Math.max(now - previousSampleTime, 1) : 0;
    const cpuUserMs = previousCpuUsage
      ? Math.max(cpuUsage.user - previousCpuUsage.user, 0) / 1000
      : 0;
    const cpuSystemMs = previousCpuUsage
      ? Math.max(cpuUsage.system - previousCpuUsage.system, 0) / 1000
      : 0;
    const cpuPercent =
      elapsedMs > 0 ? ((cpuUserMs + cpuSystemMs) / elapsedMs) * 100 : 0;
    const timerDelayMs =
      previousSampleTime > 0
        ? Math.max(now - previousSampleTime - this.lightweightLogIntervalMs, 0)
        : undefined;

    this.lastLightweightCpuUsage = cpuUsage;
    this.lastLightweightSampleTime = now;

    return {
      reason,
      timestamp: new Date(now).toISOString(),
      runtime: isRunningWithBun() ? 'bun' : 'node',
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      intervalMs: this.lightweightLogIntervalMs,
      elapsedMs,
      cpuUserMs,
      cpuSystemMs,
      cpuPercent,
      rssBytes: memoryUsage.rss,
      heapUsedBytes: memoryUsage.heapUsed,
      heapTotalBytes: memoryUsage.heapTotal,
      externalBytes: memoryUsage.external,
      arrayBuffersBytes: memoryUsage.arrayBuffers,
      timerDelayMs,
    };
  }

  private async writeProfileData(
    filePath: string,
    data: string | Buffer,
  ): Promise<number> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const input = toUint8ArrayView(buf);
    const encrypted = await requireProfileEncryption().encrypt(input);

    const tempPath = generateTempFilePath(filePath, 'enc');
    try {
      await fs.writeFile(tempPath, encrypted, { mode: 0o600, flush: true });
      await fs.rename(tempPath, filePath);
    } catch (err) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // ignore cleanup failure
      }
      throw err;
    }
    return encrypted.byteLength;
  }

  async startCpuProfiling(): Promise<void> {
    return this.runHeavyOperation(() => this.startCpuProfilingLocked());
  }

  private async startCpuProfilingLocked(): Promise<void> {
    if (this.cpuProfilingActive) {
      runLogger.warn(
        '[runtime-profiler] CPU profiling is already active, ignoring start request.',
      );
      return;
    }

    if (this.pendingCpuProfile) {
      throw new Error(
        '[runtime-profiler] A stopped CPU profile is pending save. Run /profile cpu stop to retry saving it before starting a new CPU profile.',
      );
    }

    if (isRunningWithBun()) {
      throw new Error(
        `[runtime-profiler] ${BUN_CPU_PROFILING_UNSUPPORTED_MESSAGE}`,
      );
    }

    try {
      const session = await getOrCreateSession();
      await session.post('Profiler.enable');
      try {
        await session.post('Profiler.setSamplingInterval', {
          interval: this.cpuSamplingInterval,
        });
        await session.post('Profiler.start');
      } catch (err) {
        try {
          await session.post('Profiler.disable');
        } catch {
          // Ignore: best-effort cleanup after a failed start.
        }
        throw err;
      }
      this.cpuProfilingActive = true;
      this.cpuProfilingStartTime = Date.now();
      runLogger.log(
        `[runtime-profiler] CPU profiling started (sampling interval: ${this.cpuSamplingInterval}us)`,
      );
    } catch (err) {
      runLogger.error(`[runtime-profiler] Failed to start CPU profiling: ${err}`);
      throw err;
    }
  }

  async stopCpuProfiling(): Promise<ProfileResult> {
    return this.runHeavyOperation(() => this.stopCpuProfilingLocked());
  }

  private async stopCpuProfilingLocked(): Promise<ProfileResult> {
    if (this.pendingCpuProfile) {
      return this.persistPendingCpuProfile();
    }

    if (!this.cpuProfilingActive) {
      throw new Error('[runtime-profiler] CPU profiling is not active.');
    }

    try {
      const session = await getOrCreateSession();
      const { profile } = await session.post('Profiler.stop');
      const durationMs = Date.now() - this.cpuProfilingStartTime;
      this.cpuProfilingActive = false;
      this.cpuProfilingStartTime = 0;
      this.pendingCpuProfile = {
        data: JSON.stringify(profile),
        durationMs,
      };

      try {
        await session.post('Profiler.disable');
      } catch (err) {
        runLogger.warn(
          `[runtime-profiler] Failed to disable CPU profiler after stop: ${err}`,
        );
      }

      return await this.persistPendingCpuProfile();
    } catch (err) {
      runLogger.error(`[runtime-profiler] Failed to stop CPU profiling: ${err}`);
      throw err;
    }
  }

  private async persistPendingCpuProfile(): Promise<ProfileResult> {
    const pendingProfile = this.pendingCpuProfile;
    if (!pendingProfile) {
      throw new Error('[runtime-profiler] No pending CPU profile to save.');
    }

    await this.ensureOutputDir();
    const filePath = path.join(
      this.outputDir,
      generateFileName('cpu', 'cpuprofile.enc'),
    );
    const sizeBytes = await this.writeProfileData(filePath, pendingProfile.data);
    this.pendingCpuProfile = null;

    runLogger.log(
      `[runtime-profiler] Encrypted CPU profile saved: ${filePath} (${pendingProfile.durationMs}ms, ${formatBytes(sizeBytes)})`,
    );

    return {
      filePath,
      type: 'cpu',
      durationMs: pendingProfile.durationMs,
      sizeBytes,
    };
  }

  async takeHeapSnapshot(): Promise<ProfileResult> {
    return this.runHeavyOperation(() => this.takeHeapSnapshotLocked());
  }

  private async takeHeapSnapshotLocked(): Promise<ProfileResult> {
    if (isRunningWithBun()) {
      return this.takeHeapSnapshotBun();
    }
    return this.takeHeapSnapshotV8();
  }

  private async takeHeapSnapshotBun(): Promise<ProfileResult> {
    try {
      const snapshotJson = bunGenerateHeapSnapshot();
      return await this.persistHeapSnapshot(snapshotJson, 'heap-bun');
    } catch (err) {
      runLogger.error(
        `[runtime-profiler] Failed to take heap snapshot (Bun): ${err}`,
      );
      throw err;
    }
  }

  private async takeHeapSnapshotV8(): Promise<ProfileResult> {
    await this.ensureOutputDir();
    const filePath = path.join(
      this.outputDir,
      generateFileName('heap', 'heapsnapshot.enc'),
    );
    const tempPath = generateTempFilePath(filePath, 'enc');
    const encryptor = await requireProfileEncryption().createChunkEncryptor(
      PROFILE_STREAM_CHUNK_SIZE,
    );
    let outputFd: number | null = null;
    let encryptedSize = 0;
    let pendingChunk: Buffer | null = null;
    let chunkWriteError: unknown;
    let renamed = false;

    const writePlaintextChunk = (
      data: Uint8Array,
      finalChunk: boolean,
    ): void => {
      if (outputFd === null) {
        throw new Error('[runtime-profiler] Heap snapshot output file is not open.');
      }

      const writeSlice = (slice: Uint8Array, isFinal: boolean): void => {
        const encrypted = encryptor.encryptChunk(slice, isFinal);
        writeAllSync(outputFd!, encrypted);
        encryptedSize += encrypted.byteLength;
      };

      if (data.byteLength === 0) {
        writeSlice(data, finalChunk);
        return;
      }

      for (let offset = 0; offset < data.byteLength; ) {
        const end = Math.min(offset + PROFILE_STREAM_CHUNK_SIZE, data.byteLength);
        const isLastSlice = end === data.byteLength;
        writeSlice(data.subarray(offset, end), finalChunk && isLastSlice);
        offset = end;
      }
    };

    const flushPendingChunk = (finalChunk: boolean): void => {
      if (pendingChunk) {
        writePlaintextChunk(toUint8ArrayView(pendingChunk), finalChunk);
        pendingChunk = null;
        return;
      }

      if (finalChunk) {
        writePlaintextChunk(new Uint8Array(), true);
      }
    };

    try {
      const session = await getOrCreateSession();
      outputFd = fsSync.openSync(tempPath, 'wx', 0o600);
      const header = encryptor.header();
      writeAllSync(outputFd, header);
      encryptedSize += header.byteLength;

      const onChunk = (
        message: import('node:inspector').InspectorNotification<{
          chunk: string;
        }>,
      ): void => {
        if (chunkWriteError || outputFd === null) {
          return;
        }

        try {
          flushPendingChunk(false);
          pendingChunk = Buffer.from(message.params.chunk, 'utf-8');
        } catch (err) {
          chunkWriteError = err;
        }
      };

      session.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
      try {
        await session.post('HeapProfiler.takeHeapSnapshot', {
          reportProgress: false,
        });
      } finally {
        session.removeListener('HeapProfiler.addHeapSnapshotChunk', onChunk);
      }

      if (chunkWriteError) {
        throw chunkWriteError;
      }

      flushPendingChunk(true);
      fsSync.fsyncSync(outputFd);
      fsSync.closeSync(outputFd);
      outputFd = null;
      await fs.rename(tempPath, filePath);
      renamed = true;

      runLogger.log(
        `[runtime-profiler] Encrypted heap snapshot saved: ${filePath} (${formatBytes(encryptedSize)})`,
      );

      return { filePath, type: 'heap-snapshot', sizeBytes: encryptedSize };
    } catch (err) {
      runLogger.error(`[runtime-profiler] Failed to take heap snapshot: ${err}`);
      throw err;
    } finally {
      if (outputFd !== null) {
        try {
          fsSync.closeSync(outputFd);
        } catch {
          // Ignore cleanup failure.
        }
      }

      if (!renamed) {
        try {
          await fs.unlink(tempPath);
        } catch {
          // Ignore cleanup failure.
        }
      }

      encryptor.free();
    }
  }

  private async persistHeapSnapshot(
    data: string | Buffer,
    filePrefix: string,
  ): Promise<ProfileResult> {
    await this.ensureOutputDir();
    const filePath = path.join(
      this.outputDir,
      generateFileName(filePrefix, 'heapsnapshot.enc'),
    );
    const sizeBytes = await this.writeProfileData(filePath, data);

    runLogger.log(
      `[runtime-profiler] Encrypted heap snapshot saved: ${filePath} (${formatBytes(sizeBytes)})`,
    );

    return { filePath, type: 'heap-snapshot', sizeBytes };
  }

  async startHeapAllocationProfiling(): Promise<void> {
    return this.runHeavyOperation(() =>
      this.startHeapAllocationProfilingLocked(),
    );
  }

  private async startHeapAllocationProfilingLocked(): Promise<void> {
    if (isRunningWithBun()) {
      throw new Error(
        '[runtime-profiler] Heap allocation profiling is not supported under Bun. ' +
          'Use /profile snapshot for a heap snapshot instead, or run with Node.js.',
      );
    }

    if (this.heapAllocationProfilingActive) {
      runLogger.warn(
        '[runtime-profiler] Heap allocation profiling is already active, ignoring start request.',
      );
      return;
    }

    if (this.pendingHeapAllocationProfile) {
      throw new Error(
        '[runtime-profiler] A stopped heap allocation profile is pending save. Run /profile heap-alloc stop to retry saving it before starting a new heap allocation profile.',
      );
    }

    try {
      const session = await getOrCreateSession();
      await session.post('HeapProfiler.enable');
      try {
        await session.post('HeapProfiler.startSampling', {
          samplingInterval: this.heapSamplingInterval,
        });
      } catch (err) {
        try {
          await session.post('HeapProfiler.disable');
        } catch {
          // Ignore: best-effort cleanup after a failed start.
        }
        throw err;
      }
      this.heapAllocationProfilingActive = true;
      this.heapAllocationProfilingStartTime = Date.now();
      runLogger.log(
        `[runtime-profiler] Heap allocation profiling started (sampling interval: ${formatBytes(this.heapSamplingInterval)})`,
      );
    } catch (err) {
      runLogger.error(
        `[runtime-profiler] Failed to start heap allocation profiling: ${err}`,
      );
      throw err;
    }
  }

  async stopHeapAllocationProfiling(): Promise<ProfileResult> {
    return this.runHeavyOperation(() =>
      this.stopHeapAllocationProfilingLocked(),
    );
  }

  private async stopHeapAllocationProfilingLocked(): Promise<ProfileResult> {
    if (this.pendingHeapAllocationProfile) {
      return this.persistPendingHeapAllocationProfile();
    }

    if (!this.heapAllocationProfilingActive) {
      throw new Error('[runtime-profiler] Heap allocation profiling is not active.');
    }

    try {
      const session = await getOrCreateSession();
      const { profile } = await session.post('HeapProfiler.stopSampling');
      const durationMs = Date.now() - this.heapAllocationProfilingStartTime;
      this.heapAllocationProfilingActive = false;
      this.heapAllocationProfilingStartTime = 0;
      this.pendingHeapAllocationProfile = {
        data: JSON.stringify(profile),
        durationMs,
      };

      try {
        await session.post('HeapProfiler.disable');
      } catch (err) {
        runLogger.warn(
          `[runtime-profiler] Failed to disable heap allocation profiler after stop: ${err}`,
        );
      }

      return await this.persistPendingHeapAllocationProfile();
    } catch (err) {
      runLogger.error(
        `[runtime-profiler] Failed to stop heap allocation profiling: ${err}`,
      );
      throw err;
    }
  }

  private async persistPendingHeapAllocationProfile(): Promise<ProfileResult> {
    const pendingProfile = this.pendingHeapAllocationProfile;
    if (!pendingProfile) {
      throw new Error(
        '[runtime-profiler] No pending heap allocation profile to save.',
      );
    }

    await this.ensureOutputDir();
    const filePath = path.join(
      this.outputDir,
      generateFileName('heap-alloc', 'heapprofile.enc'),
    );
    const sizeBytes = await this.writeProfileData(filePath, pendingProfile.data);
    this.pendingHeapAllocationProfile = null;

    runLogger.log(
      `[runtime-profiler] Encrypted heap allocation profile saved: ${filePath} (${pendingProfile.durationMs}ms, ${formatBytes(sizeBytes)})`,
    );

    return {
      filePath,
      type: 'heap-allocation',
      durationMs: pendingProfile.durationMs,
      sizeBytes,
    };
  }

  isCpuProfilingActive(): boolean {
    return this.cpuProfilingActive;
  }

  hasPendingCpuProfile(): boolean {
    return this.pendingCpuProfile !== null;
  }

  isHeapAllocationProfilingActive(): boolean {
    return this.heapAllocationProfilingActive;
  }

  hasPendingHeapAllocationProfile(): boolean {
    return this.pendingHeapAllocationProfile !== null;
  }

  async dispose(): Promise<ProfileResult[]> {
    const results: ProfileResult[] = [];

    this.stopLightweightLogging('dispose');

    if (this.cpuProfilingActive || this.pendingCpuProfile) {
      try {
        results.push(await this.stopCpuProfiling());
      } catch (err) {
        runLogger.error(
          `[runtime-profiler] Error stopping CPU profiling during dispose: ${err}`,
        );
      }
    }

    if (this.heapAllocationProfilingActive || this.pendingHeapAllocationProfile) {
      try {
        results.push(await this.stopHeapAllocationProfiling());
      } catch (err) {
        runLogger.error(
          `[runtime-profiler] Error stopping heap allocation profiling during dispose: ${err}`,
        );
      }
    }

    if (sessionPromise) {
      try {
        const session = await sessionPromise;
        session.disconnect();
      } catch {
        // Ignore disconnect errors.
      }
      sessionPromise = null;
    }

    return results;
  }
}

let globalProfiler: RuntimeProfiler | null = null;

export function initializeRuntimeProfiler(options?: RuntimeProfilerOptions): RuntimeProfiler {
  if (!globalProfiler) {
    globalProfiler = new RuntimeProfiler(options);
  }
  return globalProfiler;
}

export function getRuntimeProfiler(): RuntimeProfiler | null {
  return globalProfiler;
}

export function getOrInitRuntimeProfiler(): RuntimeProfiler {
  return globalProfiler ?? initializeRuntimeProfiler();
}

export function _resetRuntimeProfiler(): void {
  globalProfiler?.stopLightweightLogging('reset');
  globalProfiler = null;
  sessionPromise = null;
}

function getDefaultProfileDir(): string {
  return path.join(getConfigHomeDir(), 'logs', 'profile');
}

function generateFileName(type: string, ext: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '');
  return `${type}-${timestamp}-${process.pid}.${ext}`;
}

function generateTempFilePath(filePath: string, kind: string): string {
  ++tempFileCounter;
  return `${filePath}.${kind}.tmp.${process.pid}.${Date.now()}.${tempFileCounter}`;
}

function toUint8ArrayView(data: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function writeAllSync(fd: number, data: Uint8Array): number {
  let totalWritten = 0;

  while (totalWritten < data.byteLength) {
    const bytesWritten = fsSync.writeSync(
      fd,
      data,
      totalWritten,
      data.byteLength - totalWritten,
      null,
    );

    if (bytesWritten === 0) {
      throw new Error('[runtime-profiler] Failed to write encrypted profile data.');
    }

    totalWritten += bytesWritten;
  }

  return totalWritten;
}

export function parseProfileLogIntervalMs(value?: string | number): number {
  if (typeof value === 'number') {
    return normalizeProfileLogIntervalMs(value);
  }

  const raw = value?.trim();
  if (!raw) {
    return DEFAULT_PROFILE_LOG_INTERVAL_MS;
  }

  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) {
    throw new Error(
      `[profile] Invalid lightweight log interval: ${value}. Use milliseconds, "30s", or "1m".`,
    );
  }

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? 'ms';
  const UNIT_MS: Record<string, number> = { m: 60_000, s: 1000, ms: 1 };
  return normalizeProfileLogIntervalMs(amount * UNIT_MS[unit]);
}

function normalizeProfileLogIntervalMs(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_PROFILE_LOG_INTERVAL_MS;
  }

  return Math.max(MIN_PROFILE_LOG_INTERVAL_MS, Math.round(value));
}

export function formatLightweightProfileSample(
  sample: LightweightProfileSample,
): string {
  const timerDelay =
    sample.timerDelayMs === undefined
      ? ''
      : ` timer_delay=${Math.round(sample.timerDelayMs)}ms`;
  const arrayBuffers =
    sample.arrayBuffersBytes === undefined
      ? ''
      : ` array_buffers=${formatBytes(sample.arrayBuffersBytes)}`;

  return (
    `[profile] sample reason=${sample.reason}` +
    ` runtime=${sample.runtime}` +
    ` pid=${sample.pid}` +
    ` uptime=${sample.uptimeMs}ms` +
    ` interval=${sample.intervalMs}ms` +
    ` elapsed=${sample.elapsedMs}ms` +
    ` cpu=${sample.cpuPercent.toFixed(1)}%` +
    ` cpu_user=${sample.cpuUserMs.toFixed(1)}ms` +
    ` cpu_system=${sample.cpuSystemMs.toFixed(1)}ms` +
    ` rss=${formatBytes(sample.rssBytes)}` +
    ` heap_used=${formatBytes(sample.heapUsedBytes)}` +
    ` heap_total=${formatBytes(sample.heapTotalBytes)}` +
    ` external=${formatBytes(sample.externalBytes)}` +
    arrayBuffers +
    timerDelay
  );
}
