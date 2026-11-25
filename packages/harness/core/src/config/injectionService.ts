/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Source of an injection into the model conversation.
 * - `user_steering`: Interactive guidance from the user (gated on model steering).
 *
 * Background completion notifications are no longer routed through InjectionService;
 * they flow through messageQueueManager instead.
 */

import { runLogger } from '../utils/runLogger.js';

export type InjectionSource = 'user_steering';

/**
 * Typed listener that receives both the injection text and its source.
 */
export type InjectionListener = (text: string, source: InjectionSource) => void;

/**
 * Service for managing injections into the model conversation.
 *
 * Multiple sources (user steering, background execution completions, etc.)
 * can feed into this service. Consumers register listeners via
 * {@link onInjection} to receive injections with source information.
 */
export class InjectionService {
  private readonly injections: Array<{
    text: string;
    source: InjectionSource;
    timestamp: number;
  }> = [];
  private readonly injectionListeners: Set<InjectionListener> = new Set();

  constructor(private readonly isEnabled: () => boolean) {}

  /**
   * Adds an injection from any source.
   *
   * `user_steering` injections are gated on model steering being enabled.
   */
  addInjection(text: string, source: InjectionSource): void {
    if (source === 'user_steering' && !this.isEnabled()) {
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    this.injections.push({ text: trimmed, source, timestamp: Date.now() });

    for (const listener of this.injectionListeners) {
      try {
        listener(trimmed, source);
      } catch (error) {
        runLogger.warn(
          `Injection listener failed for source "${source}": ${error}`,
        );
      }
    }
  }

  /**
   * Registers a listener for injections from any source.
   */
  onInjection(listener: InjectionListener): void {
    this.injectionListeners.add(listener);
  }

  /**
   * Unregisters an injection listener.
   */
  offInjection(listener: InjectionListener): void {
    this.injectionListeners.delete(listener);
  }

  /**
   * Returns collected injection texts, optionally filtered by source.
   */
  getInjections(source?: InjectionSource): string[] {
    const items = source
      ? this.injections.filter((h) => h.source === source)
      : this.injections;
    return items.map((h) => h.text);
  }

  /**
   * Returns injection texts added after a specific index, optionally filtered by source.
   */
  getInjectionsAfter(index: number, source?: InjectionSource): string[] {
    if (index < 0) {
      return this.getInjections(source);
    }
    const items = this.injections.slice(index + 1);
    const filtered = source ? items.filter((h) => h.source === source) : items;
    return filtered.map((h) => h.text);
  }

  /**
   * Returns the index of the latest injection.
   */
  getLatestInjectionIndex(): number {
    return this.injections.length - 1;
  }

  /**
   * Clears all collected injections.
   */
  clear(): void {
    this.injections.length = 0;
  }
}
