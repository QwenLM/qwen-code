/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpSessionBridge } from './acp-session-bridge.js';
import type { Response } from 'express';
import { ArtifactLibraryStream } from './server/artifact-library-stream.js';

const RETENTION_MS = 60_000;
const MAX_REQUESTS = 32;
const MAX_ANSWER_BYTES = 1024 * 1024;

type BtwSnapshot =
  | { type: 'answer' | 'done'; requestId: string; answer: string }
  | { type: 'error'; requestId: string; code: string; message: string };

export class BtwStreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class BtwStreamRequest {
  private readonly abort = new AbortController();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private snapshot: BtwSnapshot;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly question: string | undefined,
    requestId: string,
    private readonly expire: () => void,
  ) {
    this.snapshot = { type: 'answer', requestId, answer: '' };
  }

  private update(snapshot: BtwSnapshot): void {
    if (this.snapshot.type !== 'answer') return;
    this.snapshot = snapshot;
    this.revision++;
    if (snapshot.type !== 'answer') {
      clearTimeout(this.timer);
      this.timer = setTimeout(this.expire, RETENTION_MS);
      this.timer.unref();
    }
    for (const wake of this.listeners) wake();
  }

  get terminal(): boolean {
    return this.snapshot.type !== 'answer';
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  cancel(): void {
    this.update({
      type: 'error',
      requestId: this.snapshot.requestId,
      code: 'btw_cancelled',
      message: 'Side question cancelled',
    });
    this.abort.abort();
  }

  async run(bridge: AcpSessionBridge, sessionId: string, clientId?: string) {
    this.timer = setTimeout(() => {
      this.update({
        type: 'error',
        requestId: this.snapshot.requestId,
        code: 'btw_timeout',
        message: 'Side question timed out',
      });
      this.abort.abort();
    }, 300_000);
    this.timer.unref();
    let answer = '';
    let bytes = 0;
    try {
      for await (const event of bridge.generateSessionBtwStream!(
        sessionId,
        this.question!,
        this.abort.signal,
        clientId !== undefined ? { clientId } : undefined,
      )) {
        if (this.abort.signal.aborted) return;
        if (event.type === 'delta') {
          bytes += Buffer.byteLength(event.text, 'utf8');
          if (bytes > MAX_ANSWER_BYTES) {
            throw new Error('Side question answer exceeds 1 MiB');
          }
          answer += event.text;
          this.update({
            type: 'answer',
            requestId: this.snapshot.requestId,
            answer,
          });
        } else if (event.type === 'done') {
          this.update({
            type: 'done',
            requestId: this.snapshot.requestId,
            answer: answer.trim(),
          });
          return;
        }
      }
      throw new Error('Side question stream ended before completion');
    } catch {
      this.update({
        type: 'error',
        requestId: this.snapshot.requestId,
        code: 'btw_failed',
        message: 'Side question failed',
      });
      this.abort.abort();
    }
  }

  async *subscribe(signal: AbortSignal): AsyncGenerator<BtwSnapshot> {
    let revision = -1;
    while (!signal.aborted) {
      if (revision !== this.revision) {
        revision = this.revision;
        const snapshot = this.snapshot;
        yield snapshot;
        if (snapshot.type !== 'answer') return;
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.listeners.delete(wake);
          signal.removeEventListener('abort', wake);
          resolve();
        };
        this.listeners.add(wake);
        signal.addEventListener('abort', wake, { once: true });
        if (signal.aborted || revision !== this.revision) wake();
      });
    }
  }
}

export class BtwStreamRequests {
  private readonly runtimes = new WeakMap<
    AcpSessionBridge,
    Map<string, BtwStreamRequest>
  >();

  private requests(bridge: AcpSessionBridge): Map<string, BtwStreamRequest> {
    let requests = this.runtimes.get(bridge);
    if (!requests) {
      requests = new Map();
      this.runtimes.set(bridge, requests);
    }
    return requests;
  }

  private key(
    sessionId: string,
    clientId: string | undefined,
    requestId: string,
  ) {
    return JSON.stringify([sessionId, clientId ?? null, requestId]);
  }

  has(
    bridge: AcpSessionBridge,
    sessionId: string,
    clientId: string | undefined,
    requestId: string,
  ): boolean {
    return (
      this.runtimes
        .get(bridge)
        ?.has(this.key(sessionId, clientId, requestId)) ?? false
    );
  }

  open(
    bridge: AcpSessionBridge,
    sessionId: string,
    clientId: string | undefined,
    requestId: string,
    question: string,
    resume: boolean,
  ): BtwStreamRequest {
    const requests = this.requests(bridge);
    const key = this.key(sessionId, clientId, requestId);
    const existing = requests.get(key);
    if (existing) {
      if (existing.question !== undefined && existing.question !== question) {
        throw new BtwStreamError(
          409,
          'btw_request_conflict',
          'This request ID belongs to a different question',
        );
      }
      return existing;
    }
    if (resume) {
      throw new BtwStreamError(410, 'btw_expired', 'Side question has expired');
    }
    const request = this.create(requests, key, question, requestId);
    void request.run(bridge, sessionId, clientId);
    return request;
  }

  cancel(
    bridge: AcpSessionBridge,
    sessionId: string,
    clientId: string | undefined,
    requestId: string,
  ): void {
    const requests = this.requests(bridge);
    const key = this.key(sessionId, clientId, requestId);
    const request =
      requests.get(key) ?? this.create(requests, key, undefined, requestId);
    request.cancel();
  }

  private create(
    requests: Map<string, BtwStreamRequest>,
    key: string,
    question: string | undefined,
    requestId: string,
  ): BtwStreamRequest {
    if (requests.size >= MAX_REQUESTS) {
      const oldestTerminal = [...requests].find(
        ([, request]) => request.terminal,
      );
      if (!oldestTerminal) {
        throw new BtwStreamError(429, 'btw_limit', 'Too many side questions');
      }
      oldestTerminal[1].dispose();
      requests.delete(oldestTerminal[0]);
    }
    const request = new BtwStreamRequest(question, requestId, () => {
      requests.delete(key);
    });
    requests.set(key, request);
    return request;
  }
}

export async function streamBtwSnapshots(
  res: Response,
  request: BtwStreamRequest,
): Promise<void> {
  const connection = new AbortController();
  const onClose = () => connection.abort();
  res.once('close', onClose);
  const stream = new ArtifactLibraryStream(res);
  try {
    for await (const snapshot of request.subscribe(connection.signal)) {
      await stream.send(snapshot.type, snapshot);
    }
  } catch {
    // A failed connection can reattach to the same generation.
  } finally {
    connection.abort();
    res.off('close', onClose);
    stream.end();
  }
}
