#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  inspectRuntimeArchive,
  runtimeBuildProperties,
  runtimeSelection,
} from './managed-runtime-backends.mjs';

export function runtimeBuildCommands(selection, verify = false) {
  const base = [
    '--batch-mode',
    '--no-transfer-progress',
    '-f',
    'packages/managed-agent-server/pom.xml',
    '-Dgpg.skip=true',
    ...runtimeBuildProperties(selection),
  ];
  return [
    [...base, '-pl', 'server', '-am', '-DskipTests', 'clean', 'package'],
    ...(verify
      ? [
          [
            ...base,
            '-pl',
            'verification',
            '-am',
            '-Dtest=ManagedAgentPackagingIT',
            'test',
          ],
        ]
      : []),
  ];
}

export function buildRuntime({ backends = 'full', verify = false } = {}) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const selection = runtimeSelection(backends);
  for (const args of runtimeBuildCommands(selection, verify)) {
    const result = spawnSync(
      process.platform === 'win32' ? 'mvn.cmd' : 'mvn',
      args,
      {
        cwd: root,
        stdio: 'inherit',
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Maven exited with ${result.status}.`);
  }
  const pom = readFileSync(
    path.join(root, 'packages/managed-agent-server/pom.xml'),
    'utf8',
  );
  const version = pom.match(
    /<artifactId>qwen-managed-agent-parent<\/artifactId>\s*<version>([^<]+)<\/version>/,
  )?.[1];
  if (!version) throw new Error('Cannot read Managed Agent version.');
  const jar = path.join(
    root,
    'packages/managed-agent-server/server/target',
    `qwen-managed-agent-server-${version}-${selection.classifier}.jar`,
  );
  inspectRuntimeArchive(jar, selection);
  return jar;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { values } = parseArgs({
      options: {
        backends: { type: 'string', default: 'full' },
        verify: { type: 'boolean', default: false },
      },
    });
    console.log(buildRuntime(values));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
