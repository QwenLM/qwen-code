/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { SessionAttachmentReference } from './sessionAttachments.js';

export const SESSION_ATTACHMENT_CHUNK_BYTES = 512 * 1024;
const UPLOAD_LIFETIME_MS = 5 * 60 * 1000;
const MAX_STAGED_BYTES = 128 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 32;
const MAX_SESSION_UPLOADS = 8;
const MAX_RECEIPTS = 1024;

export interface SessionAttachmentUploadMetadata {
  name: string;
  mimeType: string;
  size: number;
}

export class SessionAttachmentUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'SessionAttachmentUploadError';
  }
}

interface Upload {
  id: string;
  owner: SessionAttachmentUploads;
  clientId: string | undefined;
  metadata: SessionAttachmentUploadMetadata;
  data?: Buffer;
  offset: number;
  previousOffset: number;
  expiresAt: number;
  state: 'receiving' | 'completing' | 'completed' | 'failed';
  completion?: Promise<SessionAttachmentReference>;
}

const uploads = new Set<Upload>();
const receipts = new Set<Upload>();
let stagedBytes = 0;
let activeUploads = 0;
let sweepTimer: ReturnType<typeof setInterval> | undefined;

function sweep(): void {
  const now = Date.now();
  for (const upload of uploads) {
    if (upload.state !== 'completing' && upload.expiresAt <= now) {
      upload.owner.discard(upload);
    }
  }
}

function notFound(): SessionAttachmentUploadError {
  return new SessionAttachmentUploadError(
    404,
    'attachment_upload_not_found',
    'Attachment upload is unavailable',
  );
}

export class SessionAttachmentUploads {
  private readonly records = new Map<string, Upload>();
  private active = 0;
  private closed = false;

  create(
    metadata: SessionAttachmentUploadMetadata,
    clientId?: string,
  ): { uploadId: string } {
    if (this.closed) throw notFound();
    sweep();
    if (
      this.active >= MAX_SESSION_UPLOADS ||
      activeUploads >= MAX_ACTIVE_UPLOADS ||
      stagedBytes + metadata.size > MAX_STAGED_BYTES
    ) {
      throw new SessionAttachmentUploadError(
        429,
        'attachment_upload_capacity_exceeded',
        'Attachment upload capacity is exhausted; try again later',
      );
    }
    stagedBytes += metadata.size;
    activeUploads++;
    this.active++;
    let data: Buffer;
    try {
      data = Buffer.alloc(metadata.size);
    } catch (error) {
      stagedBytes -= metadata.size;
      activeUploads--;
      this.active--;
      throw error;
    }
    const upload: Upload = {
      id: randomUUID(),
      owner: this,
      clientId,
      metadata: { ...metadata },
      data,
      offset: 0,
      previousOffset: -1,
      expiresAt: Date.now() + UPLOAD_LIFETIME_MS,
      state: 'receiving',
    };
    this.records.set(upload.id, upload);
    uploads.add(upload);
    if (!sweepTimer) {
      sweepTimer = setInterval(sweep, 30_000);
      sweepTimer.unref();
    }
    return { uploadId: upload.id };
  }

  append(
    id: string,
    offset: number,
    data: Buffer,
    clientId?: string,
  ): { offset: number } {
    const upload = this.get(id, clientId);
    if (upload.state !== 'receiving' || !upload.data) {
      throw new SessionAttachmentUploadError(
        409,
        'attachment_upload_finalizing',
        'Attachment upload no longer accepts chunks',
      );
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || data.length === 0) {
      throw new SessionAttachmentUploadError(
        400,
        'invalid_attachment_upload_chunk',
        'A nonempty chunk and a non-negative integer offset are required',
      );
    }
    if (
      data.length > SESSION_ATTACHMENT_CHUNK_BYTES ||
      offset + data.length > upload.metadata.size
    ) {
      throw new SessionAttachmentUploadError(
        413,
        'attachment_upload_too_large',
        'Chunk exceeds the attachment upload size limit',
      );
    }
    if (
      offset === upload.previousOffset &&
      offset + data.length === upload.offset &&
      upload.data.subarray(offset, upload.offset).equals(data)
    ) {
      return { offset: upload.offset };
    }
    if (
      offset !== upload.offset ||
      data.length !==
        Math.min(SESSION_ATTACHMENT_CHUNK_BYTES, upload.metadata.size - offset)
    ) {
      throw new SessionAttachmentUploadError(
        409,
        'attachment_upload_offset_conflict',
        'Chunk does not match the expected attachment offset or length',
      );
    }
    data.copy(upload.data, offset);
    upload.previousOffset = offset;
    upload.offset += data.length;
    return { offset: upload.offset };
  }

