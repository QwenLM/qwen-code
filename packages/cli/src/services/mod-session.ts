/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { OutputFormat } from '@qwen-code/qwen-code-core/output/types.js';
import {
  loadModSource,
  loadModDependencies,
} from '@qwen-code/qwen-code-core/mods/discovery.js';
import {
  orderModPlugins,
  resolveModDependency,
} from '@qwen-code/qwen-code-core/mods/dependencies.js';
import {
  resolveModOptions,
  resolveModToolDialect,
  resolveModUnsupportedEvents,
} from '@qwen-code/qwen-code-core/mods/options.js';
import { ModRuntime } from '@qwen-code/qwen-code-core/mods/runtime.js';
import {
  ENGINE_NODE,
  type ModRenderElement,
  type ModRenderInput,
  type ModRenderSite,
} from '@qwen-code/qwen-code-core/mods/render-tree.js';
import type { ModToolCall } from '@qwen-code/qwen-code-core/mods/tool-events.js';
import {
  MOD_END_TIMEOUT_MS,
  MOD_MAX_BYTES,
} from '@qwen-code/qwen-code-core/mods/types.js';
import type {
  ModCommandPresentation,
  ModLog,
  ModSessionFacts,
  ModTurnComplete,
  ModTurnStart,
  ModTurnUsage,
} from '@qwen-code/qwen-code-core/mods/types.js';
import { runOutsideAgentContext } from '@qwen-code/qwen-code-core/agents/runtime/agent-context.js';
import type { ChatRecordingService } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { stableJson } from '@qwen-code/qwen-code-core/services/execution-environment.js';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import {
  LlmEventType,
  type ServerLlmStreamEvent,
} from '@qwen-code/qwen-code-core/core/turn.js';
import {
  getGenAiUsageProvenance,
  outputTokenCount,
} from '@qwen-code/qwen-code-core/telemetry/gen-ai-usage.js';
import type { ApiResponseEvent } from '@qwen-code/qwen-code-core/telemetry/types.js';
import {
  EVENT_API_RESPONSE,
  uiTelemetryService,
} from '@qwen-code/qwen-code-core/telemetry/uiTelemetry.js';
import { isInternalPromptId } from '@qwen-code/qwen-code-core/utils/internalPromptIds.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';
import type { LoadedSettings } from '../config/settings.js';
import type { ICommandLoader } from '../services/types.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import {
  cpLen,
  cpSlice,
  sanitizeTerminalLine,
  sanitizeTerminalText,
  stripUnsafeCharacters,
} from '../ui/utils/textUtils.js';
import { registerCleanup } from '../utils/cleanup.js';
import { flushOutput } from '../utils/flush-output.js';
import { projectJsonStringToByteBudget } from '../utils/json-string-byte-projection.js';
import type { JsonOutputAdapterInterface } from '../nonInteractive/io/BaseJsonOutputAdapter.js';

const logger = createDebugLogger('MODS');

// A resize redraws the band once it has settled; renders otherwise run at
// Claude Code's rate for an expanded band, and at its steady rate for a second
// after one ran longer than that.
const RENDER_SETTLE_MS = 150;
const RENDER_LIVE_MS = 34;
const RENDER_STEADY_MS = 100;
const RENDER_SLOW_MS = 1_000;

export interface ModTerminalHost {
  surface: 'terminal';
  log(entry: ModLog, plugin: string, sessionId: string): void;
  presentation(): ModCommandPresentation;
  /** The render sites the terminal draws, read once at load. */
  sites?(): readonly ModRenderSite[];
  /** Draws the tree the band's hooks settled on, drawn by `owner`. */
  draw?(tree: ModRenderElement, owner: string): void;
}

type ModOutput =
  | Pick<JsonOutputAdapterInterface, 'emitSystemMessage'>
  | ModTerminalHost;

/**
 * A main-loop turn the Mods hear: `turn.start` once its prompt is admitted,
 * then its end. The host hands it every event of the turn's model streams.
 */
export interface ModTurn {
  readonly id: string;
  /** Reads one event: the answer, what the turn cost and whether it failed. */
  saw(event: ServerLlmStreamEvent): void;
  /**
   * Reports the end once and resolves after the `turn.complete` hooks ran.
   * Without `aborted` or `error`, the events say how the turn ended.
   */
  complete(ending?: 'aborted' | 'error'): Promise<void>;
}

