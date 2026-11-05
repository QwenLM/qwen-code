/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { ModToolCall } from '@qwen-code/qwen-code-core/mods/tool-events.js';
import type {
  ModCommandPresentation,
  ModQueuedPrompt,
} from '@qwen-code/qwen-code-core/mods/types.js';
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

/** The line a prompt sent to Mods that failed to load is refused with. */
export const MODS_FAILED_TO_INITIALIZE =
  'Mods failed to initialize. Fix the Mod configuration and restart. /help and /quit remain available.';

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
  private started = false;
  private startupFailed = false;
  private closing?: Promise<void>;
  private listener?: (text: string) => void;
  private readonly logs: Array<{ text: string; sessionId: string }> = [];
  private presentation: ModCommandPresentation = {
    isFullscreen: false,
    columns: 80,
  };
  private sites: readonly ModRenderSite[] = [];
  private prompts = false;
  private runsPrompts = false;
  private readonly promptListeners = new Set<() => void>();
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
      prompts: () => this.prompts,
      runsPrompts: () => this.runsPrompts,
      promptQueued: () => {
        for (const listener of this.promptListeners) listener();
      },
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

  /**
   * Loads the Mods once; `sites` names the render sites the host draws,
   * `prompts` says whether it raises `prompt.submit`, and `runsPrompts`
   * whether it runs the prompts the Mods submit with `$.prompt.submit`.
   */
  initialize(
    sites: readonly ModRenderSite[] = [],
    {
      prompts = false,
      runsPrompts = false,
    }: { prompts?: boolean; runsPrompts?: boolean } = {},
  ): Promise<void> {
    if (!this.initialization) {
      this.sites = sites;
      this.prompts = prompts;
      this.runsPrompts = runsPrompts;
    }
    this.initialization ??= this.session.initialize(this.lifetime.signal).then(
      () => {
        this.session.flushLogs();
        this.started = true;
        this.resolveStartup();
      },
      (error: unknown) => {
        this.started = true;
        this.startupFailed = true;
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

  /**
   * Whether startup is still under way, so which hooks the Mods bring is
   * unknown. False once the Mods load or fail, or the session fails to start.
   */
  get starting(): boolean {
    return !this.closing && !this.started;
  }

  /**
   * Whether the Mods themselves failed to load, so every prompt is refused.
   * A session that failed to start before loading them reports its own error
   * instead.
   */
  get failed(): boolean {
    return !this.closing && this.startupFailed;
  }

  failStartup(error: unknown): void {
    if (this.initialization) return;
    this.initialization = this.startup;
    this.started = true;
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

  /** Whether a loaded Mod hooks `prompt.submit`. */
  get hearsPrompts(): boolean {
    return !this.closing && this.session.hearsPrompts;
  }

  submitPrompt(
    text: string,
    signal: AbortSignal,
  ): Promise<{ text: string; context?: string[] } | { drop: string }> {
    return this.closing
      ? Promise.resolve({ text })
      : this.session.submitPrompt(text, signal);
  }

  /** Hears each prompt a Mod queues with `$.prompt.submit`. */
  readonly subscribePrompts = (listener: () => void): (() => void) => {
    this.promptListeners.add(listener);
    return () => this.promptListeners.delete(listener);
  };

  /** Whether a prompt a Mod submitted waits for the session to be idle. */
  get hasSubmittedPrompts(): boolean {
    return !this.closing && this.session.hasSubmittedPrompts;
  }

  /** The next prompt a Mod submitted, to run now as a turn of its own. */
  takeSubmittedPrompt(): ModQueuedPrompt | undefined {
    return this.closing ? undefined : this.session.takeSubmittedPrompt();
  }

  /** Puts back a prompt whose turn could not start. */
  returnSubmittedPrompt(prompt: ModQueuedPrompt): void {
    if (!this.closing) this.session.returnSubmittedPrompt(prompt);
  }

  /** The person sent a prompt, so the Mods' prompts may start turns again. */
  notePersonPrompt(): void {
    this.session.notePersonPrompt();
  }

  /**
   * The person stopped the running turn: drops the Mods' queued prompts and
   * refuses new ones until the person sends a prompt again.
   */
  stopSubmittedPrompts(): void {
    this.session.stopSubmittedPrompts();
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
        this.promptListeners.clear();
        if (sessions.get(this.config) === this) sessions.delete(this.config);
      }
    })();
    return this.closing;
  }
}
