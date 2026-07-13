/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

const DEFAULT_SIGNATURES = [
  'class McpContext',
  'PageCollector',
  'chrome-devtools-mcp/build/src',
  'node_modules/chrome-devtools-mcp',
  'puppeteer-core/lib/cjs/puppeteer',
];
const DEFAULT_PROVENANCE_SIGNATURES = [
  'node_modules/chrome-devtools-mcp/',
  'node_modules/puppeteer-core/',
];

async function listFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolutePath)));
    else if (entry.isFile()) files.push(absolutePath);
    else if (entry.isSymbolicLink()) {
      throw new Error(
        `Symbolic links are not allowed in release artifacts: ${absolutePath}`,
      );
    }
  }
  return files;
}

export async function scanEsbuildMetafile(
  metafilePath,
  signatures = DEFAULT_PROVENANCE_SIGNATURES,
) {
  const metafile = JSON.parse(await readFile(metafilePath, 'utf8'));
  const findings = [];
  for (const input of Object.keys(metafile.inputs ?? {})) {
    const normalized = input.replaceAll('\\', '/');
    for (const signature of signatures) {
      if (normalized.includes(signature)) {
        findings.push({ file: metafilePath, signature });
      }
    }
  }
  return findings;
}

const openZip = (zipPath) =>
  new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });

export async function readZipEntries(zipPath) {
  await access(zipPath).catch(() => {
    throw new Error(`Artifact archive does not exist: ${zipPath}`);
  });
  const zip = await openZip(zipPath);
  return new Promise((resolve, reject) => {
    const entries = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.once('error', fail);
    zip.once('end', () => {
      settled = true;
      resolve(entries);
    });
    zip.on('entry', (entry) => {
      const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (unixType === 0o120000) {
        fail(
          new Error(
            `Symbolic links are not allowed in release artifacts: ${entry.fileName}`,
          ),
        );
        return;
      }
      if (entry.fileName.endsWith('/')) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.once('error', fail);
        stream.once('end', () => {
          entries.push({
            name: entry.fileName,
            content: Buffer.concat(chunks),
          });
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}

export async function scanZipArtifact(
  zipPath,
  signatures = DEFAULT_SIGNATURES,
) {
  const findings = [];
  for (const entry of await readZipEntries(zipPath)) {
    const content = entry.content.toString('utf8');
    for (const signature of signatures) {
      if (content.includes(signature)) {
        findings.push({ file: `${zipPath}:${entry.name}`, signature });
      }
    }
  }
  return findings;
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
  let metafilePaths;
  let zipPath;
  if (roots.length === 0) {
    roots.push(
      path.join(packageRoot, 'dist/extension'),
      path.join(repoRoot, 'dist'),
    );
    metafilePaths = [
      path.join(repoRoot, 'dist/esbuild.json'),
      path.join(packageRoot, 'dist/esbuild.json'),
    ];
    zipPath = path.join(packageRoot, 'chrome-extension.zip');
  }
  for (const root of roots) {
    await access(root).catch(() => {
      throw new Error(`Artifact directory does not exist: ${root}`);
    });
  }
  const findings = await scanArtifactRoots(roots);
  for (const metafilePath of metafilePaths ?? []) {
    await access(metafilePath).catch(() => {
      throw new Error(`Esbuild metafile does not exist: ${metafilePath}`);
    });
    findings.push(...(await scanEsbuildMetafile(metafilePath)));
  }
  if (zipPath) findings.push(...(await scanZipArtifact(zipPath)));
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
