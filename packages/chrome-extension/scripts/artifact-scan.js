/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SIGNATURES = [
  'class McpContext',
  'PageCollector',
  'chrome-devtools-mcp/build/src',
  'node_modules/chrome-devtools-mcp',
  'puppeteer-core/lib/cjs/puppeteer',
];

async function listFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolutePath)));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

export async function scanArtifactRoots(
  roots,
  signatures = DEFAULT_SIGNATURES,
) {
  const findings = [];
  for (const root of roots) {
    for (const file of await listFiles(root)) {
      const content = await readFile(file, 'utf8');
      for (const signature of signatures) {
        if (content.includes(signature)) findings.push({ file, signature });
      }
    }
  }
  return findings;
}

async function main() {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const repoRoot = path.resolve(packageRoot, '../..');
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    roots.push(
      path.join(packageRoot, 'dist/extension'),
      path.join(repoRoot, 'dist'),
    );
  }
  for (const root of roots) {
    await access(root).catch(() => {
      throw new Error(`Artifact directory does not exist: ${root}`);
    });
  }
  const findings = await scanArtifactRoots(roots);
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `${finding.file}: forbidden signature ${finding.signature}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(`ARTIFACT-SCAN: PASS (${roots.join(', ')})`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
