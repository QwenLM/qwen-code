/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import nodeModule, { type ResolveFnOutput } from 'node:module';

const generatedChunkName = /^[\w.-]+-[A-Z0-9]{8}\.js$/u;
const nodeLoaderOption =
  /(?:^|\s)(?:--(?:experimental[-_]loader|loader|import|require)(?=[\s=]|$)|-r(?=\s|$))/u;

export function installBundledChunkResolver(entryUrl: string): void {
  // Read the optional method from the default binding. Node versions before
  // 22.15 do not provide a registerHooks named export.
  const { registerHooks } = nodeModule;
  const nodeOptions = process.env['NODE_OPTIONS']?.replace(/["\\]/gu, '') ?? '';
  if (
    typeof registerHooks !== 'function' ||
    !entryUrl.startsWith('file:') ||
    nodeLoaderOption.test([nodeOptions, ...process.execArgv].join(' '))
  ) {
    return;
  }

  const directory = new URL('./chunks', entryUrl);
  let entries: Dirent[];
  try {
    if (!lstatSync(directory).isDirectory()) return;
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    // Development builds and installations with a non-listable directory can
    // use ordinary resolution.
    return;
  }

  const byName = new Map<string, ResolveFnOutput>();
  const chunkUrls = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !generatedChunkName.test(entry.name)) continue;
    const url = directory.href + '/' + entry.name;
    byName.set(entry.name, { url, format: 'module', shortCircuit: true });
    chunkUrls.add(url);
  }
  if (byName.size === 0) return;

  // Only resolve esbuild's exact relative imports between known bundle files.
  // Node still loads the .js and uses its regular cache for the same file URL.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      let chunk: ResolveFnOutput | undefined;
      if (parent === entryUrl && specifier.startsWith('./chunks/')) {
        chunk = byName.get(specifier.slice('./chunks/'.length));
      } else if (
        parent !== undefined &&
        specifier.startsWith('./') &&
        chunkUrls.has(parent)
      ) {
        chunk = byName.get(specifier.slice('./'.length));
      }
      return chunk ?? nextResolve(specifier, context);
    },
  });
}
