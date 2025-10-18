/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { StreamJsonWriter } from './writer.js';
import type {
  StreamJsonControlCancelRequestEnvelope,
  StreamJsonControlResponseEnvelope,
  StreamJsonOutputEnvelope,
} from './types.js';

interface PendingControlRequest {
  resolve: (envelope: StreamJsonControlResponseEnvelope) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
}

export interface ControlRequestOptions {
  timeoutMs?: number;
}

export class StreamJsonController {
  private readonly pendingRequests = new Map<string, PendingControlRequest>();
  private activeAbortController: AbortController | null = null;

  constructor(private readonly writer: StreamJsonWriter) {}

  sendControlRequest(
    subtype: string,
    payload: Record<string, unknown>,
    options: ControlRequestOptions = {},
  ): Promise<StreamJsonControlResponseEnvelope> {
    const requestId = randomUUID();
    const envelope: StreamJsonOutputEnvelope = {
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype,
        ...payload,
      },
    };

    const promise = new Promise<StreamJsonControlResponseEnvelope>(
      (resolve, reject) => {
        const pending: PendingControlRequest = { resolve, reject };

        if (options.timeoutMs && options.timeoutMs > 0) {
          pending.timeout = setTimeout(() => {
            this.pendingRequests.delete(requestId);
            reject(
              new Error(
                `Timed out waiting for control_response to ${subtype}`,
              ),
            );
          }, options.timeoutMs);
        }

        this.pendingRequests.set(requestId, pending);
      },
    );

    this.writer.writeEnvelope(envelope);
    return promise;
  }

  handleControlResponse(
    envelope: StreamJsonControlResponseEnvelope,
  ): void {
    const pending = this.pendingRequests.get(envelope.request_id);
    if (!pending) {
      return;
    }

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    this.pendingRequests.delete(envelope.request_id);
    pending.resolve(envelope);
  }

  handleControlCancel(
    envelope: StreamJsonControlCancelRequestEnvelope,
  ): void {
    if (envelope.request_id) {
      this.rejectPending(
        envelope.request_id,
        new Error(
          envelope.reason
            ? `Control request cancelled: ${envelope.reason}`
            : 'Control request cancelled',
        ),
      );
      return;
    }

    for (const requestId of [...this.pendingRequests.keys()]) {
      this.rejectPending(
        requestId,
        new Error(
          envelope.reason
            ? `Control request cancelled: ${envelope.reason}`
            : 'Control request cancelled',
        ),
      );
    }
  }

  setActiveRunAbortController(
    controller: AbortController | null,
  ): void {
    this.activeAbortController = controller;
  }

  interruptActiveRun(): void {
    this.activeAbortController?.abort();
  }

  cancelPendingRequests(reason?: string, requestId?: string): void {
    if (requestId) {
      if (!this.pendingRequests.has(requestId)) {
        return;
      }
      this.writer.writeEnvelope({
        type: 'control_cancel_request',
        request_id: requestId,
        reason,
      });
      this.rejectPending(
        requestId,
        new Error(
          reason
            ? `Control request cancelled: ${reason}`
            : 'Control request cancelled',
        ),
      );
      return;
    }

    for (const pendingId of [...this.pendingRequests.keys()]) {
      this.writer.writeEnvelope({
        type: 'control_cancel_request',
        request_id: pendingId,
        reason,
      });
      this.rejectPending(
        pendingId,
        new Error(
          reason
            ? `Control request cancelled: ${reason}`
            : 'Control request cancelled',
        ),
      );
    }
  }

  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    this.pendingRequests.delete(requestId);
    pending.reject(error);
  }
}
