/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createWriteStream,
  fstatSync,
  openSync,
  constants,
  type WriteStream,
} from 'node:fs';
import type {
  Config,
  ServerGeminiStreamEvent,
  ToolCallRequestInfo,
  ToolCallResponseInfo,
} from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { Part } from '@google/genai';
import { StreamJsonOutputAdapter } from '../nonInteractive/io/index.js';

const debugLogger = createDebugLogger('DUAL_OUTPUT');

/**
 * Structured-event kinds this bridge version is known to emit. Exposed to
 * consumers in `session_start.data.supported_events` so they can
 * feature-detect rather than sniffing the stream or hard-coding a minimum
 * CLI version.
 *
 * When adding a new event kind, append it here and bump the handshake
 * `protocol_version` below so consumers can gate on the combination.
 */
export const SUPPORTED_EVENTS = [
  'system',
  'user',
  'assistant',
  'stream_event',
  'result',
  'control_request',
  'control_response',
] as const;

/**
 * Monotonically-increasing integer bumped whenever the wire protocol
 * changes in a way consumers might care about (new event types,
 * new payload fields that are not purely additive, etc.).
 *
 * History:
 *   1 — initial release (session_start, session_end, full stream-json).
 */
export const DUAL_OUTPUT_PROTOCOL_VERSION = 1;

/**
 * Optional metadata wired into the `session_start` capability handshake.
 */
export interface DualOutputBridgeOptions {
  /** CLI version string (e.g. "0.14.5"). Surfaced in session_start. */
  version?: string;
}

/**
 * Bridges TUI-mode events to a sidecar StreamJsonOutputAdapter that writes
 * structured JSON events to a secondary output channel (fd or file).
 *
 * This enables "dual output" mode: the TUI renders normally on stdout while
 * a parallel JSON event stream is emitted on a separate channel for
 * programmatic consumption by IDE extensions, web frontends, CI pipelines, etc.
 *
 * Usage:
 *   qwen --json-fd 3        # JSON events written to fd 3
 *   qwen --json-file /path  # JSON events written to file/FIFO
 */
