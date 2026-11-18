/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { RequestError } from '@agentclientprotocol/sdk';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  StreamEventType,
  type StreamEvent,
} from '@qwen-code/qwen-code-core/core/llm-chat.js';
import {
  LlmEventType,
  type ServerLlmStreamEvent,
} from '@qwen-code/qwen-code-core/core/turn.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { LoadedSettings } from '../../config/settings.js';
import { ModSession, type ModTurn } from '../../services/mod-session.js';

const debugLogger = createDebugLogger('MODS');

/** The notification each Mod log line reaches the client with. */
export const MOD_LOG_NOTIFICATION = 'qwen/notify/session/mod-log';

/** The error a prompt is refused with while the session's Mods failed to load. */
export const ACP_MODS_FAILED =
  'Mods failed to initialize. Fix the Mod configuration and start a new session.';

export interface ModLogNotifier {
  extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * The Mods of one ACP session. The session's Config and its client are its
 * own, so nothing here is shared with another session in the process.
 */
export class AcpModSession {
  private readonly session: ModSession;
  private readonly loading: Promise<void>;
  private failure?: string;

  private constructor(
    config: Config,
    settings: LoadedSettings,
    sessionId: string,
    client: ModLogNotifier,
  ) {
    const send = (plugin: string, text: string) =>
      void client
        .extNotification(MOD_LOG_NOTIFICATION, { sessionId, plugin, text })
        .catch((error: unknown) =>
          debugLogger.debug(`Mod log not delivered: ${String(error)}`),
        );
    this.session = ModSession.create(config, settings, {
      surface: null,
      log: (entry, plugin) => send(plugin, entry.text),
    })!;
    // Startup does not wait for the Mods; a prompt does. A close stops the
    // load through the Mod session's own lifetime.
    this.loading = this.session.initialize(new AbortController().signal).then(
      () => this.session.flushLogs(),
      (error: unknown) => {
        this.failure = String(error).slice(0, 2000);
        this.session.flushLogs();
      },
    );
  }

  /** The session's Mods, or none when the settings leave them off. */
  static create(
    config: Config,
    settings: LoadedSettings,
    sessionId: string,
    client: ModLogNotifier,
  ): AcpModSession | undefined {
    return settings.merged.experimental?.mods
      ? new AcpModSession(config, settings, sessionId, client)
      : undefined;
  }

  /** Waits for the shared load until this prompt is cancelled. */
  async admit(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    let onAbort!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      onAbort = () => resolve();
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([this.loading, cancelled]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (!signal.aborted && this.failure !== undefined)
      throw RequestError.internalError(
        undefined,
        `${ACP_MODS_FAILED} ${this.failure}`,
      );
  }

  /**
   * Starts a turn the Mods hear. `abort` stops it for `$.turn.abort` and
   * returns whether it did.
   */
  startTurn(
    text: string,
    signal: AbortSignal,
    abort: () => boolean,
    promptId: string,
  ): AcpModTurn | undefined {
    const turn = this.session.startTurn(text, signal, abort, promptId);
    return turn ? new AcpModTurn(turn) : undefined;
  }

  /** Ends the Mods' session after `/clear` gave the Config a new one. */
  syncSession(): Promise<void> {
    return this.session.syncSession('clear');
  }

  close(): Promise<void> {
    return this.session.close();
  }
}

/**
 * A turn as the Mods hear it. The shared agent loop hands it its model
 * events; the legacy loop hands it the raw stream, read the same way.
 */
export class AcpModTurn {
  private failed = false;

  constructor(private readonly turn: ModTurn) {}

  saw(event: ServerLlmStreamEvent): void {
    this.turn.saw(event);
  }

  sawStream(event: StreamEvent): void {
    if (event.type === StreamEventType.CHUNK) {
      for (const part of event.value.candidates?.[0]?.content?.parts ?? [])
        if (part.text && !part.thought)
          this.turn.saw({ type: LlmEventType.Content, value: part.text });
    } else if (event.type === StreamEventType.RETRY) {
      this.turn.saw({
        type: LlmEventType.Retry,
        ...(event.isContinuation && { isContinuation: true }),
      });
    } else if (event.type === StreamEventType.MODEL_FALLBACK) {
      // A fallback restarts the response, as a fresh retry does.
      this.turn.saw({ type: LlmEventType.Retry });
    }
  }

  /** A legacy stream ended: its response is complete. */
  finishStream(usageMetadata?: GenerateContentResponseUsageMetadata): void {
    this.turn.saw({
      type: LlmEventType.Finished,
      value: { reason: undefined, usageMetadata },
    });
  }

  /** A legacy model round failed. */
  fail(): void {
    this.failed = true;
  }

  complete(aborted: boolean): Promise<void> {
    return this.turn.complete(
      aborted ? 'aborted' : this.failed ? 'error' : undefined,
    );
  }
}
