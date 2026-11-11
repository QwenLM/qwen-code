/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { loadOutputStylesFromDir } from '../outputStyleLoader.js';
import type { OutputStyleConfig, OutputStyleLoadError } from '../types.js';

export interface OutputStyleProviderContribution {
  outputStyles: OutputStyleConfig[];
  loadErrors: OutputStyleLoadError[];
}

/** Flat user/project Markdown discovery; no watcher or runtime policy. */
export class OutputStyleProvider {
  constructor(
    private readonly directory: string,
    readonly source: 'userSettings' | 'projectSettings',
  ) {}

  async load(): Promise<OutputStyleProviderContribution> {
    const loadErrors: OutputStyleLoadError[] = [];
    const outputStyles = await loadOutputStylesFromDir(
      this.directory,
      this.source,
      undefined,
      {
        onError: (error) => loadErrors.push(error),
      },
    );
    return { outputStyles, loadErrors };
  }
}