interface RunningTurn {
  id: string;
  sessionId: string;
  startedAt: number;
  abort: () => boolean;
  aborting: boolean;
  // The response arriving now, and the last one that finished.
  streaming: string;
  answer: string;
  failed: boolean;
  usage?: Omit<ModTurnUsage, 'model'>;
  model?: string;
  // The host's prompt id for the turn's requests, when it has one.
  promptId?: string;
  // Its turn.complete dispatch, once the turn has ended.
  ended?: Promise<void>;
}

export class ModSession implements ICommandLoader {
  private readonly mods: Array<{
    id: string;
    name: string;
  }> = [];
  private runtime?: ModRuntime;
  private toolQueue: Promise<unknown> = Promise.resolve();
  private readonly lifetime = new AbortController();
  // A close cancels other hooks at once; a turn.complete that is running or
  // queued gets the end budget first.
  private readonly endLifetime = new AbortController();
  private initialization?: Promise<void>;
  private closing?: Promise<void>;
  private logsReady = false;
  private readonly pendingLogs: Array<
    // A turn.complete text is already cut to its own 4,096.
    ModLog & { plugin: string; sessionId: string; isTurnNote?: true }
  > = [];
  // Text mode prints the answer as the run ends; a turn's note goes beneath.
  private readonly notes: string[] = [];
  private activeCommand?: AbortController;
  private commandSignal?: AbortSignal;
  private toolSignal?: AbortSignal;
  private sessionId: string;
  // What `$.session` reports describes `sessionId`. The config switches first
  // on /clear and /resume, so these stay with the old session until its end.
  private adoptedAt = Date.now();
  private startedAt?: number;
  private recorder?: ChatRecordingService;
  private context = { tokens: 0, window: 0 };
  private turn?: RunningTurn;
  // Also runs on every API response, so a session that no hook saw still has
  // its figures when it ends. A subagent's response emits from inside its
  // agent frame, whose model would otherwise answer for the main session.
  private readonly observe = (update?: { event?: { 'event.name'?: string } }) =>
    runOutsideAgentContext(() => {
      if (this.config.getSessionId() !== this.sessionId) return;
      this.recorder = this.config.getChatRecordingService();
      this.context = {
        tokens: uiTelemetryService.getLastPromptTokenCount(),
        window: this.config.getContentGeneratorConfig()?.contextWindowSize || 0,
      };
      // A turn reports the model of its last main-conversation response.
      const event = update?.event;
      if (!this.turn || event?.['event.name'] !== EVENT_API_RESPONSE) return;
      const response = event as unknown as ApiResponseEvent;
      if (
        response.subagent_name === undefined &&
        !isInternalPromptId(response.prompt_id) &&
        // A concurrent /btw answers under a prompt id of its own.
        (this.turn.promptId === undefined ||
          response.prompt_id === this.turn.promptId)
      )
        this.turn.model = response.model;
    });
  private toolGeneration = new AbortController();
  // The render sites the terminal offered at load.
  private sites: readonly ModRenderSite[] = [];
  // The band's renders: the host's latest input, keyed as Claude Code keys
  // it, and the one render that may wait in the queue or run.
  private readonly band: {
    input?: ModRenderInput;
    key?: string;
    size?: string;
    settle?: ReturnType<typeof setTimeout>;
    wait?: ReturnType<typeof setTimeout>;
    state: 'idle' | 'waiting' | 'running';
    again: boolean;
    startedAt: number;
    steadyUntil: number;
  } = {
    state: 'idle',
    again: false,
    startedAt: -Infinity,
    steadyUntil: 0,
  };
  private unregisterCleanup: () => void;

  constructor(
    private readonly config: Config,
    private readonly output: ModOutput,
    private readonly optionScopes: readonly unknown[] = [],
  ) {
    this.sessionId = config.getSessionId();
    uiTelemetryService.on('update', this.observe);
    this.unregisterCleanup = registerCleanup(
      () => {
        // Exit cleanup iterates its registry; do not splice its current item.
        this.unregisterCleanup = () => {};
        // No result follows an exit, so a note of the turn it ended is due.
        return this.close().then(() => this.flushOutput());
      },
      { first: Boolean(this.terminal) },
    );
  }

