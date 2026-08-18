/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceUrl = 'https://models.dev/api.json';
const scriptPath = fileURLToPath(import.meta.url);
const outputPath = fileURLToPath(
  new URL(
    '../packages/core/src/models/generated/models-dev-modalities.json',
    import.meta.url,
  ),
);

export function buildSnapshot(catalog) {
  const snapshot = Object.create(null);
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('models.dev returned no valid model metadata');
  }

  for (const providerId of Object.keys(catalog).sort()) {
    const provider = catalog[providerId];
    if (!provider || typeof provider !== 'object') continue;

    const models = Object.create(null);
    for (const modelId of Object.keys(provider.models ?? {}).sort()) {
      const model = provider.models[modelId];
      const input = Array.isArray(model) ? model : model?.modalities?.input;
      if (Array.isArray(input)) {
        models[modelId] = input;
      } else if (model?.attachment === true) {
        models[modelId] = { attachment: true };
      }
    }

    if (Object.keys(models).length === 0) continue;

    snapshot[providerId] = {
      ...(typeof provider.api === 'string' ? { api: provider.api } : {}),
      ...(Array.isArray(provider.env) ? { env: provider.env } : {}),
      models,
    };
  }

  if (Object.keys(snapshot).length === 0) {
    throw new Error('models.dev returned no valid model metadata');
  }
  return snapshot;
}

async function main() {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`models.dev returned HTTP ${response.status}`);
  }

  const snapshot = buildSnapshot(await response.json());
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
