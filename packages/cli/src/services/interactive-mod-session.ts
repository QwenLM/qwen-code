/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { ModToolCall } from '@qwen-code/qwen-code-core/mods/tool-events.js';
import type { ModCommandPresentation } from '@qwen-code/qwen-code-core/mods/types.js';
import type {
  ModRenderElement,
  ModRenderInput,
  ModRenderSite,
} from '@qwen-code/qwen-code-core/mods/render-tree.js';
import type { LoadedSettings } from '../config/settings.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import { sanitizeTerminalLine } from '../ui/utils/textUtils.js';
import { registerCleanup } from '../utils/cleanup.js';
import { ModSession, type ModTurn } from './mod-session.js';
import type { ICommandLoader } from './types.js';

const sessions = new WeakMap<Config, InteractiveModSession>();

export function isModRecoveryCommand(
  command: SlashCommand | undefined,
): boolean {
  return (
    command?.kind === CommandKind.BUILT_IN &&
    (command.name === 'help' || command.name === 'quit')
  );
}

export function createInteractiveModSession(
  config: Config,
  settings: LoadedSettings,
): InteractiveModSession | undefined {
  if (!settings.merged.experimental?.mods || !config.isInteractive()) return;
  let session = sessions.get(config);
  if (!session) {
    session = new InteractiveModSession(config, settings);
    sessions.set(config, session);
  }
  return session;
}

export function getInteractiveModSession(
  config: Config | null,
): InteractiveModSession | undefined {
  return config ? sessions.get(config) : undefined;
}

/** A tree the band draws, and the plugin, or `hooks`, that drew it. */
export interface ModBand {
  readonly tree: ModRenderElement;
  readonly owner: string;
  /** Counts the answers drawn, so each is drawn afresh. */
  readonly revision: number;
}

export class InteractiveModSession implements ICommandLoader {
  private readonly session: ModSession;
  private readonly lifetime = new AbortController();
  private resolveStartup!: () => void;
  private rejectStartup!: (error: unknown) => void;
  private readonly startup = new Promise<void>((resolve, reject) => {
    this.resolveStartup = resolve;
    this.rejectStartup = reject;
  });
  private initialization?: Promise<void>;
  private closing?: Promise<void>;
  private listener?: (text: string) => void;
  private readonly logs: Array<{ text: string; sessionId: string }> = [];
  private presentation: ModCommandPresentation = {
    isFullscreen: false,
    columns: 80,
  };
  private sites: readonly ModRenderSite[] = [];
  // The band's last tree, kept until a new answer lands; none draws nothing.
  private band?: ModBand;
  private revision = 0;
  private readonly bandListeners = new Set<() => void>();
  private unregisterCleanup: () => void;

  constructor(
    private readonly config: Config,
    settings: LoadedSettings,
  ) {
    this.startup.catch(() => {});
    this.session = ModSession.create(config, settings, {
      surface: 'terminal',
      presentation: () => this.presentation,
      sites: () => this.sites,
      draw: (tree, owner) => {
        const band =
          tree.type === 'engine'
            ? undefined
            : { tree, owner, revision: ++this.revision };
        if (!band && !this.band) return;
        this.band = band;
        for (const listener of this.bandListeners) listener();
      },
      log: (entry, plugin, sessionId) =>
        this.emit(
          `[Mod ${sanitizeTerminalLine(plugin)}] ${entry.text}`,
          sessionId,
        ),
    })!;
    this.unregisterCleanup = registerCleanup(() => {
      this.unregisterCleanup = () => {};
      return this.close();
    });
  }

  /** Loads the Mods once; `sites` names the render sites the host draws. */
  initialize(sites: readonly ModRenderSite[] = []): Promise<void> {
    if (!this.initialization) this.sites = sites;
    this.initialization ??= this.session.initialize(this.lifetime.signal).then(
      () => {
        this.session.flushLogs();
        this.resolveStartup();
      },
      (error: unknown) => {
        this.emit(
          `Mods failed to initialize: ${sanitizeTerminalLine(String(error)).slice(0, 2000)}`,
          this.config.getSessionId(),
        );
        this.rejectStartup(error);
        throw error;
      },
    );
    return this.initialization;
  }

  get ready(): Promise<void> {
    return this.startup;
  }

  failStartup(error: unknown): void {
    if (this.initialization) return;
    this.initialization = this.startup;
    this.rejectStartup(error);
  }

  async loadCommands(signal: AbortSignal) {
    await this.startup;
    signal.throwIfAborted();
    return this.session.loadCommands(this.lifetime.signal);
  }

  setPresentation(presentation: ModCommandPresentation): void {
    this.presentation = { ...presentation };
  }

  setRenderInput(input: ModRenderInput): void {
    if (!this.closing) this.session.setRenderInput(input);
  }

  readonly subscribeBand = (listener: () => void): (() => void) => {
    this.bandListeners.add(listener);
    return () => this.bandListeners.delete(listener);
  };

  readonly getBand = (): ModBand | undefined => this.band;

  subscribe(listener: (text: string) => void): () => void {
    this.listener = listener;
    for (const entry of this.logs.splice(0))
      this.emit(entry.text, entry.sessionId);
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  private emit(text: string, sessionId: string): void {
    if (this.closing || sessionId !== this.config.getSessionId()) return;
    if (this.listener) this.listener(text);
    else {
      if (this.logs.length === 100) this.logs.shift();
      this.logs.push({ text, sessionId });
    }
  }

  captureToolSignal(): AbortSignal {
    return AbortSignal.any([
      this.lifetime.signal,
      this.session.captureToolSignal(),
    ]);
  }

  restoreTools(): Promise<void> {
    return this.session.restoreTools();
  }

  invalidateTools(): void {
    this.session.invalidateTools();
  }

  toolCall(): ModToolCall | undefined {
    return this.session.toolCall(() => {});
  }

  syncSession(reason: 'clear' | 'resume'): Promise<void> {
    return this.session.syncSession(reason);
  }

  startTurn(
    text: string,
    signal: AbortSignal,
    abort: () => boolean,
    promptId?: string,
  ): ModTurn | undefined {
    return this.closing
      ? undefined
      : this.session.startTurn(text, signal, abort, promptId);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.unregisterCleanup();
      this.lifetime.abort();
      this.rejectStartup(new Error('Interactive Mod session is closed.'));
      try {
        await this.session.close();
      } finally {
        this.listener = undefined;
        this.logs.length = 0;
        this.band = undefined;
        for (const listener of this.bandListeners) listener();
        if (sessions.get(this.config) === this) sessions.delete(this.config);
      }
    })();
    return this.closing;
  }
}
