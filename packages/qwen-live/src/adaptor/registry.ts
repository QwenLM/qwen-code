/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The set of backends a live call can drive. One of them is the default
 * (what a bare session_create/handoff resolves to); the rest are named
 * targets the voice model selects via session_create's `backend` arg.
 *
 * Preflight policy: the DEFAULT backend's failure aborts daemon start
 * before the discovery file is claimed (the product cannot run without
 * it). Secondary backends are best-effort — a failure marks them
 * unavailable with the last error; the daemon still starts, session_list
 * omits them, and session_create naming them returns the stored error.
 */

import type { BackendAdaptor, BackendHandle } from './types.js';

export interface RegisteredBackend {
  readonly adaptor: BackendAdaptor;
  readonly isDefault: boolean;
  status: 'ready' | 'unavailable';
  lastError?: string;
}

export type RegistryLog = (message: string) => void;

export class BackendRegistry {
  private readonly entries: RegisteredBackend[];
  private readonly byName: Map<string, RegisteredBackend>;

  constructor(
    entries: ReadonlyArray<{ adaptor: BackendAdaptor; isDefault: boolean }>,
  ) {
    if (entries.length === 0) {
      throw new Error('at least one backend must be configured');
    }
    this.entries = entries.map((entry) => ({
      adaptor: entry.adaptor,
      isDefault: entry.isDefault,
      status: 'ready' as const,
    }));
    this.byName = new Map(
      this.entries.map((entry) => [entry.adaptor.name, entry]),
    );
  }

  get defaultAdaptor(): BackendAdaptor {
    const entry = this.entries.find((candidate) => candidate.isDefault);
    if (!entry) {
      // Constructor enforces exactly one default; unreachable.
      throw new Error('no default backend configured');
    }
    return entry.adaptor;
  }

  get defaultName(): string {
    return this.defaultAdaptor.name;
  }

  names(): string[] {
    return this.entries.map((entry) => entry.adaptor.name);
  }

  /** All registered backends, default first. */
  all(): readonly RegisteredBackend[] {
    return this.entries;
  }

  byAdaptorName(name: string): RegisteredBackend | undefined {
    return this.byName.get(name);
  }

  /**
   * The adaptor that owns a backend handle. Handles are minted only by
   * registered adaptors, so an unknown name is an invariant violation —
   * throw rather than guess.
   */
  adaptorFor(handle: BackendHandle): BackendAdaptor {
    const entry = this.byName.get(handle.adaptor);
    if (!entry) {
      throw new Error(
        `unknown backend '${handle.adaptor}' (configured: ${this.names().join(', ')})`,
      );
    }
    return entry.adaptor;
  }

  async preflight(log: RegistryLog): Promise<void> {
    // Default first, and its failure aborts startup.
    await this.defaultAdaptor.preflight();
    const secondaries = this.entries.filter((entry) => !entry.isDefault);
    await Promise.allSettled(
      secondaries.map(async (entry) => {
        try {
          await entry.adaptor.preflight();
        } catch (error) {
          entry.status = 'unavailable';
          entry.lastError =
            error instanceof Error ? error.message : String(error);
          log(
            `backend '${entry.adaptor.name}' unavailable: ${entry.lastError}`,
          );
        }
      }),
    );
  }

  async closeAll(log: RegistryLog): Promise<void> {
    await Promise.allSettled(
      this.entries.map(async (entry) => {
        try {
          await entry.adaptor.close();
        } catch (error) {
          log(
            `closing backend '${entry.adaptor.name}' failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
  }
}
