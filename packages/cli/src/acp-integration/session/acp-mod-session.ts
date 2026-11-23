/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  RequestError,
  type ClientCapabilities,
} from '@agentclientprotocol/sdk';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import {
  MOD_ROWS_CLIENT_CAPABILITY,
  type BridgeModRowAnswer,
} from '@qwen-code/acp-bridge/status';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  StreamEventType,
  type StreamEvent,
} from '@qwen-code/qwen-code-core/core/llm-chat.js';
import {
  LlmEventType,
  type ServerLlmStreamEvent,
} from '@qwen-code/qwen-code-core/core/turn.js';
import type {
  ModAssistantMessageInput,
  ModRenderSite,
  ModThinkingInput,
} from '@qwen-code/qwen-code-core/mods/render-tree.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { LoadedSettings } from '../../config/settings.js';
import { ModSession, type ModTurn } from '../../services/mod-session.js';
import {
  displayTranslationTarget,
  drawsTranslatedRows,
  modsWanted,
} from '../../services/display-translation-mod.js';
import { AcpDisplayTranslationRows } from './acp-display-translation-rows.js';

const debugLogger = createDebugLogger('MODS');

// The rows a client may draw, with the kind of each prop a row is asked with.
type AcpModRow = Pick<
  ModAssistantMessageInput | ModThinkingInput,
  'component' | 'props'
>;
const ROW_PROPS: Record<
  AcpModRow['component'],
  Record<string, 'string' | 'boolean'>
> = {
  AssistantMessage: { text: 'string', isFirstOfReply: 'boolean' },
  Thinking: { text: 'string' },
};

// How long a client's ask waits: for the Mods to load, the rows ahead of it,
// and its own render's 30 seconds.
const ROW_ASK_TIMEOUT_MS = 60_000;

/** The row sites an ACP client says it draws, of those a Mod may rewrite. */
export function acpModRowSites(
  capabilities: ClientCapabilities | undefined,
): ModRenderSite[] {
  const declared: unknown = capabilities?._meta?.[MOD_ROWS_CLIENT_CAPABILITY];
  return Array.isArray(declared)
    ? (Object.keys(ROW_PROPS) as ModRenderSite[]).filter((site) =>
        declared.includes(site),
      )
    : [];
}

export function parseAcpModRow(
  component: unknown,
  props: unknown,
): AcpModRow | undefined {
  if (typeof component !== 'string')
    throw RequestError.invalidParams(
      { errorKind: 'invalid_mod_row' },
      'Invalid Mod row component',
    );
  if (!Object.hasOwn(ROW_PROPS, component)) return undefined;
  const site = component as AcpModRow['component'];
  const kinds = ROW_PROPS[site];
  if (
    typeof props !== 'object' ||
    props === null ||
    Array.isArray(props) ||
    Object.keys(props).length !== Object.keys(kinds).length ||
    Object.entries(kinds).some(
      ([key, kind]) =>
        !Object.hasOwn(props, key) ||
        typeof (props as Record<string, unknown>)[key] !== kind,
    )
  )
    throw RequestError.invalidParams(
      { errorKind: 'invalid_mod_row' },
      `Invalid ${component} row props`,
    );
  return {
    component: site,
    props: props as AcpModRow['props'],
  };
}

// Resolves once `promise` settles, or false once `signal` aborts first.
async function settled(
  promise: Promise<unknown>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  let onAbort!: () => void;
  const aborted = new Promise<false>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise.then(() => true), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

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
  private readonly translationRows?: AcpDisplayTranslationRows;
  private readonly loading: Promise<void>;
  private failure?: string;

  private constructor(
    config: Config,
    settings: LoadedSettings,
    sessionId: string,
    client: ModLogNotifier,
    sites: readonly ModRenderSite[],
  ) {
    if (displayTranslationTarget(settings) && drawsTranslatedRows(sites)) {
      this.translationRows = new AcpDisplayTranslationRows(config);
    }
    const send = (plugin: string, text: string) =>
      void client
        .extNotification(MOD_LOG_NOTIFICATION, { sessionId, plugin, text })
        .catch((error: unknown) =>
          debugLogger.debug(`Mod log not delivered: ${String(error)}`),
        );
    // A client that draws rows is the desktop the Mods draw on.
    this.session = ModSession.create(config, settings, {
      surface: sites.length ? 'desktop' : null,
      log: (entry, plugin) => send(plugin, entry.text),
      sites: () => sites,
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

  /**
   * The session's Mods, or none when the settings leave them off. `sites` are
   * the rows the client draws.
   */
  static create(
    config: Config,
    settings: LoadedSettings,
    sessionId: string,
    client: ModLogNotifier,
    sites: readonly ModRenderSite[] = [],
  ): AcpModSession | undefined {
    return modsWanted(settings)
      ? new AcpModSession(config, settings, sessionId, client, sites)
      : undefined;
  }

  /** Waits for the shared load until this prompt is cancelled. */
  async admit(signal: AbortSignal): Promise<void> {
    if ((await settled(this.loading, signal)) && this.failure !== undefined)
      throw RequestError.internalError(
        undefined,
        `${ACP_MODS_FAILED} ${this.failure}`,
      );
  }

  /**
   * Answers a row the client draws, asked with its site and the props it
   * draws with; the envelope is the host's own.
   */
  async askRow(
    component: unknown,
    props: unknown,
  ): Promise<BridgeModRowAnswer> {
    const row = parseAcpModRow(component, props);
    if (!row) return { status: 'unhooked' };
    const signal = AbortSignal.timeout(ROW_ASK_TIMEOUT_MS);
    if (!(await settled(this.loading, signal))) return { status: 'unanswered' };
    if (this.failure !== undefined) return { status: 'unhooked' };
    const isAuthorized = this.session.canTranslateRow(row.component)
      ? await this.translationRows?.authorize(row.component, row.props.text)
      : undefined;
    return this.session.askRow(
      row.component,
      row.props,
      signal,
      isAuthorized?.() === true,
    );
  }

  observeModelText(text: string, thought: boolean, attempt: object): void {
    const component = thought ? 'Thinking' : 'AssistantMessage';
    if (this.session.canTranslateRow(component)) {
      this.translationRows?.observe(text, component, attempt);
    }
  }

  settleModelText(attempt: object, completed: boolean): void {
    this.translationRows?.settleAttempt(attempt, completed);
  }

  rememberCompletedReply(text: string): void {
    if (this.session.canTranslateRow('AssistantMessage'))
      this.translationRows?.rememberCompleted('AssistantMessage', text);
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
