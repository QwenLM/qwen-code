#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, '..');
const computerUseSkillSource = path.resolve(
  packageRoot,
  '..',
  'core',
  'src',
  'skills',
  'bundled',
  'computer-use',
  'SKILL.md',
);
const expectedComputerUseInstructions = readFileSync(
  computerUseSkillSource,
  'utf8',
);
const npmRegistry = 'https://registry.npmjs.org';

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`missing ${flag}`);
  }
  return process.argv[index + 1];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout}` : '';
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }
  return result.stdout;
}

const outputDirectory = path.resolve(valueAfter('--output-dir'));
const manifest = JSON.parse(
  readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
);
if (manifest.name !== '@qwen-code/node-repl-mcp') {
  throw new Error(`unexpected package name ${manifest.name}`);
}

mkdirSync(outputDirectory, { recursive: true });
run('npm', ['run', 'build']);
const packOutput = JSON.parse(
  run('npm', ['pack', '.', '--pack-destination', outputDirectory, '--json'], {
    capture: true,
  }),
);
if (!Array.isArray(packOutput) || packOutput.length !== 1) {
  throw new Error('npm pack did not produce exactly one package');
}

const packed = packOutput[0];
if (packed.name !== manifest.name || packed.version !== manifest.version) {
  throw new Error(
    `packed identity ${packed.name}@${packed.version} does not match source`,
  );
}
const packedPaths = packed.files.map((entry) => entry.path);
for (const required of [
  'LICENSE',
  'README.md',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/kernel-manager.js',
  'dist/mcp-server.js',
  'dist/computer-use-skill.md',
  'dist/runtime/kernel.mjs',
  'dist/runtime/module-loader.mjs',
  'dist/runtime/tree-sitter-javascript.wasm',
]) {
  if (!packedPaths.includes(required)) {
    throw new Error(`packed Node REPL is missing ${required}`);
  }
}
const forbidden = packedPaths.find(
  (entry) => entry.startsWith('src/') || entry.includes('.test.'),
);
if (forbidden) {
  throw new Error(`packed Node REPL contains development source: ${forbidden}`);
}

const tarball = path.join(outputDirectory, packed.filename);
const tarballs = readdirSync(outputDirectory).filter((entry) =>
  entry.endsWith('.tgz'),
);
if (tarballs.length !== 1 || tarballs[0] !== packed.filename) {
  throw new Error(
    `expected exactly one Node REPL tarball, found ${tarballs.join(', ')}`,
  );
}
const remoteIntegrityResult = spawnSync(
  'npm',
  [
    'view',
    `${packed.name}@${packed.version}`,
    'dist.integrity',
    `--registry=${npmRegistry}`,
  ],
  { cwd: packageRoot, encoding: 'utf8', stdio: 'pipe' },
);
if (remoteIntegrityResult.error) throw remoteIntegrityResult.error;
const remoteIntegrity =
  remoteIntegrityResult.status === 0 ? remoteIntegrityResult.stdout.trim() : '';
if (remoteIntegrity) {
  if (remoteIntegrity !== packed.integrity) {
    throw new Error(
      `${packed.name}@${packed.version} already exists with different integrity`,
    );
  }
} else {
  run('npm', [
    'publish',
    tarball,
    '--dry-run',
    '--access',
    'public',
    '--json',
    `--registry=${npmRegistry}`,
  ]);
}

const consumer = mkdtempSync(path.join(tmpdir(), 'qwen-node-repl-consumer-'));
const textOf = (result) =>
  (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

try {
  writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify(
      { name: 'node-repl-release-smoke', private: true, type: 'module' },
      null,
      2,
    )}\n`,
  );
  run(
    'npm',
    [
      'install',
      tarball,
      '--no-audit',
      '--no-fund',
      `--registry=${npmRegistry}`,
    ],
    { cwd: consumer },
  );

  const installedRoot = path.join(
    consumer,
    'node_modules',
    '@qwen-code',
    'node-repl-mcp',
  );
  const installedManifest = JSON.parse(
    readFileSync(path.join(installedRoot, 'package.json'), 'utf8'),
  );
  if (
    installedManifest.name !== manifest.name ||
    installedManifest.version !== manifest.version
  ) {
    throw new Error('clean install resolved the wrong Node REPL package');
  }
  const serverEntry = path.join(installedRoot, 'dist', 'index.js');
  if (!existsSync(serverEntry)) {
    throw new Error('clean install is missing the Node REPL entry point');
  }
  const installedComputerUseInstructions = readFileSync(
    path.join(installedRoot, 'dist', 'computer-use-skill.md'),
    'utf8',
  );
  if (installedComputerUseInstructions !== expectedComputerUseInstructions) {
    throw new Error(
      'packed Computer Use instructions differ from the source skill',
    );
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: consumer,
  });
  const client = new Client({
    name: 'node-repl-package-smoke',
    version: '0.0.0',
  });
  try {
    await client.connect(transport);
    if (client.getInstructions() !== expectedComputerUseInstructions) {
      throw new Error(
        'MCP initialize instructions differ from the source skill',
      );
    }
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    if (
      names.join(',') !==
      'node_repl,node_repl_add_node_module_dir,node_repl_reset'
    ) {
      throw new Error(`unexpected MCP tools: ${names.join(',')}`);
    }

    await client.callTool({
      name: 'node_repl',
      arguments: { code: 'const releaseValue = 40;' },
    });
    const persisted = await client.callTool({
      name: 'node_repl',
      arguments: { code: 'nodeRepl.write(String(releaseValue + 2));' },
    });
    if (!textOf(persisted).includes('42')) {
      throw new Error('packed MCP server did not preserve cell bindings');
    }

    await client.callTool({ name: 'node_repl_reset', arguments: {} });
    const reset = await client.callTool({
      name: 'node_repl',
      arguments: { code: 'nodeRepl.write(typeof releaseValue);' },
    });
    if (!textOf(reset).includes('undefined')) {
      throw new Error('packed MCP server did not clear bindings on reset');
    }
  } finally {
    await client.close();
  }
} finally {
  rmSync(consumer, { recursive: true, force: true });
}

process.stdout.write(
  `${JSON.stringify({
    name: packed.name,
    version: packed.version,
    tarball,
    integrity: packed.integrity,
    fileCount: packed.files.length,
  })}\n`,
);
