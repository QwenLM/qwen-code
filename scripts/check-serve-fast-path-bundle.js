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
const METAFILE_BUILD_COMMAND =
  'node scripts/clean-package-build-artifacts.js && npm run build -- --cli-only && cross-env DEV=true npm run bundle';
const SERVE_PRE_LISTEN_ROOTS = [
  {
    label: 'serve fast path entry',
    suffixes: [
      'packages/cli/src/serve/fast-path.ts',
      'packages/cli/dist/src/serve/fast-path.js',
    ],
  },
  {
    label: 'serve fast path settings',
    suffixes: [
      'packages/cli/src/serve/fast-path-settings.ts',
      'packages/cli/dist/src/serve/fast-path-settings.js',
    ],
  },
  {
    label: 'run qwen serve entry',
    suffixes: [
      'packages/cli/src/serve/run-qwen-serve.ts',
      'packages/cli/dist/src/serve/run-qwen-serve.js',
    ],
  },
];

const ACP_RUNTIME_ROOT = {
  label: 'ACP agent runtime',
  suffixes: [
    'packages/cli/src/acp-integration/acpAgent.ts',
    'packages/cli/dist/src/acp-integration/acpAgent.js',
  ],
};

const FORBIDDEN_SOURCE_INPUTS = [
  {
    label: 'Gemini runtime',
    suffixes: [
      'packages/cli/src/gemini.tsx',
      'packages/cli/dist/src/gemini.js',
    ],
  },
  {
    label: 'ACP agent runtime',
    suffixes: [
      'packages/cli/src/acp-integration/acpAgent.ts',
      'packages/cli/dist/src/acp-integration/acpAgent.js',
    ],
  },
  {
    label: 'ACP startup profiler',
    suffixes: [
      'packages/cli/src/utils/acp-startup-profiler.ts',
      'packages/cli/dist/src/utils/acp-startup-profiler.js',
    ],
  },
  {
    label: 'Serve ACP compatibility shim',
    suffixes: [
      'packages/cli/src/serve/acp-session-bridge.ts',
      'packages/cli/dist/src/serve/acp-session-bridge.js',
    ],
  },
  {
    label: 'ACP bridge runtime',
    suffixes: [
      'packages/acp-bridge/src/bridge.ts',
      'packages/acp-bridge/dist/bridge.js',
    ],
  },
  {
    label: 'ACP bridge client runtime',
    suffixes: [
      'packages/acp-bridge/src/bridgeClient.ts',
      'packages/acp-bridge/dist/bridgeClient.js',
    ],
  },
  {
    label: 'ACP spawnChannel runtime',
    suffixes: [
      'packages/acp-bridge/src/spawnChannel.ts',
      'packages/acp-bridge/dist/spawnChannel.js',
    ],
  },
  {
    label: 'ACP permission mediator runtime',
    suffixes: [
      'packages/acp-bridge/src/permissionMediator.ts',
      'packages/acp-bridge/dist/permissionMediator.js',
    ],
  },
  {
    label: 'ACP compaction engine runtime',
    suffixes: [
      'packages/acp-bridge/src/compactionEngine.ts',
      'packages/acp-bridge/dist/compactionEngine.js',
    ],
  },
  {
    label: 'Core shell tool runtime',
    suffixes: [
      'packages/core/src/tools/shell.ts',
      'packages/core/dist/src/tools/shell.js',
    ],
  },
];

const FORBIDDEN_VENDOR_PACKAGES = [
  { label: 'glob vendor package', packageName: 'glob' },
  { label: 'chokidar vendor package', packageName: 'chokidar' },
  { label: '@iarna/toml vendor package', packageName: '@iarna/toml' },
  { label: 'fzf vendor package', packageName: 'fzf' },
];

const FORBIDDEN_ACP_UI_PACKAGES = [
  { label: 'Ink TUI runtime', packageName: 'ink' },
  { label: 'React runtime', packageName: 'react' },
  { label: 'React reconciler runtime', packageName: 'react-reconciler' },
  { label: 'Yoga layout runtime', packageName: 'yoga-layout' },
];

export function normalizeMetafilePath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function inputMatchesSuffix(input, suffix) {
  const normalizedInput = normalizeMetafilePath(input);
  return normalizedInput === suffix || normalizedInput.endsWith(`/${suffix}`);
}

