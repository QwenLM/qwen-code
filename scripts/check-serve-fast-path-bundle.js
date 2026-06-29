#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_METAFILE_PATH = resolve('dist/esbuild.json');
const RUN_QWEN_SERVE_SOURCE = 'packages/cli/src/serve/run-qwen-serve.ts';

const FORBIDDEN_SOURCE_INPUTS = [
  {
    label: 'Serve ACP compatibility shim',
    suffix: 'packages/cli/src/serve/acp-session-bridge.ts',
  },
  {
    label: 'ACP bridge runtime',
    suffix: 'packages/acp-bridge/src/bridge.ts',
  },
  {
    label: 'ACP bridge client runtime',
    suffix: 'packages/acp-bridge/src/bridgeClient.ts',
  },
  {
    label: 'ACP spawnChannel runtime',
    suffix: 'packages/acp-bridge/src/spawnChannel.ts',
  },
  {
    label: 'ACP permission mediator runtime',
    suffix: 'packages/acp-bridge/src/permissionMediator.ts',
  },
  {
    label: 'ACP compaction engine runtime',
    suffix: 'packages/acp-bridge/src/compactionEngine.ts',
  },
  {
    label: 'Core shell tool runtime',
    suffix: 'packages/core/src/tools/shell.ts',
  },
];

const FORBIDDEN_VENDOR_PACKAGES = [
  { label: 'glob vendor package', packageName: 'glob' },
  { label: 'chokidar vendor package', packageName: 'chokidar' },
  { label: '@iarna/toml vendor package', packageName: '@iarna/toml' },
  { label: 'fzf vendor package', packageName: 'fzf' },
];

export function normalizeMetafilePath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function inputMatchesSuffix(input, suffix) {
  const normalizedInput = normalizeMetafilePath(input);
  return normalizedInput === suffix || normalizedInput.endsWith(`/${suffix}`);
}

function inputMatchesPackage(input, packageName) {
  const normalizedInput = normalizeMetafilePath(input);
  const marker = `node_modules/${packageName}/`;
  return (
    normalizedInput === `node_modules/${packageName}` ||
    normalizedInput.includes(marker)
  );
}

function normalizeOutputs(metafile) {
  return new Map(
    Object.entries(metafile.outputs ?? {}).map(([outputPath, output]) => [
      normalizeMetafilePath(outputPath),
      output,
    ]),
  );
}

function findRunQwenServeOutput(outputs) {
  for (const [outputPath, output] of outputs) {
    for (const input of Object.keys(output.inputs ?? {})) {
      if (inputMatchesSuffix(input, RUN_QWEN_SERVE_SOURCE)) {
        return outputPath;
      }
    }
  }
  throw new Error(
    `Could not find bundled output for ${RUN_QWEN_SERVE_SOURCE}. ` +
      'Run DEV=true npm run bundle before this check.',
  );
}

function collectStaticClosure(outputs, entryOutput) {
  const queue = [entryOutput];
  const closure = new Set(queue);
  const parent = new Map();

  for (let i = 0; i < queue.length; i++) {
    const outputPath = queue[i];
    const output = outputs.get(outputPath);
    for (const bundledImport of output?.imports ?? []) {
      if (bundledImport.external) continue;
      if (bundledImport.kind === 'dynamic-import') continue;

      const importedOutput = normalizeMetafilePath(bundledImport.path);
      if (!outputs.has(importedOutput) || closure.has(importedOutput)) {
        continue;
      }

      closure.add(importedOutput);
      parent.set(importedOutput, outputPath);
      queue.push(importedOutput);
    }
  }

  return { closure, parent };
}

function buildImportPath(entryOutput, outputPath, parent) {
  const reversed = [outputPath];
  let current = outputPath;
  while (current !== entryOutput) {
    current = parent.get(current);
    if (!current) break;
    reversed.push(current);
  }
  return reversed.reverse();
}

export function findServeFastPathBundleOffenders(metafile) {
  const outputs = normalizeOutputs(metafile);
  const entryOutput = findRunQwenServeOutput(outputs);
  const { closure, parent } = collectStaticClosure(outputs, entryOutput);
  const offenders = [];
  const seen = new Set();

  for (const outputPath of closure) {
    const output = outputs.get(outputPath);
    const inputs = Object.keys(output?.inputs ?? {});

    for (const input of inputs) {
      const normalizedInput = normalizeMetafilePath(input);
      const sourceMatch = FORBIDDEN_SOURCE_INPUTS.find(({ suffix }) =>
        inputMatchesSuffix(normalizedInput, suffix),
      );
      if (sourceMatch) {
        addOffender(sourceMatch.label, normalizedInput, outputPath);
      }

      const vendorMatch = FORBIDDEN_VENDOR_PACKAGES.find(({ packageName }) =>
        inputMatchesPackage(normalizedInput, packageName),
      );
      if (vendorMatch) {
        addOffender(vendorMatch.label, normalizedInput, outputPath);
      }
    }
  }

  return offenders;

  function addOffender(label, matchedInput, outputPath) {
    const key = `${label}\0${outputPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    offenders.push({
      label,
      matchedInput,
      outputPath,
      bytes: outputs.get(outputPath)?.bytes ?? 0,
      importPath: buildImportPath(entryOutput, outputPath, parent),
    });
  }
}

export function formatServeFastPathBundleOffenders(offenders) {
  return offenders
    .map((offender) => {
      const importPath = offender.importPath.join(' -> ');
      return [
        `- ${offender.label}`,
        `  input: ${offender.matchedInput}`,
        `  output: ${offender.outputPath} (${offender.bytes} bytes)`,
        `  static path: ${importPath}`,
      ].join('\n');
    })
    .join('\n');
}

export function checkServeFastPathBundle({
  metafilePath = DEFAULT_METAFILE_PATH,
} = {}) {
  if (!existsSync(metafilePath)) {
    throw new Error(
      `Missing esbuild metafile at ${metafilePath}. ` +
        'Run `npm run check:serve-fast-path-bundle` to build one.',
    );
  }

  const metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
  const offenders = findServeFastPathBundleOffenders(metafile);
  return { ok: offenders.length === 0, offenders };
}

function main() {
  try {
    const result = checkServeFastPathBundle();
    if (result.ok) {
      console.log('Serve fast-path bundle closure check passed.');
      return;
    }

    console.error(
      'Serve fast-path bundle closure includes pre-listen runtime modules:\n' +
        formatServeFastPathBundleOffenders(result.offenders),
    );
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main();
}
