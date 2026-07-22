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

// The telemetry protocol split (issue #7264) keeps the OTLP exporter chains
// behind dynamic import()s inside sdk-impl.ts itself. Its static closure may
// keep NodeSDK and the instrumentations, but must not reach the gRPC cluster
// or the shared OTLP serialization layer, which only the protocol modules
// (sdk-exporters-grpc.ts / sdk-exporters-http.ts) are allowed to load.
const SDK_IMPL_ROOT = {
  label: 'telemetry sdk-impl',
  suffixes: [
    'packages/core/src/telemetry/sdk-impl.ts',
    'packages/core/dist/src/telemetry/sdk-impl.js',
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

// Heavy telemetry SDK packages must stay behind the dynamic import() in
// packages/core/src/telemetry/sdk.ts (issue #4748). Cheap packages that are
// legitimately eager (@opentelemetry/api, semantic-conventions, core,
// resources, api-logs) are intentionally NOT listed.
//
// The protocol-chain subset is additionally forbidden from the sdk-impl
// static closure (issue #7264). Both the gRPC and HTTP exporter packages are
// listed explicitly so the guard is self-describing and survives upstream
// dependency restructuring; @opentelemetry/otlp-transformer (the serialization
// layer both chains share) and @opentelemetry/otlp-exporter-base stay listed as
// belt-and-suspenders for a static re-import of either protocol module.
const FORBIDDEN_OTLP_PROTOCOL_PACKAGES = [
  { label: 'gRPC runtime', packageName: '@grpc/grpc-js' },
  { label: 'gRPC proto loader', packageName: '@grpc/proto-loader' },
  { label: 'protobufjs runtime', packageName: 'protobufjs' },
  {
    label: 'OTLP transformer',
    packageName: '@opentelemetry/otlp-transformer',
  },
  {
    label: 'OTLP exporter base',
    packageName: '@opentelemetry/otlp-exporter-base',
  },
  {
    label: 'OTLP gRPC trace exporter',
    packageName: '@opentelemetry/exporter-trace-otlp-grpc',
  },
  {
    label: 'OTLP gRPC log exporter',
    packageName: '@opentelemetry/exporter-logs-otlp-grpc',
  },
  {
    label: 'OTLP gRPC metric exporter',
    packageName: '@opentelemetry/exporter-metrics-otlp-grpc',
  },
  {
    label: 'OTLP HTTP trace exporter',
    packageName: '@opentelemetry/exporter-trace-otlp-http',
  },
  {
    label: 'OTLP HTTP log exporter',
    packageName: '@opentelemetry/exporter-logs-otlp-http',
  },
  {
    label: 'OTLP HTTP metric exporter',
    packageName: '@opentelemetry/exporter-metrics-otlp-http',
  },
];

const FORBIDDEN_ACP_TELEMETRY_PACKAGES = [
  ...FORBIDDEN_OTLP_PROTOCOL_PACKAGES,
  { label: 'OTel NodeSDK', packageName: '@opentelemetry/sdk-node' },
  {
    label: 'OTel HTTP instrumentation',
    packageName: '@opentelemetry/instrumentation-http',
  },
  {
    label: 'OTel undici instrumentation',
    packageName: '@opentelemetry/instrumentation-undici',
  },
];

const FORBIDDEN_ACP_PACKAGES = [
  ...FORBIDDEN_ACP_UI_PACKAGES,
  ...FORBIDDEN_ACP_TELEMETRY_PACKAGES,
  // undici loads behind dynamic import()s at its use sites (issue #7264
  // candidate 4); a static re-import anywhere in the ACP closure would pull
  // ~1 MiB per bundled copy back into every cold start.
  { label: 'undici vendor package', packageName: 'undici' },
  // Provider implementations and MCP discovery load the Google GenAI SDK on
  // first use (issue #7264 candidate 3). Keep its SDK and Google auth graph
  // out of the ACP bootstrap closure.
  { label: 'Google GenAI SDK', packageName: '@google/genai' },
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
  return findRootClosureOffenders(
    metafile,
    ACP_RUNTIME_ROOT,
    FORBIDDEN_ACP_PACKAGES,
  );
}

export function findSdkImplProtocolOffenders(metafile) {
  return findRootClosureOffenders(
    metafile,
    SDK_IMPL_ROOT,
    FORBIDDEN_OTLP_PROTOCOL_PACKAGES,
  );
}

function findRootClosureOffenders(metafile, root, forbiddenPackages) {
  const outputs = normalizeOutputs(metafile);
  let entryOutput;

  for (const [outputPath, output] of outputs) {
    const inputs = Object.keys(output.inputs ?? {});
    if (inputs.some((input) => inputMatchesAnySuffix(input, root.suffixes))) {
      entryOutput = outputPath;
      break;
    }
  }

  if (!entryOutput) {
    throw new Error(
      `Could not find bundled output for ${root.label} ` +
        `(${root.suffixes.join(' or ')}).\n` +
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
      const match = forbiddenPackages.find(({ packageName }) =>
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

function readMetafile(metafilePath) {
  if (!existsSync(metafilePath)) {
    throw new Error(
      `Missing esbuild metafile at ${metafilePath}. ` +
        `Run \`${METAFILE_BUILD_COMMAND}\` to produce it.`,
    );
  }

  try {
    return JSON.parse(readFileSync(metafilePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid esbuild metafile at ${metafilePath}: ${reason}. ` +
        `Run \`${METAFILE_BUILD_COMMAND}\` to regenerate it.`,
    );
  }
}

export function checkServeFastPathBundle({
  metafilePath = DEFAULT_METAFILE_PATH,
} = {}) {
  const offenders = findServeFastPathBundleOffenders(
    readMetafile(metafilePath),
  );
  return { ok: offenders.length === 0, offenders };
}

export function checkAcpImportBoundary({
  metafilePath = DEFAULT_METAFILE_PATH,
} = {}) {
  const offenders = findAcpImportBoundaryOffenders(readMetafile(metafilePath));
  return { ok: offenders.length === 0, offenders };
}

export function checkSdkImplProtocolBoundary({
  metafilePath = DEFAULT_METAFILE_PATH,
} = {}) {
  const offenders = findSdkImplProtocolOffenders(readMetafile(metafilePath));
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

    const sdkImplResult = checkSdkImplProtocolBoundary();
    if (!sdkImplResult.ok) {
      console.error(
        'Telemetry sdk-impl static closure includes OTLP protocol chain modules:\n' +
          formatServeFastPathBundleOffenders(sdkImplResult.offenders),
      );
      process.exitCode = 1;
    }

    if (serveResult.ok && acpResult.ok && sdkImplResult.ok) {
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