function inputMatchesAnySuffix(input, suffixes) {
  return suffixes.some((suffix) => inputMatchesSuffix(input, suffix));
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

function findServePreListenRootOutputs(outputs) {
  const rootOutputs = [];
  const missingRoots = [];

  for (const root of SERVE_PRE_LISTEN_ROOTS) {
    let matchedOutput;
    for (const [outputPath, output] of outputs) {
      for (const input of Object.keys(output.inputs ?? {})) {
        if (inputMatchesAnySuffix(input, root.suffixes)) {
          matchedOutput = outputPath;
          break;
        }
      }
      if (matchedOutput) break;
    }

    if (matchedOutput) {
      rootOutputs.push(matchedOutput);
    } else {
      missingRoots.push(`${root.label} (${root.suffixes.join(' or ')})`);
    }
  }

  if (missingRoots.length > 0) {
    throw new Error(
      'Could not find bundled outputs for serve pre-listen roots:\n' +
        missingRoots.map((root) => `- ${root}`).join('\n') +
        `\nRun \`${METAFILE_BUILD_COMMAND}\` to produce the metafile.`,
    );
  }

  return [...new Set(rootOutputs)];
}

function collectStaticClosure(outputs, entryOutputs) {
  const queue = [...entryOutputs];
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

function buildImportPath(entryOutputs, outputPath, parent) {
  const roots = new Set(entryOutputs);
  const reversed = [outputPath];
  let current = outputPath;
  while (!roots.has(current)) {
    current = parent.get(current);
    if (!current) break;
    reversed.push(current);
  }
  return reversed.reverse();
}

export function findAcpImportBoundaryOffenders(metafile) {
  const outputs = normalizeOutputs(metafile);
  let entryOutput;

  for (const [outputPath, output] of outputs) {
    const inputs = Object.keys(output.inputs ?? {});
    if (
      inputs.some((input) =>
        inputMatchesAnySuffix(input, ACP_RUNTIME_ROOT.suffixes),
      )
    ) {
      entryOutput = outputPath;
      break;
    }
  }

  if (!entryOutput) {
    throw new Error(
      `Could not find bundled output for ${ACP_RUNTIME_ROOT.label} ` +
        `(${ACP_RUNTIME_ROOT.suffixes.join(' or ')}).\n` +
        `Run \`${METAFILE_BUILD_COMMAND}\` to produce the metafile.`,
    );
  }

  const entryOutputs = [entryOutput];
  const { closure, parent } = collectStaticClosure(outputs, entryOutputs);
  const offenders = [];
  const seen = new Set();

  for (const outputPath of closure) {
    const output = outputs.get(outputPath);
    for (const input of Object.keys(output?.inputs ?? {})) {
      const match = FORBIDDEN_ACP_UI_PACKAGES.find(({ packageName }) =>
        inputMatchesPackage(input, packageName),
      );
      if (!match) continue;
      const key = `${match.label}\0${outputPath}`;
      if (seen.has(key)) continue;
      seen.add(key);

      offenders.push({
        label: match.label,
        matchedInput: normalizeMetafilePath(input),
        outputPath,
        bytes: output?.bytes ?? 0,
        importPath: buildImportPath(entryOutputs, outputPath, parent),
      });
    }
  }

  return offenders;
}

export function findServeFastPathBundleOffenders(metafile) {
  const outputs = normalizeOutputs(metafile);
  const entryOutputs = findServePreListenRootOutputs(outputs);
  const { closure, parent } = collectStaticClosure(outputs, entryOutputs);
  const offenders = [];
  const seen = new Set();

  for (const outputPath of closure) {
    const output = outputs.get(outputPath);
    const inputs = Object.keys(output?.inputs ?? {});

    for (const input of inputs) {
      const sourceMatch = FORBIDDEN_SOURCE_INPUTS.find(({ suffixes }) =>
        inputMatchesAnySuffix(input, suffixes),
      );
      if (sourceMatch) {
        addOffender(
          sourceMatch.label,
          normalizeMetafilePath(input),
          outputPath,
        );
      }

      const vendorMatch = FORBIDDEN_VENDOR_PACKAGES.find(({ packageName }) =>
        inputMatchesPackage(input, packageName),
      );
      if (vendorMatch) {
        addOffender(
          vendorMatch.label,
          normalizeMetafilePath(input),
          outputPath,
        );
      }
    }
  }

  return offenders;

  function addOffender(label, matchedInput, outputPath) {
    const key = `${label}\0${matchedInput}\0${outputPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    offenders.push({
      label,
      matchedInput,
      outputPath,
      bytes: outputs.get(outputPath)?.bytes ?? 0,
      importPath: buildImportPath(entryOutputs, outputPath, parent),
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
        `Run \`${METAFILE_BUILD_COMMAND}\` to produce it.`,
    );
  }

  let metafile;
  try {
    metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid esbuild metafile at ${metafilePath}: ${reason}. ` +
        `Run \`${METAFILE_BUILD_COMMAND}\` to regenerate it.`,
    );
  }
  const offenders = findServeFastPathBundleOffenders(metafile);
  return { ok: offenders.length === 0, offenders };
}

export function checkAcpImportBoundary({
  metafilePath = DEFAULT_METAFILE_PATH,
} = {}) {
  if (!existsSync(metafilePath)) {
    throw new Error(
      `Missing esbuild metafile at ${metafilePath}. ` +
        `Run \`${METAFILE_BUILD_COMMAND}\` to produce it.`,
    );
  }

  let metafile;
  try {
    metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid esbuild metafile at ${metafilePath}: ${reason}. ` +
        `Run \`${METAFILE_BUILD_COMMAND}\` to regenerate it.`,
    );
  }

  const offenders = findAcpImportBoundaryOffenders(metafile);
  return { ok: offenders.length === 0, offenders };
}

function main() {
  try {
    const serveResult = checkServeFastPathBundle();
    if (!serveResult.ok) {
      console.error(
        'Serve fast-path bundle closure includes pre-listen runtime modules:\n' +
          formatServeFastPathBundleOffenders(serveResult.offenders),
      );
      process.exitCode = 1;
    }

    const acpResult = checkAcpImportBoundary();
    if (!acpResult.ok) {
      console.error(
        'ACP static import closure includes TUI runtime modules:\n' +
          formatServeFastPathBundleOffenders(acpResult.offenders),
      );
      process.exitCode = 1;
    }

    if (serveResult.ok && acpResult.ok) {
      console.log('Startup bundle closure checks passed.');
    }
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
