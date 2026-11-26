/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CoreEvent,
  coreEvents,
  type Config,
  type Model,
} from '@qwen-code/core';
import { exitCli } from './exitCli.js';

const KEY_MAX_WIDTH = 40;

function truncateKey(key: string): string {
  return key.length <= KEY_MAX_WIDTH
    ? key
    : `${key.slice(0, KEY_MAX_WIDTH - 1)}…`;
}

/**
 * Built-in models show the display name only; provider/custom models append the
 * qualified key so the user can disambiguate or copy it.
 */
function formatModelCell(model: Model): string {
  const name = model.displayName || model.key;
  return name === model.key ? name : `${name} (${truncateKey(model.key)})`;
}

export function formatModelListText(models: readonly Model[]): string {
  return ['MODEL', ...models.map(formatModelCell)].join('\n') + '\n';
}

export interface RunModelListOptions {
  config: Config;
}

function writeErr(line: string): void {
  process.stderr.write(line.endsWith('\n') ? line : line + '\n');
}

/** Entry point for the open-source `--list-models` route. Provider-agnostic. */
export async function runModelListCommand(
  options: RunModelListOptions,
): Promise<void> {
  // Keep --list-models script-friendly: suppress queued UserFeedback emitted
  // during config loading before the process exits.
  coreEvents.on(CoreEvent.UserFeedback, () => {});

  try {
    const models = (
      await options.config.getModelProviderManager().listModels()
    ).filter((model) => model.enabled !== false);

    if (models.length === 0) {
      writeErr('Warning: no models available.');
      await exitCli(0);
      return;
    }

    process.stdout.write(formatModelListText(models));
    await exitCli(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeErr(`Failed to fetch model list: ${message}`);
    await exitCli(1);
  }
}
