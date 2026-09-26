/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath } from 'node:fs/promises';
import {
  deriveAgentConfig,
  deriveConfig,
  type Config,
} from '@qwen-code/qwen-code-core/config/config.js';
import { ManagedToolFileHistory } from '@qwen-code/qwen-code-core/tools/managed-tool-file-history.js';
import type { ManagedToolFileHistoryBinding } from '@qwen-code/qwen-code-core/tools/managed-tool-file-history-protocol.js';
import {
  managedToolDigest,
  ManagedToolProtocolError,
} from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';

interface Binding {
  digest: string;
  ownerRuntimeSessionId: string;
  owner: ManagedToolFileHistory;
  toolConfig: Config;
}

/** Shared backup ownership is separate from each Runtime's execution identity. */
export class ManagedToolFileHistorySessions {
  private readonly bindings = new Map<Config, Binding>();
  private readonly pending = new Map<
    Config,
    { digest: string; promise: Promise<Binding> }
  >();
  private readonly owners = new Map<string, Config>();

  get(config: Config): Binding | undefined {
    return this.bindings.get(config);
  }

  bind(
    config: Config,
    input: ManagedToolFileHistoryBinding,
    findConfig: (sessionId: string) => Config | undefined,
    assertAvailable: (config: Config) => void,
  ): Promise<Binding> {
    const digest = managedToolDigest(input, 8 * 1024 * 1024);
    input = structuredClone(input);
    const previous = this.bindings.get(config);
    const pending = this.pending.get(config);
    if (
      (previous && previous.digest !== digest) ||
      (pending && pending.digest !== digest)
    )
      return Promise.reject(
        new ManagedToolProtocolError('Managed file history binding changed.'),
      );
    if (previous) {
      assertAvailable(config);
      return Promise.resolve(previous);
    }
    if (pending) return pending.promise;
    const promise = (async () => {
      assertAvailable(config);
      if ((await realpath(input.executionCwd)) !== input.executionCwd)
        throw new ManagedToolProtocolError(
          'Managed execution directory is not canonical.',
        );
      const context = input.executionContext;
      if (context) {
        for (const directory of context.workspaceDirectories) {
          if ((await realpath(directory)) !== directory)
            throw new ManagedToolProtocolError(
              'Managed search directory is not canonical.',
            );
        }
      }
      assertAvailable(config);
      let owner: ManagedToolFileHistory;
      if (config.getSessionId() === input.ownerRuntimeSessionId) {
        if (input.executionCwd !== config.getTargetDir())
          throw new ManagedToolProtocolError(
            'Managed root execution directory changed.',
          );
        if (
          this.owners.has(input.ownerSessionId) &&
          this.owners.get(input.ownerSessionId) !== config
        )
          throw new ManagedToolProtocolError(
            'Managed file history owner is already bound.',
          );
        this.owners.set(input.ownerSessionId, config);
        owner = new ManagedToolFileHistory(
          input.ownerSessionId,
          config.getTargetDir(),
          input.snapshots,
        );
      } else {
        const root = findConfig(input.ownerRuntimeSessionId);
        if (!root || input.snapshots.length)
          throw new ManagedToolProtocolError(
            'Managed file history owner is unavailable.',
          );
        assertAvailable(root);
        const rootBinding = this.bindings.get(root);
        if (
          !rootBinding ||
          rootBinding.ownerRuntimeSessionId !== input.ownerRuntimeSessionId ||
          rootBinding.owner.state().ownerSessionId !== input.ownerSessionId ||
          root.getTargetDir() !== config.getTargetDir()
        )
          throw new ManagedToolProtocolError(
            'Managed file history owner does not match.',
          );
        owner = rootBinding.owner;
      }
      await owner.ready();
      assertAvailable(config);
      const root = findConfig(input.ownerRuntimeSessionId);
      if (!root)
        throw new ManagedToolProtocolError(
          'Managed file history owner is unavailable.',
        );
      assertAvailable(root);
      if (root !== config && this.bindings.get(root)?.owner !== owner)
        throw new ManagedToolProtocolError(
          'Managed file history owner was released.',
        );
      const view =
        context || input.executionCwd !== config.getTargetDir()
          ? deriveAgentConfig(config, input.executionCwd, {
              customIgnoreFiles:
                context?.fileFilteringOptions.customIgnoreFiles ??
                config.getFileFilteringOptions().customIgnoreFiles,
            })
          : undefined;
      if (context && view)
        view.workspaceContext.setDirectories(context.workspaceDirectories);
      const toolConfig =
        context && view
          ? deriveConfig(view.config, {
              getMemoryBaseDir: () => context.memoryBaseDir,
              getFileFilteringOptions: () =>
                structuredClone(context.fileFilteringOptions),
              isLsToolEnabled: () => context.lsToolEnabled,
              ...(context.grepOptions
                ? {
                    getUseRipgrep: () => context.grepOptions!.useRipgrep,
                    getUseBuiltinRipgrep: () =>
                      context.grepOptions!.useBuiltinRipgrep,
                  }
                : {}),
              ...(context.outputLimits
                ? {
                    getTruncateToolOutputThreshold: () =>
                      context.outputLimits!.chars ?? Number.POSITIVE_INFINITY,
                    getTruncateToolOutputLines: () =>
                      context.outputLimits!.lines ?? Number.POSITIVE_INFINITY,
                    isTruncateToolOutputThresholdExplicit: () =>
                      context.outputLimits!.charsExplicit,
                  }
                : {}),
            })
          : (view?.config ?? config);
      config.bindSharedFileHistoryService(owner.service);
      toolConfig.bindSharedFileHistoryService(owner.service);
      const binding: Binding = {
        digest,
        ownerRuntimeSessionId: input.ownerRuntimeSessionId,
        owner,
        toolConfig,
      };
      this.bindings.set(config, binding);
      return binding;
    })();
    this.pending.set(config, { digest, promise });
    void promise.then(
      () => this.pending.delete(config),
      () => {
        this.pending.delete(config);
        if (this.owners.get(input.ownerSessionId) === config)
          this.owners.delete(input.ownerSessionId);
      },
    );
    return promise;
  }

  async dispose(config: Config): Promise<void> {
    try {
      await this.pending.get(config)?.promise;
    } catch {
      // A rejected bind cannot start tool execution.
    }
    const binding = this.bindings.get(config);
    if (!binding) return;
    if (
      binding.ownerRuntimeSessionId === config.getSessionId() &&
      [...this.bindings].some(
        ([child, other]) => child !== config && other.owner === binding.owner,
      )
    )
      throw new Error(
        'Managed file history still has child execution bindings.',
      );
    await binding.owner.drain();
    this.bindings.delete(config);
    if (this.owners.get(binding.owner.state().ownerSessionId) === config)
      this.owners.delete(binding.owner.state().ownerSessionId);
  }
}