  static create(
    config: Config,
    settings: LoadedSettings,
    output: ModOutput,
  ): ModSession | undefined {
    return settings.merged.experimental?.mods
      ? new ModSession(config, output, [
          settings.systemDefaults.settings.pluginConfigs,
          settings.user.settings.pluginConfigs,
          settings.system.settings.pluginConfigs,
        ])
      : undefined;
  }

  private get terminal(): ModTerminalHost | undefined {
    return 'surface' in this.output ? this.output : undefined;
  }

  private allowed(): boolean {
    return (
      this.config.isInteractive() === Boolean(this.terminal) &&
      !this.config.getExperimentalZedIntegration() &&
      this.config.isTrustedFolder() &&
      !this.config.getDisableAllHooks() &&
      !this.config.getBareMode() &&
      !this.config.isSafeMode() &&
      !this.config.getExecutionEnvironment() &&
      !this.config.getExecutionEnvironmentFactory() &&
      !this.config.getHookSystem()?.isManaged() &&
      !this.config.getSandbox() &&
      !this.config.isSessionAgentSession()
    );
  }

  async initialize(signal: AbortSignal): Promise<void> {
    if (this.closing) throw new Error('Mod session is closed.');
    if (!this.allowed()) {
      if (this.mods.length) {
        await this.close();
        throw new Error('Mods are no longer permitted in this session.');
      }
      return;
    }
    this.initialization ??= this.load(
      AbortSignal.any([signal, this.lifetime.signal]),
    );
    await this.initialization;
  }

