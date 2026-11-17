/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryConfig,
  type MemoryConnection,
  type MemoryLogger,
  validateMemoryBaseUrl,
} from './config.js';
import type { StoredVector } from './store.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeVector(
  values: readonly number[],
): Float32Array | null {
  if (
    !values.length ||
    values.length > 65536 ||
    values.some((value) => !Number.isFinite(value))
  )
    return null;
  const norm = Math.sqrt(
    values.reduce((total, value) => total + value * value, 0),
  );
  if (!Number.isFinite(norm) || norm <= 0) return null;
  return Float32Array.from(values, (value) => value / norm);
}

export class EmbeddingClient {
  readonly model: string;
  readonly minSim: number;
  readonly vecLimit: number;
  private readonly config: MemoryConfig['retrieve'];
  private readonly connection: MemoryConnection;
  private readonly log: MemoryLogger;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly cache = new Map<string, Float32Array>();
  private readonly pending = new Set<AbortController>();
  private closed = false;
  private warmup?: Promise<void>;

  constructor(options: {
    config?: MemoryConfig['retrieve'];
    connection: MemoryConnection;
    log?: MemoryLogger;
    fetch?: typeof globalThis.fetch;
  }) {
    this.config = options.config ?? DEFAULT_MEMORY_CONFIG.retrieve;
    this.model = this.config.model;
    this.minSim = this.config.minSim;
    this.vecLimit = this.config.vecLimit;
    this.connection = { ...options.connection };
    if (this.connection.baseUrl)
      this.connection.baseUrl = validateMemoryBaseUrl(this.connection.baseUrl);
    this.log = options.log ?? (() => {});
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  get available(): boolean {
    return (
      !this.closed &&
      this.config.useVector &&
      Boolean(this.connection.apiKey && this.connection.baseUrl)
    );
  }

  get unavailableReason(): string {
    if (this.closed) return 'closed';
    if (!this.config.useVector) return 'disabled';
    if (!this.connection.apiKey) return 'missing_api_key';
    if (!this.connection.baseUrl) return 'missing_endpoint';
    return '';
  }

  async embedQuery(text: string): Promise<Float32Array | null> {
    const key = text.replace(/\s+/gu, ' ').trim();
    if (!key || !this.available) return null;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      this.log('memory.embed.cache_hit');
      return cached;
    }
    const vector = (await this.request([key], this.config.timeoutMs))?.[0];
    if (!vector || this.closed) return null;
    this.cache.set(key, vector);
    while (this.cache.size > this.config.cacheSize)
      this.cache.delete(this.cache.keys().next().value!);
    return vector;
  }

  async embedDocuments(
    texts: readonly string[],
  ): Promise<Array<Float32Array | null>> {
    if (!this.available || !texts.length) return texts.map(() => null);
    const cleaned = texts.map((text) => text.replace(/\s+/gu, ' ').trim());
    const result: Array<Float32Array | null> = texts.map(() => null);
    const nonempty = cleaned.flatMap((text, index) =>
      text ? [{ text, index }] : [],
    );
    // DashScope accepts at most ten texts in one embeddings request.
    for (let start = 0; start < nonempty.length && !this.closed; start += 10) {
      const batch = nonempty.slice(start, start + 10);
      const vectors = await this.request(
        batch.map((entry) => entry.text),
        this.config.backfillTimeoutMs,
      );
      if (vectors)
        batch.forEach((entry, index) => {
          result[entry.index] = vectors[index] ?? null;
        });
    }
    return result;
  }

  warmUp(): Promise<void> {
    if (!this.available) return Promise.resolve();
    this.warmup ??= this.request(['预热'], this.config.backfillTimeoutMs).then(
      () => {},
    );
    return this.warmup;
  }

