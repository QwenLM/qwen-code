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
  assertCatalogPayloadComplete,
  MODELS_DEV_URL,
  trimModelsDevCatalog,
  type ModelsDevApi,
} from '../packages/core/src/models/model-catalog-refresh.js';

const MAX_BYTES = 200 * 1024;

const input = process.argv[2] ?? MODELS_DEV_URL;
// The provenance stamped into the committed snapshot must stay meaningful to
// its readers: a local input path is machine-specific, so stamp the
// canonical catalog URL instead — the payload is models.dev data regardless
// of where this machine happened to store it.
const source = /^https?:\/\//.test(input) ? input : MODELS_DEV_URL;

async function fetchApi(url: string): Promise<ModelsDevApi> {
  const response = await fetch(url);
  if (!response.ok) {
    // Release the socket before throwing so the process exits cleanly.
    await response.body?.cancel().catch(() => {});
    throw new Error(`fetching ${url}: HTTP ${response.status}`);
  }
  return (await response.json()) as ModelsDevApi;
}

const api: ModelsDevApi = /^https?:\/\//.test(input)
  ? await fetchApi(input)
  : JSON.parse(fs.readFileSync(input, 'utf8'));

// Same coverage guard the runtime refresh applies: a truncated download or
// a mirror that omits one provider must not replace the committed snapshot.
assertCatalogPayloadComplete(api);
const catalog = trimModelsDevCatalog(api, new Date().toISOString(), source);
// A 200 that projects to nothing is not a catalog (a renamed upstream field
// or a gateway error body); never overwrite the committed snapshot with it.
if (Object.keys(catalog.models).length === 0) {
  throw new Error(
    `no catalog entries projected from ${input}; leaving the committed snapshot untouched`,
  );
}
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
