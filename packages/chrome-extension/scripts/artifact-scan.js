/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

// Source-level signatures catch unbundled adapter code in the root dist/
// bundle (which is not minified). The esbuild-metafile provenance scan catches
// bundled adapters in dist/extension (which IS minified, so string signatures
// would not survive). Both scans are needed.
const DEFAULT_SIGNATURES = [
  'class McpContext',
  'class PageCollector',
  'chrome-devtools-mcp/build/src',
  'node_modules/chrome-devtools-mcp',
  'puppeteer-core/lib/cjs/puppeteer',
];
const REQUIRED_ARTIFACT_FILES = ['sidepanel/capability-status.js'];

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
        findings.push({ file: `${metafilePath}:${normalized}`, signature });
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
      if (settled) return;
      settled = true;
      zip.close();
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

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.wasm',
  '.node',
  '.map',
]);

export async function scanArtifactRoots(
  roots,
  signatures = DEFAULT_SIGNATURES,
) {
  const findings = [];
  for (const root of roots) {
    for (const file of await listFiles(root)) {
      if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
      const content = await readFile(file, 'utf8');
      for (const signature of signatures) {
        if (content.includes(signature)) findings.push({ file, signature });
      }
    }
  }
  return findings;
}

// Node realpaths the ESM main entry but not process.argv[1], so comparing the
// raw paths silently skips main() under a symlinked checkout (macOS /tmp ->
// /private/tmp, symlinked worktrees). Compare realpaths on both sides.
const isMainEntry = () =>
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);

async function main() {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const repoRoot = path.resolve(packageRoot, '../..');
  const outDir = process.env.EXTENSION_OUT_DIR || 'dist/extension';
  const roots = process.argv.slice(2);
  let positionalMode = false;
  let optionalRoots;
  let requiredMetafilePaths;
  let optionalMetafilePaths;
  let zipPath;
  if (roots.length === 0) {
    roots.push(path.resolve(packageRoot, outDir));
    // The root CLI bundle and its metafile only exist after `npm run bundle`
    // (and `cross-env DEV=true npm run bundle` for the metafile), so a
    // package-level run skips them with a warning instead of failing.
    optionalRoots = [path.join(repoRoot, 'dist')];
    // Mirrors esbuild.background.config.js: the metafile lands next to the
    // output directory root, including EXTENSION_OUT_DIR overrides.
    requiredMetafilePaths = [
      path.join(
        path.dirname(path.resolve(packageRoot, outDir)),
        'esbuild.json',
      ),
    ];
    optionalMetafilePaths = [path.join(repoRoot, 'dist/esbuild.json')];
    zipPath = path.join(packageRoot, 'chrome-extension.zip');
  } else {
    console.warn(
      'artifact-scan: positional roots provided; skipping required-file, esbuild metafile, and zip scans',
    );
    positionalMode = true;
  }
  for (const root of roots) {
    await access(root).catch(() => {
      throw new Error(`Artifact directory does not exist: ${root}`);
    });
  }
  if (!positionalMode) {
    for (const root of roots) {
      for (const required of REQUIRED_ARTIFACT_FILES) {
        await access(path.join(root, required)).catch(() => {
          throw new Error(
            `Required artifact file missing: ${path.join(root, required)}`,
          );
        });
      }
    }
  }
  for (const root of optionalRoots ?? []) {
    const present = await access(root).then(
      () => true,
      () => false,
    );
    if (!present) {
      console.warn(
        `artifact-scan: skipping ${root} (run "npm run bundle" at the repo root to scan the CLI bundle)`,
      );
      continue;
    }
    roots.push(root);
  }
  const findings = await scanArtifactRoots(roots);
  const scannedMetafiles = [];
  for (const metafilePath of requiredMetafilePaths ?? []) {
    await access(metafilePath).catch(() => {
      throw new Error(
        `Esbuild metafile does not exist: ${metafilePath}. Run "npm run package" in packages/chrome-extension first.`,
      );
    });
    findings.push(...(await scanEsbuildMetafile(metafilePath)));
    scannedMetafiles.push(metafilePath);
  }
  for (const metafilePath of optionalMetafilePaths ?? []) {
    const present = await access(metafilePath).then(
      () => true,
      () => false,
    );
    if (!present) {
      console.warn(
        `artifact-scan: skipping ${metafilePath} (run "cross-env DEV=true npm run bundle" at the repo root to scan the CLI bundle)`,
      );
      continue;
    }
    findings.push(...(await scanEsbuildMetafile(metafilePath)));
    scannedMetafiles.push(metafilePath);
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
  console.log(
    `ARTIFACT-SCAN: PASS (${[...roots, ...scannedMetafiles, ...(zipPath ? [zipPath] : [])].join(', ')})`,
  );
}

if (isMainEntry()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