  private async request(
    texts: string[],
    timeoutMs: number,
  ): Promise<Float32Array[] | null> {
    if (!this.available) return null;
    const controller = new AbortController();
    this.pending.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    let abortHandler: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      abortHandler = () => reject(new Error('Memory embedding cancelled'));
      controller.signal.addEventListener('abort', abortHandler, { once: true });
    });
    try {
      const response = await Promise.race([
        this.fetcher(`${this.connection.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.connection.apiKey}`,
          },
          body: JSON.stringify({ model: this.model, input: texts }),
          signal: controller.signal,
        }),
        aborted,
      ]);
      if (!response.ok) {
        this.log('memory.embed.failed', { status: response.status });
        return null;
      }
      const data: unknown = await Promise.race([response.json(), aborted]);
      if (
        !isRecord(data) ||
        !Array.isArray(data['data']) ||
        data['data'].length !== texts.length
      ) {
        this.log('memory.embed.failed', { reason: 'invalid_response' });
        return null;
      }
      const vectors: Array<Float32Array | undefined> = Array.from({
        length: texts.length,
      });
      for (const item of data['data']) {
        if (
          !isRecord(item) ||
          !Number.isInteger(item['index']) ||
          typeof item['index'] !== 'number' ||
          item['index'] < 0 ||
          item['index'] >= texts.length ||
          vectors[item['index']] ||
          !Array.isArray(item['embedding']) ||
          !item['embedding'].every((value) => typeof value === 'number')
        )
          return null;
        const vector = normalizeVector(item['embedding'] as number[]);
        if (!vector) return null;
        vectors[item['index']] = vector;
      }
      if (this.closed || controller.signal.aborted) return null;
      return vectors as Float32Array[];
    } catch {
      if (!this.closed)
        this.log(
          controller.signal.aborted
            ? 'memory.embed.timeout'
            : 'memory.embed.failed',
          { count: texts.length },
        );
      return null;
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abortHandler);
      this.pending.delete(controller);
    }
  }

  close(): void {
    this.closed = true;
    for (const controller of this.pending) controller.abort();
    this.cache.clear();
  }
}

export function searchVectors(
  vectors: readonly StoredVector[],
  query: Float32Array,
  minSim: number,
  limit: number,
): Array<{ refId: number; similarity: number }> {
  return vectors
    .flatMap(({ refId, vector }) => {
      if (vector.length !== query.length) return [];
      let similarity = 0;
      for (let index = 0; index < query.length; index++)
        similarity += query[index]! * vector[index]!;
      return Number.isFinite(similarity) && similarity >= minSim
        ? [{ refId, similarity }]
        : [];
    })
    .sort(
      (left, right) =>
        right.similarity - left.similarity || left.refId - right.refId,
    )
    .slice(0, Math.max(1, limit));
}

export class EmbeddingBackfiller {
  private readonly queue: Array<{ id: number; text: string }> = [];
  private readonly queued = new Set<number>();
  private running?: Promise<void>;
  private closed = false;

  constructor(
    private readonly client: EmbeddingClient,
    private readonly write: (
      id: number,
      vector: Float32Array,
      model: string,
    ) => void,
    private readonly log: MemoryLogger = () => {},
    private readonly maxQueue = 4096,
  ) {}

  enqueue(id: number, text: string): boolean {
    if (this.closed || !this.client.available || this.queued.has(id))
      return false;
    if (this.queue.length >= this.maxQueue) {
      this.log('memory.embed.missing', { reason: 'queue_full' });
      return false;
    }
    this.queue.push({ id, text });
    this.queued.add(id);
    this.running ??= this.run();
    return true;
  }

  private async run(): Promise<void> {
    while (this.queue.length && !this.closed) {
      const entry = this.queue.shift()!;
      try {
        const vector = (await this.client.embedDocuments([entry.text]))[0];
        if (vector && !this.closed)
          this.write(entry.id, vector, this.client.model);
        else if (!this.closed)
          this.log('memory.embed.missing', { segmentId: entry.id });
      } catch {
        this.log('memory.embed.failed', { segmentId: entry.id });
      } finally {
        this.queued.delete(entry.id);
      }
    }
    this.running = undefined;
  }

  async drain(timeoutMs = 5000): Promise<boolean> {
    if (!this.running) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.running.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.queued.clear();
  }
}
