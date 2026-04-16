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
  private active = true;

  constructor(config: Config, target: { fd: number } | { filePath: string }) {
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
        // ENXIO: FIFO has no reader yet — fall back to blocking open
        if ((err as NodeJS.ErrnoException).code === 'ENXIO') {
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
    // with a session before any other event arrives.
    try {
      this.adapter.emitSystemMessage('session_start', {
        session_id: config.getSessionId(),
        cwd: process.cwd(),
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

  /** Reserved for future lifecycle events (e.g. session_end). */
  emitSystemMessage(subtype: string, data?: unknown): void {
    if (!this.active) return;
    try {
      this.adapter.emitSystemMessage(subtype, data);
    } catch (err) {
      debugLogger.error('DualOutput emitSystemMessage error:', err);
      this.active = false;
    }
  }

  shutdown(): void {
    this.active = false;
    try {
      this.stream.end();
    } catch {
      // ignore cleanup errors
    }
  }
}
