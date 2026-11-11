/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LocalAgentDefinition } from '../agents/types.js';
import type { OutputStyleConfig } from '../prompts/outputStyles/types.js';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import { raceWithAbortSignal } from '../utils/abort-race.js';
import { startupProfiler } from '../utils/startupProfiler.js';
import type {
  BuiltinPlugin,
  BuiltinPluginContext,
  BuiltinPluginSessionContext,
  BuiltinPluginSkillDefinition,
  BuiltinHookDefinition,
} from './types.js';

import { collectToolCheckers } from './index.js';
import type { HostToolChecker } from '../tools/tool-checkers/rule-precedence.js';

export class BuiltinPluginRegistry {
  private readonly toolCheckers: ReadonlyMap<string, HostToolChecker>;

  /** 静态权限检查器在 Main 创建时收集，不需要启动插件。 */
  getToolCheckers(): ReadonlyMap<string, HostToolChecker> {
    if (this.disposed) throw new Error('Builtin plugins are disposed');
    return new Map(this.toolCheckers);
  }

  private initialization: Promise<void> | undefined;
  private ready = false;
  private readonly initialized: BuiltinPlugin[] = [];
  private readonly listeners = new Set<() => void | Promise<void>>();
  private readonly hostReady: Promise<void>;
  private resolveHostReady!: () => void;
  private rejectHostReady!: (reason: unknown) => void;
  private disposal?: Promise<void>;
  private pluginsDisposal?: Promise<void>;
  private disposed = false;
  private readonly context: BuiltinPluginContext;

  constructor(
    private readonly plugins: readonly BuiltinPlugin[],
    context: Omit<BuiltinPluginContext, 'notifyChanged' | 'whenReady'> &
      Partial<Pick<BuiltinPluginContext, 'notifyChanged' | 'whenReady'>>,
  ) {
    this.toolCheckers = collectToolCheckers(plugins);
    this.hostReady = new Promise<void>((resolve, reject) => {
      this.resolveHostReady = resolve;
      this.rejectHostReady = reject;
    });
    void this.hostReady.catch(() => {});
    this.context = {
      ...context,
      get mode() {
        return context.mode;
      },
      get localSession() {
        return context.localSession ?? false;
      },
      // 许可与变化通知属于整个应用，不捕获任何会话的 Config。
      whenReady: async () => {
        context.signal?.throwIfAborted();
        await raceWithAbortSignal(this.hostReady, context.signal);
      },
      notifyChanged: () => this.notifyChanged(),
    };
  }

  markHostReady(): void {
    if (this.disposed || this.context.signal?.aborted) return;
    this.resolveHostReady();
  }

  subscribeChanged(listener: () => void | Promise<void>): () => void {
    if (this.disposed) throw new Error('Builtin plugins are disposed');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async notifyChanged(): Promise<void> {
    if (this.disposed) return;
    const results = await Promise.allSettled(
      [...this.listeners].map((listener) => Promise.resolve().then(listener)),
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, 'Builtin plugin refresh failed');
  }

  initialize(): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error('Builtin plugins are disposed'));
    this.initialization ??= startupProfiler.traceAsync(
      'builtin_plugins.initialize',
      () => this.initializePlugins(),
      { mode: this.context.mode },
    );
    return this.initialization;
  }

  private async initializePlugins(): Promise<void> {
    const ids = new Set<string>();
    for (const plugin of this.plugins) {
      if (
        !plugin ||
        plugin.apiVersion !== 1 ||
        typeof plugin.id !== 'string' ||
        !plugin.id ||
        ids.has(plugin.id) ||
        typeof plugin.initialize !== 'function' ||
        typeof plugin.dispose !== 'function'
      ) {
        throw new Error(`Invalid or duplicate builtin plugin: ${plugin?.id}`);
      }
      ids.add(plugin.id);
    }

    try {
      for (const plugin of this.plugins) {
        if (this.disposed) throw new Error('Builtin plugins are disposed');
        this.context.signal?.throwIfAborted();
        this.initialized.push(plugin);
        await startupProfiler.traceAsync(
          `builtin_plugin.${plugin.id}.initialize`,
          () => plugin.initialize(this.context),
          { mode: this.context.mode },
        );
      }
    } catch (error) {
      await this.disposePlugins().catch(() => {});
      throw error;
    }
    if (this.disposed)
      throw new Error('Builtin plugins were disposed during initialization');
    this.context.signal?.throwIfAborted();
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  getSkillDefinitions(
    context?: BuiltinPluginSessionContext,
  ): readonly BuiltinPluginSkillDefinition[] {
    this.assertReady();
    return this.plugins.flatMap((plugin) => {
      const skills = plugin.getSkillDefinitions?.(context);
      if (skills === undefined) return [];
      if (!Array.isArray(skills))
        throw new Error(`Invalid builtin plugin skills: ${plugin.id}`);
      return skills;
    });
  }

  getAgentDefinitions(): readonly LocalAgentDefinition[] {
    this.assertReady();
    return this.plugins.flatMap((plugin) => {
      const agents = plugin.getAgentDefinitions?.();
      if (agents === undefined) return [];
      if (!Array.isArray(agents))
        throw new Error(`Invalid builtin plugin agents: ${plugin.id}`);
      return agents;
    });
  }

  getOutputStyleDefinitions(): readonly OutputStyleConfig[] {
    this.assertReady();
    return this.plugins.flatMap((plugin) => {
      const styles = plugin.getOutputStyleDefinitions?.();
      if (styles === undefined) return [];
      if (!Array.isArray(styles))
        throw new Error(`Invalid builtin plugin output styles: ${plugin.id}`);
      return styles;
    });
  }

  getHooks(
    context?: BuiltinPluginSessionContext,
  ): readonly BuiltinHookDefinition[] {
    this.assertReady();
    return this.plugins.flatMap((plugin) => {
      const hooks = plugin.getHooks?.(context);
      if (hooks === undefined) return [];
      if (!Array.isArray(hooks))
        throw new Error(`Invalid builtin plugin hooks: ${plugin.id}`);
      return hooks;
    });
  }

  getTools(): readonly AnyDeclarativeTool[] {
    this.assertReady();
    return this.plugins.flatMap((plugin) => plugin.getTools?.() ?? []);
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce();
    return this.disposal;
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true;
    this.ready = false;
    this.rejectHostReady(new Error('Builtin plugins are disposed'));
    this.listeners.clear();
    // 在途 initialize 可能仍会创建业务资源，等它收口后再释放，避免关闭后复活。
    await this.initialization?.catch(() => {});
    await this.disposePlugins();
  }

  private disposePlugins(): Promise<void> {
    this.pluginsDisposal ??= this.disposeInitializedPlugins();
    return this.pluginsDisposal;
  }

  private async disposeInitializedPlugins(): Promise<void> {
    const results = await Promise.allSettled(
      this.initialized
        .splice(0)
        .reverse()
        .map((plugin) => plugin.dispose()),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private assertReady(): void {
    if (!this.ready) throw new Error('Builtin plugins are not initialized');
  }
}

/** 同一个 Registry 的读取、订阅及宿主就绪通知能力，不另外创建包装对象。 */
export type BuiltinPluginContributions = Pick<
  BuiltinPluginRegistry,
  | 'getToolCheckers'
  | 'markHostReady'
  | 'isReady'
  | 'getTools'
  | 'getHooks'
  | 'getSkillDefinitions'
  | 'getAgentDefinitions'
  | 'getOutputStyleDefinitions'
  | 'subscribeChanged'
>;
