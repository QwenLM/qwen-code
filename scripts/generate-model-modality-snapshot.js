/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceUrl = 'https://models.dev/api.json';
const outputPath = fileURLToPath(
  new URL(
    '../packages/core/src/models/generated/models-dev-modalities.json',
    import.meta.url,
  ),
);

const response = await fetch(sourceUrl);
if (!response.ok) {
  throw new Error(`models.dev returned HTTP ${response.status}`);
}

const catalog = await response.json();
const snapshot = {};

for (const providerId of Object.keys(catalog).sort()) {
  const provider = catalog[providerId];
  if (!provider || typeof provider !== 'object') continue;

  const models = {};
  for (const modelId of Object.keys(provider.models ?? {}).sort()) {
    const input = provider.models[modelId]?.modalities?.input;
    if (Array.isArray(input)) models[modelId] = input;
  }

  snapshot[providerId] = {
    ...(typeof provider.api === 'string' ? { api: provider.api } : {}),
    ...(Array.isArray(provider.env) ? { env: provider.env } : {}),
    models,
  };
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(snapshot)}\n`);
