/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
import type { ModToolCall } from '@qwen-code/qwen-code-core/mods/tool-events.js';
import { MOD_END_TIMEOUT_MS } from '@qwen-code/qwen-code-core/mods/types.js';
import type {
  ModCommandPresentation,
  ModLog,
  ModSessionFacts,
} from '@qwen-code/qwen-code-core/mods/types.js';
import { runOutsideAgentContext } from '@qwen-code/qwen-code-core/agents/runtime/agent-context.js';
import type { ChatRecordingService } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { uiTelemetryService } from '@qwen-code/qwen-code-core/telemetry/uiTelemetry.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';
import type { LoadedSettings } from '../config/settings.js';
import type { ICommandLoader } from '../services/types.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import {
  sanitizeTerminalLine,
  sanitizeTerminalText,
  stripUnsafeCharacters,
} from '../ui/utils/textUtils.js';
import { registerCleanup } from '../utils/cleanup.js';
import { flushOutput } from '../utils/flush-output.js';
import type { JsonOutputAdapterInterface } from '../nonInteractive/io/BaseJsonOutputAdapter.js';

const logger = createDebugLogger('MODS');

export interface ModTerminalHost {
  surface: 'terminal';
  log(entry: ModLog, plugin: string, sessionId: string): void;
  presentation(): ModCommandPresentation;
}

type ModOutput =
  | Pick<JsonOutputAdapterInterface, 'emitSystemMessage'>
  | ModTerminalHost;

export class ModSession implements ICommandLoader {
  private readonly mods: Array<{
    id: string;
    name: string;
  }> = [];
  private runtime?: ModRuntime;
  private toolQueue: Promise<unknown> = Promise.resolve();
  private readonly lifetime = new AbortController();
  private initialization?: Promise<void>;
  private closing?: Promise<void>;
  private logsReady = false;
  private readonly pendingLogs: Array<
    ModLog & { plugin: string; sessionId: string }
  > = [];
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
  // Also runs on every API response, so a session that no hook saw still has
  // its figures when it ends. A subagent's response emits from inside its
  // agent frame, whose model would otherwise answer for the main session.
  private readonly observe = () =>
    runOutsideAgentContext(() => {
      if (this.config.getSessionId() !== this.sessionId) return;
      this.recorder = this.config.getChatRecordingService();
      this.context = {
        tokens: uiTelemetryService.getLastPromptTokenCount(),
        window: this.config.getContentGeneratorConfig()?.contextWindowSize || 0,
      };
    });
  private toolGeneration = new AbortController();
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
        return this.close();
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
        );
        this.mods.push(
          ...ordered.map(({ extension }) => ({
            id: extension.id,
            name: extension.name,
          })),
        );
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
    });
    this.toolQueue = task.catch(() => {});
    await task;
  }

  get hasToolHooks(): boolean {
    return this.runtime?.hasToolHooks === true;
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

  flushLogs(): void {
    this.logsReady = true;
    for (const entry of this.pendingLogs.splice(0)) {
      logger.debug(`[${entry.plugin}] ${entry.text}`);
      if (entry.to === 'debug') continue;
      const text = this.terminal
        ? sanitizeTerminalText(stripUnsafeCharacters(entry.text))
        : stripAnsiAndControl(entry.text);
      if ('surface' in this.output) {
        this.output.log(
          { ...entry, text: text.slice(0, 2000) },
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
      this.lifetime.abort();
      this.invalidateTools();
      await this.initialization?.catch(() => {});
      try {
        await this.toolQueue;
        await this.end('other');
      } finally {
        this.lifetime.abort();
        await this.runtime?.dispose();
        await this.flushOutput();
      }
    })();
    return this.closing;
  }
}
