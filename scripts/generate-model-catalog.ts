/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Refreshes the bundled models.dev snapshot that ships with the CLI as the
 * offline floor for model context windows, output limits, and modalities.
 *
 * Usage: npm run generate:model-catalog [-- <url-or-path-to-api.json>]
 *
 * The runtime refresh (`packages/core/src/models/model-catalog-refresh.ts`)
 * applies the same projection to whatever it downloads, so the committed
 * file and the per-user cache always share one shape.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MODELS_DEV_URL,
  trimModelsDevCatalog,
  type ModelsDevApi,
} from '../packages/core/src/models/model-catalog-refresh.js';

const MAX_BYTES = 200 * 1024;

const source = process.argv[2] ?? MODELS_DEV_URL;
const api: ModelsDevApi = /^https?:\/\//.test(source)
  ? await (await fetch(source)).json()
  : JSON.parse(fs.readFileSync(source, 'utf8'));

const catalog = trimModelsDevCatalog(api, new Date().toISOString(), source);
const json = JSON.stringify(catalog, null, 2) + '\n';
const bytes = Buffer.byteLength(json);
if (bytes > MAX_BYTES) {
  throw new Error(
    `Trimmed catalog is ${bytes} bytes, over the ${MAX_BYTES}-byte budget; tighten MODELS_DEV_PROVIDERS or the projection.`,
  );
}

const outputPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../packages/core/src/models/generated/model-registry.json',
);
fs.writeFileSync(outputPath, json);
console.log(
  `Generated model catalog at: ${outputPath} (${Object.keys(catalog.models).length} models, ${bytes} bytes)`,
);