export class DualOutputBridge {
  private readonly adapter: StreamJsonOutputAdapter;
  private readonly stream: WriteStream;
  private readonly sessionId: string;
  private active = true;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    config: Config,
    target: { fd: number } | { filePath: string },
    options: DualOutputBridgeOptions = {},
  ) {
    this.sessionId = config.getSessionId();
    if ('fd' in target) {
      // Reject stdin/stdout/stderr to prevent corrupting TUI output
      if (target.fd <= 2) {
        throw new Error(
          `--json-fd ${target.fd}: file descriptors 0 (stdin), 1 (stdout), and 2 (stderr) ` +
            'are reserved. Use fd 3 or higher.',
        );
      }
      // Validate fd is open before attempting to use it
      try {
        fstatSync(target.fd);
      } catch {
        throw new Error(
          `--json-fd ${target.fd}: file descriptor is not open. ` +
            'The caller must provide this fd via spawn stdio configuration ' +
            'or shell redirection (e.g., 3>/tmp/events.jsonl).',
        );
      }
      this.stream = createWriteStream('', { fd: target.fd });
    } else {
      // Open with O_WRONLY|O_NONBLOCK to avoid blocking the event loop on FIFOs.
      // On FIFO, a regular open(O_WRONLY) blocks until a reader connects.
      // O_NONBLOCK makes it return immediately (ENXIO if no reader yet, which
      // createWriteStream handles via its internal retry/error mechanism).
      try {
        const fd = openSync(
          target.filePath,
          constants.O_WRONLY | constants.O_NONBLOCK,
        );
        this.stream = createWriteStream('', { fd });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // ENXIO: FIFO has no reader yet — fall back to blocking open.
        // ENOENT: regular file doesn't exist yet — create it.
        if (code === 'ENXIO' || code === 'ENOENT') {
          this.stream = createWriteStream(target.filePath, { flags: 'w' });
        } else {
          throw err;
        }
      }
    }

    this.stream.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      // Consumer disconnected — gracefully stop writing, don't crash the TUI
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
        debugLogger.warn('DualOutput: consumer disconnected, disabling');
      } else {
        debugLogger.error('DualOutput stream error:', err);
      }
      // Disable on any stream error to prevent repeated write failures
      this.active = false;
    });

    this.adapter = new StreamJsonOutputAdapter(
      config,
      true, // includePartialMessages — always emit streaming events
      this.stream,
    );

    // Announce the session immediately so consumers can correlate the channel
    // with a session before any other event arrives. The data payload also
    // serves as a capability handshake: consumers can read `protocol_version`
    // and `supported_events` to feature-detect without sniffing the stream.
    try {
      this.adapter.emitSystemMessage('session_start', {
        session_id: this.sessionId,
        cwd: process.cwd(),
        protocol_version: DUAL_OUTPUT_PROTOCOL_VERSION,
        version: options.version,
        supported_events: [...SUPPORTED_EVENTS],
      });
    } catch (err) {
      debugLogger.error('DualOutput session_start error:', err);
      this.active = false;
    }
  }

  processEvent(event: ServerGeminiStreamEvent): void {
    if (!this.active) return;
    try {
      this.adapter.processEvent(event);
    } catch (err) {
      debugLogger.error('DualOutput processEvent error:', err);
      this.active = false;
    }
  }

  startAssistantMessage(): void {
    if (!this.active) return;
    try {
      this.adapter.startAssistantMessage();
    } catch (err) {
      debugLogger.error('DualOutput startAssistantMessage error:', err);
      this.active = false;
    }
  }

  finalizeAssistantMessage(): void {
    if (!this.active) return;
    try {
      this.adapter.finalizeAssistantMessage();
    } catch (err) {
      debugLogger.error('DualOutput finalizeAssistantMessage error:', err);
      this.active = false;
    }
  }

  emitUserMessage(parts: Part[]): void {
    if (!this.active) return;
    try {
      this.adapter.emitUserMessage(parts);
    } catch (err) {
      debugLogger.error('DualOutput emitUserMessage error:', err);
      this.active = false;
    }
  }

  emitToolResult(
    request: ToolCallRequestInfo,
    response: ToolCallResponseInfo,
  ): void {
    if (!this.active) return;
    try {
      this.adapter.emitToolResult(request, response);
    } catch (err) {
      debugLogger.error('DualOutput emitToolResult error:', err);
      this.active = false;
    }
  }

  /** Whether the underlying stream is still writable. */
  get isConnected(): boolean {
    return this.active;
  }

  /**
   * Emits a `can_use_tool` permission request so an external consumer can
   * approve or deny the tool call. Pairs with {@link emitControlResponse}.
   */
  emitPermissionRequest(
    requestId: string,
    toolName: string,
    toolUseId: string,
    input: unknown,
    blockedPath: string | null = null,
  ): void {
    if (!this.active) return;
    try {
      this.adapter.emitPermissionRequest(
        requestId,
        toolName,
        toolUseId,
        input,
        blockedPath,
      );
    } catch (err) {
      debugLogger.error('DualOutput emitPermissionRequest error:', err);
      this.active = false;
    }
  }

  /**
   * Emits the result of a permission decision (made either in the TUI or by
   * the external consumer) so all observers stay in sync.
   */
  emitControlResponse(requestId: string, allowed: boolean): void {
    if (!this.active) return;
    try {
      this.adapter.emitControlResponse(requestId, allowed);
    } catch (err) {
      debugLogger.error('DualOutput emitControlResponse error:', err);
      this.active = false;
    }
  }

  /**
   * Emits a `control_response` with subtype `error` — used when an external
   * `confirmation_response` cannot be satisfied (unknown request_id, the
   * tool call already resolved, stream already closed, etc.). Lets
   * consumers retry or surface the error instead of silently hanging.
   */
  emitControlError(requestId: string, message: string): void {
    if (!this.active) return;
    try {
      this.adapter.emitControlError(requestId, message);
    } catch (err) {
      debugLogger.error('DualOutput emitControlError error:', err);
      this.active = false;
    }
  }

  /** General-purpose system event escape hatch. */
  emitSystemMessage(subtype: string, data?: unknown): void {
    if (!this.active) return;
    try {
      this.adapter.emitSystemMessage(subtype, data);
    } catch (err) {
      debugLogger.error('DualOutput emitSystemMessage error:', err);
      this.active = false;
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    // Try to emit session_end before tearing the stream down so consumers
    // get a definitive termination signal rather than inferring it from
    // EPIPE. Failures here are swallowed — the stream may already be in an
    // error state if the consumer disconnected first.
    if (this.active) {
      try {
        this.adapter.emitSystemMessage('session_end', {
          session_id: this.sessionId,
        });
      } catch {
        // ignore — stream likely already closed
      }
    }
    this.active = false;
    this.shutdownPromise = new Promise((resolve) => {
      if (this.stream.closed) {
        resolve();
        return;
      }

      const cleanup = () => {
        this.stream.off('close', onClose);
        this.stream.off('error', onError);
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        debugLogger.debug('DualOutput: stream error during shutdown:', err);
      };

      this.stream.once('close', onClose);
      this.stream.once('error', onError);

      try {
        this.stream.end();
      } catch (err) {
        cleanup();
        debugLogger.debug('DualOutput: stream end error during shutdown:', err);
        resolve();
      }
    });
    return this.shutdownPromise;
  }
}
