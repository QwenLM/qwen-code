/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { OutputFormat } from '@qwen-code/qwen-code-core/output/types.js';
import { loadModSource } from '@qwen-code/qwen-code-core/mods/discovery.js';
import { ModRuntime } from '@qwen-code/qwen-code-core/mods/runtime.js';
import { MOD_END_TIMEOUT_MS } from '@qwen-code/qwen-code-core/mods/types.js';
import type { ModLog } from '@qwen-code/qwen-code-core/mods/types.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';
import type { LoadedSettings } from '../config/settings.js';
import type { ICommandLoader } from '../services/types.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import { registerCleanup } from '../utils/cleanup.js';
import { flushOutput } from '../utils/flush-output.js';
import type { JsonOutputAdapterInterface } from './io/BaseJsonOutputAdapter.js';

const logger = createDebugLogger('MODS');

export class ModSession implements ICommandLoader {
  private readonly mods: Array<{
    id: string;
    name: string;
    runtime: ModRuntime;
  }> = [];
  private readonly lifetime = new AbortController();
  private initialization?: Promise<void>;
  private closing?: Promise<void>;
  private initialized = false;
  private logsReady = false;
  private readonly pendingLogs: Array<ModLog & { plugin: string }> = [];
  private sessionId: string;
  private unregisterCleanup: () => void;

  constructor(
    private readonly config: Config,
    private readonly adapter: JsonOutputAdapterInterface,
  ) {
    this.sessionId = config.getSessionId();
    this.unregisterCleanup = registerCleanup(() => {
      // Exit cleanup iterates its registry; do not splice its current item.
      this.unregisterCleanup = () => {};
      return this.close();
    });
  }

  static create(
    config: Config,
    settings: LoadedSettings,
    adapter: JsonOutputAdapterInterface,
  ): ModSession | undefined {
    return settings.merged.experimental?.mods
      ? new ModSession(config, adapter)
      : undefined;
  }

  private allowed(): boolean {
    return (
      !this.config.isInteractive() &&
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
      for (const extension of this.config
        .getExtensions()
        .filter(
          (item) => item.isActive && item.format !== 'agent-plugins-v1',
        )) {
        signal.throwIfAborted();
        try {
          const source = await loadModSource(extension.path);
          if (source === undefined) continue;
          const runtime = await ModRuntime.create(
            source,
            this.config.getTargetDir(),
            (entry) => {
              this.pendingLogs.push({ ...entry, plugin: extension.name });
              if (this.logsReady) this.flushLogs();
            },
            signal,
          );
          this.mods.push({ id: extension.id, name: extension.name, runtime });
        } catch (error) {
          throw new Error(
            `Mod ${extension.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      this.initialized = true;
    } catch (error) {
      await Promise.all(this.mods.map((mod) => mod.runtime.dispose()));
      this.mods.length = 0;
      throw error;
    }
  }

  async loadCommands(signal: AbortSignal): Promise<SlashCommand[]> {
    await this.initialize(signal);
    return this.mods.flatMap((mod) =>
      mod.runtime.getCommands().map(
        (command): SlashCommand => ({
          name: command.name,
          description: command.description,
          kind: CommandKind.FILE,
          source: 'plugin-command' as const,
          extensionName: mod.name,
          supportedModes: ['non_interactive'],
          argumentHint: command.argumentHint,
          modelInvocable: false,
          action: async (_context, args) => {
            const active = this.config
              .getExtensions()
              .some(
                (extension) => extension.id === mod.id && extension.isActive,
              );
            if (!this.allowed() || !active || this.closing) {
              await mod.runtime.dispose();
              throw new Error(`Mod ${mod.name} is disabled.`);
            }
            return {
              type: 'message' as const,
              messageType: 'info' as const,
              content: await mod.runtime.runCommand(command.name, args, signal),
            };
          },
        }),
      ),
    );
  }

  async syncSession(reason: 'clear' | 'resume'): Promise<void> {
    const current = this.config.getSessionId();
    if (current === this.sessionId) return;
    await this.end(reason);
    this.sessionId = current;
  }

  flushLogs(): void {
    this.logsReady = true;
    for (const entry of this.pendingLogs.splice(0)) {
      logger.debug(`[${entry.plugin}] ${entry.text}`);
      if (entry.to === 'debug') continue;
      const text = stripAnsiAndControl(entry.text);
      if (this.config.getOutputFormat() === OutputFormat.TEXT) {
        process.stderr.write(`[Mod ${entry.plugin}] ${text}\n`);
      } else {
        this.adapter.emitSystemMessage('ui_log', {
          plugin: entry.plugin,
          text,
        });
      }
    }
  }

  async flushOutput(): Promise<void> {
    const signal = AbortSignal.timeout(1_500);
    await Promise.allSettled([
      flushOutput(process.stdout, signal),
      flushOutput(process.stderr, signal),
    ]);
  }

  private async end(reason: 'clear' | 'resume' | 'other'): Promise<void> {
    const signal = AbortSignal.timeout(MOD_END_TIMEOUT_MS);
    for (const mod of this.mods) {
      try {
        await mod.runtime.end(this.sessionId, reason, signal);
      } catch (error) {
        logger.warn(`Mod ${mod.name} session.end: ${String(error)}`);
      }
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.unregisterCleanup();
      if (!this.initialized) this.lifetime.abort();
      await this.initialization?.catch(() => {});
      try {
        await this.end('other');
      } finally {
        this.lifetime.abort();
        await Promise.all(this.mods.map((mod) => mod.runtime.dispose()));
        await this.flushOutput();
      }
    })();
    return this.closing;
  }
}
