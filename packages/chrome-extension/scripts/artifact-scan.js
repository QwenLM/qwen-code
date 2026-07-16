/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_SIGNATURES = [
  'class McpContext',
  'PageCollector',
  'chrome-devtools-mcp',
  'puppeteer-core',
  '@modelcontextprotocol/server-puppeteer',
];
const INPUT_SIGNATURES = [
  'node_modules/chrome-devtools-mcp/',
  'node_modules/puppeteer-core/',
];
const ZIP_PATH_SIGNATURES = [
  'chrome-devtools-mcp',
  'puppeteer-core',
  '@modelcontextprotocol/server-puppeteer',
];

async function filesUnder(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(file)));
    else if (entry.isFile()) files.push(file);
    else if (entry.isSymbolicLink()) {
      throw new Error(`Release artifact contains a symbolic link: ${file}`);
    }
  }
  return files;
}

async function scanRoot(root) {
  const findings = [];
  for (const file of await filesUnder(root)) {
    const content = await readFile(file, 'utf8');
    for (const signature of CONTENT_SIGNATURES) {
      if (content.includes(signature)) findings.push(`${file}: ${signature}`);
    }
  }
  return findings;
}

async function scanMetafile(file) {
  const metafile = JSON.parse(await readFile(file, 'utf8'));
  const findings = [];
  for (const input of Object.keys(metafile.inputs ?? {})) {
    const normalized = input.replaceAll('\\', '/');
    for (const signature of INPUT_SIGNATURES) {
      if (normalized.includes(signature))
        findings.push(`${file}: ${signature}`);
    }
  }
  return findings;
}

export async function scanZip(file) {
  // ZIP entry names are stored verbatim in the central directory even when
  // file bodies are deflated. The source tree is scanned for body signatures;
  // this final-archive pass catches stale or unexpected forbidden entries.
  const archive = (await readFile(file)).toString('latin1');
  return ZIP_PATH_SIGNATURES.filter((signature) =>
    archive.includes(signature),
  ).map((signature) => `${file}: ${signature}`);
}

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(scriptPath), '..');
const extensionRoot = path.join(packageRoot, 'dist/extension');
if (
  process.env.EXTENSION_OUT_DIR &&
  path.resolve(packageRoot, process.env.EXTENSION_OUT_DIR) !== extensionRoot
) {
  throw new Error('Release artifact scan requires dist/extension output');
}
const roots = [extensionRoot];
const metafiles = [path.join(packageRoot, 'dist/esbuild.json')];
const archives = [path.join(packageRoot, 'chrome-extension.zip')];

async function main() {
  const findings = [];
  for (const root of roots) {
    await access(root);
    findings.push(...(await scanRoot(root)));
  }
  for (const metafile of metafiles) {
    await access(metafile);
    findings.push(...(await scanMetafile(metafile)));
  }
  for (const archive of archives) {
    await access(archive);
    findings.push(...(await scanZip(archive)));
  }

  if (findings.length) {
    findings.forEach((finding) => console.error(finding));
    process.exitCode = 1;
  } else {
    console.log('ARTIFACT-SCAN: PASS');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