  private async load(signal: AbortSignal): Promise<void> {
    const sites = (this.sites = this.terminal?.sites?.() ?? []);
    try {
      const candidates = [];
      for (const extension of this.config
        .getExtensions()
        .filter(
          (item) => item.isActive && item.format !== 'agent-plugins-v1',
        )) {
        signal.throwIfAborted();
        try {
          const source = await loadModSource(extension.path);
          const marketplace =
            extension.installMetadata?.marketplaceConfig?.name;
          candidates.push({
            extension,
            name: extension.name,
            version: extension.version,
            marketplace,
            source,
            dependencies: source?.dependencies ?? [],
            toolDialect: source
              ? resolveModToolDialect(
                  this.optionScopes,
                  extension.name,
                  marketplace,
                )
              : undefined,
            unsupportedEvents: source
              ? resolveModUnsupportedEvents(
                  this.optionScopes,
                  extension.name,
                  marketplace,
                )
              : undefined,
            options: source
              ? resolveModOptions(
                  source.userConfig,
                  this.optionScopes,
                  extension.name,
                  marketplace,
                )
              : {},
          });
        } catch (error) {
          throw new Error(
            `Mod ${extension.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const pending = candidates.filter((item) => item.source);
      const reachable = new Set<(typeof candidates)[number]>();
      while (pending.length) {
        signal.throwIfAborted();
        const plugin = pending.shift()!;
        if (reachable.has(plugin)) continue;
        reachable.add(plugin);
        if (!plugin.source) {
          try {
            plugin.dependencies = await loadModDependencies(
              plugin.extension.path,
            );
          } catch (error) {
            throw new Error(
              `Mod dependency ${plugin.name}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        for (const dependency of plugin.dependencies) {
          pending.push(resolveModDependency(candidates, plugin, dependency));
        }
      }
      const selected = candidates.filter((item) => reachable.has(item));
      orderModPlugins(selected);
      // Ordinary providers participate in preflight, not Mod registration order.
      const mods = selected
        .filter((item) => item.source)
        .map((plugin) => ({
          ...plugin,
          dependencies: plugin.dependencies.filter(
            (dependency) =>
              resolveModDependency(selected, plugin, dependency).source,
          ),
        }));
      const ordered = orderModPlugins(mods);
      if (ordered.length) {
        this.runtime = await ModRuntime.createGroup(
          ordered.map(
            ({
              extension,
              source,
              options,
              toolDialect,
              unsupportedEvents,
            }) => ({
              id: extension.id,
              name: extension.name,
              source: {
                root: source!.root,
                entry: source!.entry,
                source: source!.source,
              },
              options,
              toolDialect,
              unsupportedEvents,
            }),
          ),
          this.config.getTargetDir(),
          (entry, plugin) => {
            if (this.commandSignal?.aborted || this.toolSignal?.aborted) return;
            this.pendingLogs.push({
              ...entry,
              plugin,
              sessionId: this.sessionId,
            });
            if (this.logsReady) this.flushLogs();
          },
          signal,
          (name) => this.config.getToolRegistry().ensureTool(name),
          this.terminal?.surface ?? null,
          this.config.getCliVersion() || 'unknown',
          () => this.facts(),
          (turnId) => this.abortTurn(turnId),
          sites.length
            ? { sites, invalidate: () => this.requestRender() }
            : undefined,
        );
        this.mods.push(
          ...ordered.map(({ extension }) => ({
            id: extension.id,
            name: extension.name,
          })),
        );
        // The first render runs after session.start.
        this.requestRender();
      }
    } catch (error) {
      await this.runtime?.dispose();
      this.mods.length = 0;
      throw error;
    }
  }

  async loadCommands(signal: AbortSignal): Promise<SlashCommand[]> {
    await this.initialize(signal);
    return this.mods.flatMap((mod) =>
      this.runtime!.getCommands(mod.id).map(
        (command): SlashCommand => ({
          name: command.name,
          description: this.terminal
            ? sanitizeTerminalLine(command.description)
            : command.description,
          kind: CommandKind.FILE,
          source: 'plugin-command' as const,
          extensionName: this.terminal
            ? sanitizeTerminalLine(mod.name)
            : mod.name,
          supportedModes: [this.terminal ? 'interactive' : 'non_interactive'],
          argumentHint:
            this.terminal && command.argumentHint !== undefined
              ? sanitizeTerminalLine(command.argumentHint)
              : command.argumentHint,
          modelInvocable: false,
          action: async (context, args) => {
            const active = AbortSignal.any([
              context.abortSignal ??
                (this.terminal ? this.lifetime.signal : signal),
              this.lifetime.signal,
            ]);
            const task = this.toolQueue.then(async () => {
              active.throwIfAborted();
              if (!this.allowed() || !this.active() || this.closing) {
                await this.runtime!.dispose();
                throw new Error(
                  `Mod ${mod.name} is disabled or its middleware chain changed.`,
                );
              }
              if (this.sessionId !== this.config.getSessionId())
                throw new Error(
                  'The Mod command belongs to a previous session.',
                );
              const controller = new AbortController();
              this.activeCommand = controller;
              const commandSignal = AbortSignal.any([
                active,
                controller.signal,
              ]);
              this.commandSignal = commandSignal;
              try {
                const content = await this.runtime!.runCommand(
                  command.name,
                  args,
                  commandSignal,
                  this.terminal?.presentation(),
                );
                commandSignal.throwIfAborted();
                return {
                  type: 'message' as const,
                  messageType: 'info' as const,
                  content: this.terminal
                    ? sanitizeTerminalText(stripUnsafeCharacters(content))
                    : content,
                };
              } finally {
                this.flushLogs();
                this.activeCommand = undefined;
                this.commandSignal = undefined;
              }
            });
            this.toolQueue = task.catch(() => {});
            return task;
          },
        }),
      ),
    );
  }

  invalidateTools(): void {
    this.toolGeneration.abort();
    this.pendingLogs.length = 0;
    this.activeCommand?.abort();
  }

  async restoreTools(): Promise<void> {
    await this.toolQueue;
    if (!this.closing && this.sessionId === this.config.getSessionId()) {
      this.toolGeneration = new AbortController();
    }
  }

  captureToolSignal(): AbortSignal {
    return this.toolGeneration.signal;
  }

  async syncSession(reason: 'clear' | 'resume'): Promise<void> {
    const current = this.config.getSessionId();
    if (current === this.sessionId) {
      if (this.toolGeneration.signal.aborted)
        this.toolGeneration = new AbortController();
      return;
    }
    this.invalidateTools();
    const task = this.toolQueue.then(async () => {
      if (current === this.sessionId || this.closing) return;
      await this.end(reason);
      this.sessionId = current;
      this.adoptedAt = Date.now();
      this.startedAt = undefined;
      this.recorder = undefined;
      this.context = { tokens: 0, window: 0 };
      // The adopted session may end before any hook or API response reads it.
      this.capture();
      this.toolGeneration = new AbortController();
      // The band's facts may differ in the adopted session.
      this.requestRender();
    });
    this.toolQueue = task.catch(() => {});
    await task;
  }

  get hasToolHooks(): boolean {
    return this.runtime?.hasToolHooks === true;
  }

  /**
   * Reports the band's input. A change of its key renders, after a change of
   * width or of `maxRows` has settled; a change of height alone does not.
   */
  setRenderInput(input: ModRenderInput): void {
    const band = this.band;
    const key = [
      input.viewport?.columns,
      input.viewport?.isFullscreen,
      stableJson(input.props),
    ].join('\0');
    band.input = input;
    if (key === band.key) return;
    const size = `${input.viewport?.columns}\0${input.props.maxRows}`;
    const resized = band.size !== undefined && size !== band.size;
    band.key = key;
    band.size = size;
    if (resized) {
      clearTimeout(band.settle);
      band.settle = setTimeout(() => {
        band.settle = undefined;
        this.requestRender();
      }, RENDER_SETTLE_MS);
    } else this.requestRender();
  }

  // Renders fold: one waits in the queue and reads the latest input when it
  // runs. One that is running is never cancelled, since a cancel the worker
  // cannot settle ends every Mod; a newer request runs after it.
  private requestRender(): void {
    const band = this.band;
    if (
      this.closing ||
      !band.input ||
      !this.sites.includes(band.input.component) ||
      band.settle ||
      band.wait ||
      !this.runtime?.renderHooks.length ||
      band.state === 'waiting'
    )
      return;
    if (band.state === 'running') {
      band.again = true;
      return;
    }
    const now = Date.now();
    const gap =
      (now < band.steadyUntil ? RENDER_STEADY_MS : RENDER_LIVE_MS) -
      (now - band.startedAt);
    if (gap > 0) {
      band.wait = setTimeout(() => {
        band.wait = undefined;
        this.requestRender();
      }, gap);
      return;
    }
    band.state = 'waiting';
    // A render that fails, even in drawing its fallback, leaves the queue to
    // the hooks behind it.
    this.toolQueue = this.toolQueue
      .then(() => this.render())
      .catch((error) => logger.debug(`Mod ui.render: ${String(error)}`));
  }

  private async render(): Promise<void> {
    const band = this.band;
    const runtime = this.runtime!;
    const owner =
      runtime.renderHooks.length === 1 ? runtime.renderHooks[0] : 'hooks';
    band.state = 'running';
    band.startedAt = Date.now();
    try {
      // A switch in progress renders once it is done.
      if (this.closing || this.sessionId !== this.config.getSessionId()) return;
      if (!this.allowed() || !this.active()) {
        this.terminal?.draw?.(ENGINE_NODE, owner);
        return;
      }
      const { tree, notes } = await runtime.render(
        band.input!,
        this.lifetime.signal,
      );
      for (const note of notes) logger.debug(note);
      if (!this.closing) this.terminal?.draw?.(tree, owner);
    } catch (error) {
      // The worker has failed or closed; the band draws nothing.
      logger.debug(`Mod ui.render: ${String(error)}`);
      if (!this.closing) this.terminal?.draw?.(ENGINE_NODE, owner);
    } finally {
      if (Date.now() - band.startedAt > RENDER_LIVE_MS)
        band.steadyUntil = Date.now() + RENDER_SLOW_MS;
      band.state = 'idle';
      if (band.again) {
        band.again = false;
        this.requestRender();
      }
      this.flushLogs();
    }
  }

  toolCall(onRepeat: () => void): ModToolCall | undefined {
    if (!this.hasToolHooks) return undefined;
    return (input, next, signal) => {
      const generation = this.toolGeneration;
      const sessionId = this.sessionId;
      const active = AbortSignal.any([
        signal,
        this.lifetime.signal,
        generation.signal,
      ]);
      const assertAllowed = () => {
        active.throwIfAborted();
        if (
          generation !== this.toolGeneration ||
          sessionId !== this.config.getSessionId() ||
          !this.allowed() ||
          !this.active() ||
          this.closing
        )
          throw new Error(
            'Mod tool middleware is disabled or its chain changed.',
          );
      };
      const task = this.toolQueue.then(async () => {
        assertAllowed();
        let attempts = 0;
        this.toolSignal = active;
        try {
          return await this.runtime!.runTool(
            input,
            async (changed, hostSignal, check) => {
              assertAllowed();
              if (attempts++) onRepeat();
              active.throwIfAborted();
              return next(
                changed,
                hostSignal,
                async (question, verdict, checkSignal) => {
                  assertAllowed();
                  const result = await check(question, verdict, checkSignal);
                  assertAllowed();
                  checkSignal.throwIfAborted();
                  return result;
                },
              );
            },
            active,
          );
        } finally {
          if (this.toolSignal === active) this.toolSignal = undefined;
        }
      });
      this.toolQueue = task.catch(() => {});
      return task;
    };
  }

  /**
   * Starts a main-loop turn once its prompt is admitted, before its first
   * model request. `signal` is the turn's own: cancelling the turn ends its
   * `turn.start` hooks too. `abort` ends the turn as a cancel does, without
   * the notice a person's cancel leaves, and returns whether it did;
   * `$.turn.abort` calls it. `promptId`, the id the turn's requests carry,
   * keeps another prompt's response from naming the turn's model.
   */
  startTurn(
    text: string,
    signal: AbortSignal,
    abort: () => boolean,
    promptId?: string,
  ): ModTurn | undefined {
    const hooks = this.runtime?.turnHooks;
    if (!hooks || (!hooks.start && !hooks.complete.length) || this.closing)
      return undefined;
    const turn: RunningTurn = {
      id: randomUUID(),
      sessionId: this.sessionId,
      startedAt: Date.now(),
      abort,
      aborting: false,
      streaming: '',
      answer: '',
      failed: false,
      ...(promptId !== undefined && { promptId }),
    };
    this.turn = turn;
    // The model request does not wait for these hooks; the turn's tool calls
    // and its end queue behind them.
    if (hooks.start) {
      const fitted = fitTurnText(text);
      const input: ModTurnStart = {
        text: fitted.text,
        turnId: turn.id,
        ...(fitted.truncated && { isTextTruncated: true as const }),
      };
      void this.queueTurnEvent(turn, (lifetime) =>
        this.runtime!.startTurn(input, AbortSignal.any([lifetime, signal])),
      );
    }
    let ending: Promise<void> | undefined;
    return {
      id: turn.id,
      saw: (event) => this.see(turn, event),
      complete: (reason) => (ending ??= this.completeTurn(turn, reason)),
    };
  }

  private see(turn: RunningTurn, event: ServerLlmStreamEvent): void {
    // Only a turn.complete reads what the turn streamed.
    if (turn.ended || !this.runtime?.turnHooks.complete.length) return;
    switch (event.type) {
      case LlmEventType.Content:
        turn.streaming += event.value;
        break;
      case LlmEventType.Finished:
        turn.answer = turn.streaming;
        turn.streaming = '';
        turn.usage = addTurnUsage(
          turn.usage,
          event.value.usageMetadata,
          this.config.getContentGeneratorConfig()?.authType,
        );
        break;
      case LlmEventType.Retry:
        // A fresh attempt replaces what the failed one streamed. A
        // continuation appends, also to a response MAX_TOKENS finished.
        if (!event.isContinuation) turn.streaming = '';
        else if (!turn.streaming) turn.streaming = turn.answer;
        break;
      case LlmEventType.ModelFallback:
        turn.streaming = '';
        break;
      case LlmEventType.Error:
      case LlmEventType.LoopDetected:
      case LlmEventType.MaxSessionTurns:
      case LlmEventType.SessionTokenLimitExceeded:
        turn.failed = true;
        break;
      default:
        break;
    }
  }

  private completeTurn(
    turn: RunningTurn,
    ending?: 'aborted' | 'error',
  ): Promise<void> {
    if (turn.ended) return turn.ended;
    if (this.turn === turn) this.turn = undefined;
    const plugins = this.runtime?.turnHooks.complete ?? [];
    if (!plugins.length) return Promise.resolve();
    const reason =
      turn.aborting || ending === 'aborted'
        ? 'aborted'
        : ending === 'error' || turn.failed
          ? 'error'
          : 'answer';
    const answer = fitTurnText((turn.streaming || turn.answer).trim());
    const input: ModTurnComplete = {
      answer: answer.text,
      durationMs: Date.now() - turn.startedAt,
      isAborted: reason === 'aborted',
      turnId: turn.id,
      reason,
      ...(turn.usage
        ? {
            usage: {
              ...turn.usage,
              model:
                turn.model ??
                runOutsideAgentContext(() => this.config.getModel()),
            },
          }
        : {}),
      ...(answer.truncated && { isAnswerTruncated: true as const }),
    };
    const run = async (signal: AbortSignal) => {
      const text = await this.runtime!.completeTurn(input, signal);
      // A different text is shown beneath the answer; the record keeps it.
      if (text === input.answer || !text.trim()) return;
      const note = {
        text: cpLen(text) > 4096 ? `${cpSlice(text, 0, 4096)}…` : text,
        to: 'transcript' as const,
        plugin: plugins.join('+'),
        sessionId: turn.sessionId,
        isTurnNote: true as const,
      };
      if (!this.terminal && this.config.getOutputFormat() === OutputFormat.TEXT)
        this.notes.push(
          `[Mod ${note.plugin}] ${stripAnsiAndControl(note.text)}`,
        );
      else this.pendingLogs.push(note);
    };
    return (turn.ended = this.queueTurnEvent(turn, run, true));
  }

  private queueTurnEvent(
    turn: RunningTurn,
    run: (signal: AbortSignal) => Promise<void>,
    isEnd = false,
  ): Promise<void> {
    const task = this.toolQueue
      .then(async () => {
        if (
          (this.closing && !isEnd) ||
          turn.sessionId !== this.sessionId ||
          !this.allowed() ||
          !this.active()
        )
          return;
        try {
          await run(isEnd ? this.endLifetime.signal : this.lifetime.signal);
        } finally {
          this.flushLogs();
        }
      })
      // A failing hook leaves the turn and its answer as they were.
      .catch((error) => logger.debug(`Mod turn event: ${String(error)}`));
    this.toolQueue = task;
    return task;
  }

  // The host owns the running turn, so the id is judged here.
  private abortTurn(turnId: string): void {
    const turn = this.turn;
    if (!turn)
      throw new Error(`$.turn.abort: no turn is running (asked for ${turnId})`);
    if (turn.id !== turnId)
      throw new Error(
        `$.turn.abort: ${turnId} is not the running turn (${turn.id}); a hook ends the turn turn.start told it about`,
      );
    if (turn.aborting)
      throw new Error(`$.turn.abort: ${turnId} is already ending`);
    turn.aborting = true;
    let cancelled = false;
    try {
      cancelled = turn.abort();
    } finally {
      // A turn the host finds already over or cancelled, or fails to cancel,
      // is not the Mod's end.
      turn.aborting = cancelled;
    }
    if (!cancelled)
      throw new Error(`$.turn.abort: ${turnId} is already ending`);
    logger.debug(`$.turn.abort: cancelled turn ${turnId}`);
  }

  flushLogs(): void {
    this.logsReady = true;
    for (const entry of this.pendingLogs.splice(0)) {
      logger.debug(`[${entry.plugin}] ${entry.text}`);
      if (entry.to === 'debug') continue;
      const text = this.terminal
        ? sanitizeTerminalText(stripUnsafeCharacters(entry.text))
        : stripAnsiAndControl(entry.text);
      if ('surface' in this.output) {
        const { isTurnNote, ...log } = entry;
        this.output.log(
          { ...log, text: isTurnNote ? text : cpSlice(text, 0, 2000) },
          entry.plugin,
          entry.sessionId,
        );
      } else if (this.config.getOutputFormat() === OutputFormat.TEXT) {
        process.stderr.write(`[Mod ${entry.plugin}] ${text}\n`);
      } else {
        this.output.emitSystemMessage('ui_log', {
          plugin: entry.plugin,
          text,
        });
      }
    }
  }

  async flushOutput(): Promise<void> {
    // The answer on stdout drains first, so a note lands beneath it.
    if (this.notes.length && !this.terminal)
      await flushOutput(process.stdout, AbortSignal.timeout(1_500));
    for (const note of this.notes.splice(0)) process.stderr.write(`${note}\n`);
    await this.flushStreams();
  }

  private async flushStreams(): Promise<void> {
    if (this.terminal) return;
    const signal = AbortSignal.timeout(1_500);
    await Promise.allSettled([
      flushOutput(process.stdout, signal),
      flushOutput(process.stderr, signal),
    ]);
  }

  private capture(): number {
    this.observe();
    if (this.startedAt !== undefined) return this.startedAt;
    // A resumed session began at its first record; a new one when adopted.
    const resumed = this.config.getResumedSessionData()?.conversation;
    const first =
      resumed?.sessionId === this.sessionId
        ? Date.parse(resumed.startTime)
        : NaN;
    return (this.startedAt = Number.isFinite(first) ? first : this.adoptedAt);
  }

  // The main session's facts, even when a dispatch starts in an agent frame.
  private facts(): ModSessionFacts {
    return runOutsideAgentContext(() => this.readFacts());
  }

  private readFacts(): ModSessionFacts {
    const startedAt = this.capture();
    const { tokens, window } = this.context;
    return {
      id: this.sessionId,
      cwd: this.config.getTargetDir(),
      root: this.config.getProjectRoot(),
      model: this.config.getModel(),
      turns: this.recorder?.getUserTurnCount() ?? 0,
      usage: {
        startedAt,
        context: {
          tokens,
          window,
          ...(window > 0
            ? { percent: Math.min(100, Math.round((tokens / window) * 100)) }
            : {}),
        },
        rateLimits: [],
      },
    };
  }

  private active(): boolean {
    const extensions = this.config.getExtensions();
    return this.mods.every((mod) =>
      extensions.some(
        (extension) => extension.id === mod.id && extension.isActive,
      ),
    );
  }

  private async end(reason: 'clear' | 'resume' | 'other'): Promise<void> {
    if (!this.allowed() || !this.active()) return;
    try {
      await this.runtime?.end(
        this.sessionId,
        reason,
        AbortSignal.timeout(MOD_END_TIMEOUT_MS),
      );
    } catch (error) {
      logger.warn(`Mod session.end: ${String(error)}`);
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.unregisterCleanup();
      uiTelemetryService.off('update', this.observe);
      clearTimeout(this.band.settle);
      clearTimeout(this.band.wait);
      // A turn the close cuts short ends as aborted. Its end and every end
      // already queued run in order before session.end, within one budget.
      if (this.turn) void this.completeTurn(this.turn, 'aborted');
      const endBudget = setTimeout(
        () => this.endLifetime.abort(),
        MOD_END_TIMEOUT_MS,
      );
      this.lifetime.abort();
      this.invalidateTools();
      await this.initialization?.catch(() => {});
      try {
        await this.toolQueue;
        clearTimeout(endBudget);
        await this.end('other');
      } finally {
        clearTimeout(endBudget);
        this.endLifetime.abort();
        this.lifetime.abort();
        await this.runtime?.dispose();
        await this.flushStreams();
      }
    })();
    return this.closing;
  }
}

// A provider's count as the Mods take it: a whole number, or 0 when it is
// missing or not a count at all.
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

// The API's four counts. Cache writes are known only where the provider
// reports them apart, as Anthropic's does.
function addTurnUsage(
  usage: RunningTurn['usage'],
  metadata: GenerateContentResponseUsageMetadata | undefined,
  authType: string | undefined,
): RunningTurn['usage'] {
  if (!metadata) return usage;
  const prompt = tokenCount(metadata.promptTokenCount);
  const read = tokenCount(metadata.cachedContentTokenCount);
  const written = tokenCount(
    getGenAiUsageProvenance(metadata)?.cacheCreationInputTokens,
  );
  // Counted as the session's billable output counts it.
  const output = outputTokenCount(
    {
      input: prompt,
      output: tokenCount(metadata.candidatesTokenCount),
      thoughts: tokenCount(metadata.thoughtsTokenCount),
      total: tokenCount(metadata.totalTokenCount),
    },
    authType,
  );
  return {
    input_tokens:
      (usage?.input_tokens ?? 0) + Math.max(0, prompt - read - written),
    output_tokens: (usage?.output_tokens ?? 0) + output,
    cache_read_input_tokens: (usage?.cache_read_input_tokens ?? 0) + read,
    cache_creation_input_tokens:
      (usage?.cache_creation_input_tokens ?? 0) + written,
  };
}

// A text too long for a Mod payload keeps its head and tail around a marker,
// as tool results do on the headless and ACP transports.
function fitTurnText(text: string): { text: string; truncated: boolean } {
  const fitted = projectJsonStringToByteBudget(
    text,
    MOD_MAX_BYTES / 2,
    '\n[... truncated for Mods ...]\n',
  );
  return { text: fitted, truncated: fitted !== text };
}
