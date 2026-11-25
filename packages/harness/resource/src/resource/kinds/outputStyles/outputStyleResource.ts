/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OutputStyleProviderContribution } from './providers/outputStyleProvider.js';
import type { OutputStyleConfig, OutputStyleLoadError } from './types.js';
import type {
  OutputStyleResourceView,
  OutputStyleResourceSnapshot,
} from '../../core/resourceViews.js';

interface ReloadOptions {
  configDirOverride?: string;
}

export interface OutputStyleResourceOptions {
  load: (
    configDirOverride?: string,
  ) => Promise<OutputStyleProviderContribution>;
  reloadMode: 'join' | 'queue';
  disposedError?: string;
}

/** Output Style candidates; selecting and applying a style remain host-owned. */
export class OutputStyleResource implements OutputStyleResourceView {
  private snapshot: OutputStyleResourceSnapshot = {
    discoveredOutputStyles: [],
    loadErrors: [],
  };
  private loaded?: OutputStyleProviderContribution;
  private reading?: Promise<OutputStyleProviderContribution>;
  private queue: Promise<void> = Promise.resolve();
  private initialization?: Promise<void>;
  private stopped = false;
  constructor(private readonly options: OutputStyleResourceOptions) {}

  private assertActive(): void {
    if (this.stopped)
      throw new Error(this.options.disposedError ?? 'OutputStyleResource is disposed');
  }

  initialize(): Promise<void> {
    if (this.stopped)
      return Promise.reject(new Error(this.options.disposedError ?? 'OutputStyleResource is disposed'));
    if (this.options.reloadMode === 'queue')
      return (this.initialization ??= this.reload());
    return this.read(false).then((contribution) => {
      this.assertActive();
      this.commit(contribution);
    });
  }

  reload(options: ReloadOptions = {}): Promise<void> {
    if (this.stopped)
      return Promise.reject(new Error(this.options.disposedError ?? 'OutputStyleResource is disposed'));
    const refresh =
      this.options.reloadMode === 'queue'
        ? this.queue
            .then(() => {
              this.assertActive();
              return this.read(true, options.configDirOverride);
            })
            .then((contribution) => {
              this.assertActive();
              this.commit(contribution);
            })
        : this.read(true).then((contribution) => {
            this.assertActive();
            this.commit(contribution);
          });
    this.queue = refresh.catch(() => undefined);
    if (this.options.reloadMode === 'queue') this.initialization = refresh;
    return refresh;
  }

  private read(
    reload: boolean,
    configDirOverride?: string,
  ): Promise<OutputStyleProviderContribution> {
    if (this.stopped)
      return Promise.reject(new Error(this.options.disposedError ?? 'OutputStyleResource is disposed'));
    if (this.reading) return this.reading;
    if (!reload && this.loaded) return Promise.resolve(this.loaded);
    const reading = this.options.load(configDirOverride).then((snapshot) => {
      if (!this.stopped && this.options.reloadMode === 'join') this.loaded = snapshot;
      return snapshot;
    });
    this.reading = reading;
    void reading
      .finally(() => {
        if (this.reading === reading) this.reading = undefined;
      })
      .catch(() => undefined);
    return reading;
  }

  private commit(contribution: OutputStyleProviderContribution): void {
    this.snapshot = {
      discoveredOutputStyles: contribution.outputStyles.map((style) => ({
        ...style,
      })),
      loadErrors: contribution.loadErrors.map((error) => ({ ...error })),
    };
  }
  getAllDiscoveredOutputStyles(): OutputStyleConfig[] {
    return this.snapshot.discoveredOutputStyles.map((style) => ({ ...style }));
  }
  getLoadErrors(): readonly OutputStyleLoadError[] {
    return this.snapshot.loadErrors.map((error) => ({ ...error }));
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    await Promise.all([this.queue, this.reading?.catch(() => undefined)]);
  }
}