  complete(
    id: string,
    clientId: string | undefined,
    commit: (
      data: Buffer,
      metadata: SessionAttachmentUploadMetadata,
      assertActive: () => void,
    ) => Promise<SessionAttachmentReference>,
  ): Promise<SessionAttachmentReference> {
    const upload = this.get(id, clientId);
    if (upload.completion) return upload.completion;
    if (upload.offset !== upload.metadata.size) {
      throw new SessionAttachmentUploadError(
        409,
        'attachment_upload_incomplete',
        'Attachment upload has not received all bytes',
      );
    }
    upload.state = 'completing';
    let retryableFailure = false;
    const assertActive = () => {
      if (this.closed || this.records.get(id) !== upload) throw notFound();
    };
    upload.completion = Promise.resolve()
      .then(() => {
        assertActive();
        return commit(upload.data!, upload.metadata, assertActive);
      })
      .then(
        (reference) => {
          upload.state = 'completed';
          return reference;
        },
        (error: unknown) => {
          if (
            error instanceof SessionAttachmentUploadError &&
            error.code === 'attachment_upload_store_busy'
          ) {
            upload.state = 'receiving';
            upload.completion = undefined;
            retryableFailure = true;
          } else {
            upload.state = 'failed';
          }
          throw error;
        },
      )
      .finally(() => {
        if (retryableFailure) {
          if (this.closed || this.records.get(id) !== upload) {
            this.discard(upload);
          }
          return;
        }
        this.releaseBuffer(upload);
        if (this.closed || this.records.get(id) !== upload) {
          this.discard(upload);
          return;
        }
        upload.expiresAt = Date.now() + UPLOAD_LIFETIME_MS;
        receipts.add(upload);
        while (receipts.size > MAX_RECEIPTS) {
          const oldest = receipts.values().next().value!;
          oldest.owner.discard(oldest);
        }
      });
    return upload.completion;
  }

  cancel(id: string, clientId?: string): void {
    sweep();
    const upload = this.records.get(id);
    if (!upload || upload.clientId !== clientId) return;
    if (upload.state === 'completing' || upload.state === 'completed') {
      throw new SessionAttachmentUploadError(
        409,
        upload.state === 'completing'
          ? 'attachment_upload_finalizing'
          : 'attachment_upload_completed',
        'Attachment completion cannot be cancelled',
      );
    }
    this.discard(upload);
  }

  cancelClient(clientId: string): void {
    for (const upload of this.records.values()) {
      if (upload.clientId === clientId) this.discard(upload);
    }
  }

  close(): void {
    this.closed = true;
    for (const upload of this.records.values()) this.discard(upload);
  }

  discard(upload: Upload): void {
    this.records.delete(upload.id);
    if (upload.state === 'completing') return;
    this.releaseBuffer(upload);
    uploads.delete(upload);
    receipts.delete(upload);
    if (uploads.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
  }

  private get(id: string, clientId?: string): Upload {
    const upload = this.records.get(id);
    if (!upload || upload.clientId !== clientId) throw notFound();
    if (upload.state !== 'completing' && upload.expiresAt <= Date.now()) {
      this.discard(upload);
      throw notFound();
    }
    return upload;
  }

  private releaseBuffer(upload: Upload): void {
    if (!upload.data) return;
    upload.data = undefined;
    stagedBytes -= upload.metadata.size;
    activeUploads--;
    this.active--;
  }
}
