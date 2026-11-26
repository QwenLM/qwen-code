/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_OUTPUT_STYLE_NAME } from './builtin.js';
import {
  getAvailableOutputStyleDefinitions,
  getAvailableOutputStyles,
  resolveOutputStyleWithForce,
} from './resolve.js';
import type { OutputStyleConfig, ResolvedOutputStyle } from './types.js';
import type { LoadedPlugin } from '../../plugins/types.js';
import { runLogger } from '../../utils/runLogger.js';

/**
 * Session-scoped output style state. Mirrors `SkillManager`'s shape: a
 * parameterless owner of the resolved view, whose data is injected by Config
 * (built-in/plugin sources plus the Config-owned resource snapshot) rather than
 * loaded here. It never constructs a `ResourceManager`.
 */

/** Injected inputs; Config owns both. */
export interface OutputStyleSources {
  readonly plugins: readonly LoadedPlugin[];
  readonly resourceOutputStyles: readonly OutputStyleConfig[];
  /** Styles contributed by product builtin plugins. */
  readonly productOutputStyles?: readonly OutputStyleConfig[];
  /**
   * Requested name captured when the load closure was created. Defaults to the
   * last requested name so a first-call-wins initialization keeps its name.
   */
  readonly name?: string;
}

export interface OutputStyleManagerOptions {
  /** Initial requested name (from settings / CLI / SDK). */
  readonly name?: string;
  /** Pre-resolved style supplied by an embedder; skips startup resolution. */
  readonly preResolved?: ResolvedOutputStyle;
}

export class OutputStyleManager {
  private outputStyle: Readonly<ResolvedOutputStyle> | undefined;
  private requestedName: string;
  private initializationPromise?: Promise<void>;

  constructor(options: OutputStyleManagerOptions = {}) {
    this.requestedName = options.name ?? DEFAULT_OUTPUT_STYLE_NAME;
    if (options.preResolved) {
      this.outputStyle = this.copyResolvedOutputStyle(options.preResolved);
      this.initializationPromise = Promise.resolve();
    }
  }

  getOutputStyle(): Readonly<ResolvedOutputStyle> | undefined {
    return this.outputStyle;
  }

  /**
   * Selects a name for the next conversation without changing the current
   * session's resolved style or prompt caches. Persistence belongs to CLI.
   */
  setRequestedName(name: string): void {
    this.requestedName = name;
  }

  /**
   * Resolves once; `loadSources` is invoked only on the first call and later
   * calls share the first result.
   */
  initialize(loadSources: () => Promise<OutputStyleSources>): Promise<void> {
    this.initializationPromise ??= this.resolveFromSources(loadSources);
    return this.initializationPromise;
  }

  /**
   * Resolves the effective style against current sources. `name` defaults to
   * the last requested name. A forced plugin style overrides the request.
   */
  async resolve(input: OutputStyleSources): Promise<void> {
    const name = input.name ?? this.requestedName;
    this.requestedName = name;
    const resolved = await resolveOutputStyleWithForce(name, {
      plugins: input.plugins,
      resourceOutputStyles: input.resourceOutputStyles,
      productOutputStyles: input.productOutputStyles,
    });
    this.logUnknownFallback(name, resolved);
    this.outputStyle = this.copyResolvedOutputStyle(resolved ?? undefined);
  }

  /**
   * Re-resolves against the current plugin/filesystem state for a new
   * session, then the reset lifecycle rebuilds the prompt.
   */
  async resetForNewSession(
    loadSources: () => Promise<OutputStyleSources>,
  ): Promise<void> {
    const sources = await loadSources();
    const name = this.requestedName;
    const outputStyle = await resolveOutputStyleWithForce(name, {
      plugins: sources.plugins,
      resourceOutputStyles: sources.resourceOutputStyles,
      productOutputStyles: sources.productOutputStyles,
    });
    this.logUnknownFallback(name, outputStyle);
    this.outputStyle = this.copyResolvedOutputStyle(outputStyle ?? undefined);
  }

  async getAvailableStyles(
    sources: OutputStyleSources,
  ): Promise<Record<string, OutputStyleConfig | null>> {
    return getAvailableOutputStyles({
      plugins: sources.plugins,
      resourceOutputStyles: sources.resourceOutputStyles,
      productOutputStyles: sources.productOutputStyles,
    });
  }

  async getAvailableDefinitions(
    sources: OutputStyleSources,
  ): Promise<OutputStyleConfig[]> {
    return getAvailableOutputStyleDefinitions({
      plugins: sources.plugins,
      resourceOutputStyles: sources.resourceOutputStyles,
      productOutputStyles: sources.productOutputStyles,
    });
  }

  private async resolveFromSources(
    loadSources: () => Promise<OutputStyleSources>,
  ): Promise<void> {
    await this.resolve(await loadSources());
  }

  private logUnknownFallback(
    name: string | undefined,
    resolved: OutputStyleConfig | null,
  ): void {
    if (name && name !== DEFAULT_OUTPUT_STYLE_NAME && resolved === null) {
      runLogger.log(
        `[output-style] Unknown output style "${name}"; falling back to default.`,
      );
    }
  }

  private copyResolvedOutputStyle(
    outputStyle: ResolvedOutputStyle | undefined,
  ): Readonly<ResolvedOutputStyle> | undefined {
    if (!outputStyle || outputStyle.name === DEFAULT_OUTPUT_STYLE_NAME) {
      return undefined;
    }
    return {
      name: outputStyle.name,
      prompt: outputStyle.prompt,
      keepCodingInstructions: outputStyle.keepCodingInstructions,
    };
  }
}
