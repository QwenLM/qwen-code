/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prepares the bundled CLI package for npm publishing
 * This script adds publishing metadata (package.json, README, LICENSE) to dist/
 * All runtime assets (cli.js, vendor/, *.sb) are already in dist/ from the bundle step
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRootDir = path.resolve(__dirname, '..');
const TEST_FILE_RE = /\.(test|spec)\.(d\.)?[mc]?[jt]s(\.map)?$/;
const CDP_TUNNEL_OPTIONAL_DEPENDENCIES = [
  'chrome-devtools-mcp',
  'puppeteer-core',
];
const PUBLISHED_PATCH_FILES = ['chrome-devtools-mcp+1.4.0.patch'];

export function preparePackage({
  rootDir = defaultRootDir,
  requireNativeAudioCapture = process.env
    .QWEN_REQUIRE_AUDIO_CAPTURE_PREBUILD === '1',
} = {}) {
  const distDir = path.join(rootDir, 'dist');

  verifyBundleArtifacts(rootDir, distDir);
  copyDocumentationFiles(rootDir, distDir);
  copyPublishedPatches(rootDir, distDir);
  copyLocales(rootDir, distDir);
  copyExtensionExamples(rootDir, distDir);
  const bundleNativeAudioCapture = copyNativeAudioCapturePackage(
    rootDir,
    distDir,
    { required: requireNativeAudioCapture },
  );
  writeDistPackageJson(rootDir, distDir, { bundleNativeAudioCapture });
  printPackageStructure(distDir);
}

if (isDirectRun()) {
  preparePackage();
}

function isDirectRun() {
  return process.argv[1]
    ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
    : false;
}

function verifyBundleArtifacts(rootDir, distDir) {
  const requiredPaths = [
    path.join(distDir, 'cli.js'),
    path.join(distDir, 'vendor'),
    path.join(distDir, 'bundled', 'qc-helper', 'docs'),
    // The Web Shell ships with the published package ("Web Shell out of the
    // box"). Gate on it here so a build that skipped the web-shell workspace
    // (e.g. `npm ci --ignore-scripts` bypassing the root `prepare`) fails
    // loudly during packaging instead of silently publishing an API-only CLI
    // whose `GET /` 404s. copy_bundle_assets.js stays warn-and-skip for
    // --cli-only dev bundles; this is the release gate.
    path.join(distDir, 'web-shell', 'index.html'),
    path.join(distDir, 'web-shell', 'assets'),
  ];

  if (!fs.existsSync(distDir)) {
    console.error('Error: dist/ directory not found');
    console.error('Please run "npm run bundle" first');
    process.exit(1);
  }

  for (const requiredPath of requiredPaths) {
    if (!fs.existsSync(requiredPath)) {
      console.error(
        `Error: Required package artifact not found: ${requiredPath}`,
      );
      console.error('Please run "npm run bundle" first');
      process.exit(1);
    }
  }
}

function copyDocumentationFiles(rootDir, distDir) {
  console.log('Copying documentation files...');
  const filesToCopy = ['README.md', 'LICENSE'];
  for (const file of filesToCopy) {
    const sourcePath = path.join(rootDir, file);
    const destPath = path.join(distDir, file);
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, destPath);
      console.log(`Copied ${file}`);
    } else {
      console.warn(`Warning: ${file} not found at ${sourcePath}`);
    }
  }
}

function copyPublishedPatches(rootDir, distDir) {
  console.log('Copying published dependency patches...');
  const patchesDestDir = path.join(distDir, 'patches');
  fs.rmSync(patchesDestDir, { recursive: true, force: true });
  fs.mkdirSync(patchesDestDir, { recursive: true });

  for (const patchFile of PUBLISHED_PATCH_FILES) {
    const sourcePath = path.join(rootDir, 'patches', patchFile);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Required published patch not found: ${sourcePath}`);
    }
    fs.copyFileSync(sourcePath, path.join(patchesDestDir, patchFile));
    console.log(`Copied ${patchFile}`);
  }
}

function copyLocales(rootDir, distDir) {
  console.log('Copying locales folder...');
  const localesSourceDir = path.join(
    rootDir,
    'packages',
    'cli',
    'src',
    'i18n',
    'locales',
  );
  const localesDestDir = path.join(distDir, 'locales');

  if (fs.existsSync(localesSourceDir)) {
    copyRecursiveSync(localesSourceDir, localesDestDir);
    console.log('Copied locales folder');
  } else {
    console.warn(`Warning: locales folder not found at ${localesSourceDir}`);
  }
}

function copyExtensionExamples(rootDir, distDir) {
  console.log('Copying extension examples folder...');
  const extensionExamplesDir = path.join(
    rootDir,
    'packages',
    'cli',
    'src',
    'commands',
    'extensions',
    'examples',
  );
  const extensionExamplesDestDir = path.join(distDir, 'examples');

  if (fs.existsSync(extensionExamplesDir)) {
    copyRecursiveSync(extensionExamplesDir, extensionExamplesDestDir);
    console.log('Copied extension examples folder');
  } else {
    console.warn(
      `Warning: extension examples folder not found at ${extensionExamplesDir}`,
    );
  }
}

function copyNativeAudioCapturePackage(rootDir, distDir, { required } = {}) {
  console.log('Copying native audio capture package...');

  const addonSrc = path.join(rootDir, 'packages', 'audio-capture');
  const addonDest = path.join(
    distDir,
    'node_modules',
    '@qwen-code',
    'audio-capture',
  );
  const requiredPaths = [
    path.join(addonSrc, 'dist'),
    path.join(addonSrc, 'prebuilds'),
    path.join(addonSrc, 'package.json'),
  ];

  fs.rmSync(addonDest, { recursive: true, force: true });

  for (const requiredPath of requiredPaths) {
    if (!fs.existsSync(requiredPath)) {
      const message = `audio capture package artifact not found at ${requiredPath}`;
      if (required) {
        throw new Error(
          `Required ${message}. ` +
            'Cannot publish package without native voice capture.',
        );
      }
      console.warn(`Warning: ${message}`);
      return false;
    }
  }
  for (const [artifactPath, description, predicate] of [
    [
      path.join(addonSrc, 'dist'),
      'runtime JS',
      (filePath) => /\.[cm]?js$/.test(filePath) && !TEST_FILE_RE.test(filePath),
    ],
    [
      path.join(addonSrc, 'prebuilds'),
      'native prebuild',
      (filePath) => filePath.endsWith('.node'),
    ],
  ]) {
    if (!hasFileMatching(artifactPath, predicate)) {
      const message = `audio capture package artifact has no ${description}: ${artifactPath}`;
      if (required) {
        throw new Error(
          `Required ${message}. ` +
            'Cannot publish package without native voice capture.',
        );
      }
      console.warn(`Warning: ${message}`);
      return false;
    }
  }

  let addonPkg;
  try {
    addonPkg = JSON.parse(
      fs.readFileSync(path.join(addonSrc, 'package.json'), 'utf8'),
    );
  } catch {
    const message = `audio capture package.json is not valid JSON at ${path.join(
      addonSrc,
      'package.json',
    )}`;
    if (required) {
      throw new Error(
        `Required ${message}. ` +
          'Cannot publish package without native voice capture.',
      );
    }
    console.warn(`Warning: ${message}`);
    return false;
  }
  const dependencySources = [];
  const addonRequire = createRequire(path.join(addonSrc, 'package.json'));
  for (const dependencyName of Object.keys(addonPkg.dependencies ?? {})) {
    try {
      dependencySources.push([
        dependencyName,
        path.dirname(addonRequire.resolve(`${dependencyName}/package.json`)),
      ]);
    } catch {
      const message = `audio capture dependency not resolvable: ${dependencyName}`;
      if (required) {
        throw new Error(
          `Required ${message}. ` +
            'Cannot publish package without native voice capture.',
        );
      }
      console.warn(`Warning: ${message}`);
      return false;
    }
  }

  delete addonPkg.scripts;
  delete addonPkg.devDependencies;

  const copyOpts = {
    recursive: true,
    dereference: true,
    verbatimSymlinks: false,
  };

  fs.mkdirSync(addonDest, { recursive: true });

  fs.writeFileSync(
    path.join(addonDest, 'package.json'),
    JSON.stringify(addonPkg, null, 2) + '\n',
  );
  fs.cpSync(path.join(addonSrc, 'dist'), path.join(addonDest, 'dist'), {
    ...copyOpts,
    filter: (src) => !TEST_FILE_RE.test(src),
  });
  fs.cpSync(
    path.join(addonSrc, 'prebuilds'),
    path.join(addonDest, 'prebuilds'),
    {
      ...copyOpts,
      filter: (src) => {
        const stat = fs.statSync(src);
        return stat.isDirectory() || src.endsWith('.node');
      },
    },
  );

  for (const [dependencyName, dependencySrc] of dependencySources) {
    fs.cpSync(
      dependencySrc,
      path.join(addonDest, 'node_modules', dependencyName),
      copyOpts,
    );
  }

  console.log('Copied native audio capture package');
  return true;
}

function hasFileMatching(dir, predicate) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      if (hasFileMatching(entryPath, predicate)) return true;
    } else if (stat.isFile() && predicate(entryPath)) {
      return true;
    }
  }
  return false;
}

function writeDistPackageJson(
  rootDir,
  distDir,
  { bundleNativeAudioCapture = false } = {},
) {
  console.log('Creating package.json for distribution...');

  const cliEntryContent = `#!/usr/bin/env node
import module from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, 'cli.js');

function isServeCommand() {
  return process.argv[2] === 'serve';
}

if (isServeCommand()) {
  module.enableCompileCache?.();
  process.argv[1] = cliPath;
  await import(pathToFileURL(cliPath).href);
} else {
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', cliPath, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );

  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exit(result.status ?? 1);
  }
}
`;

  const cliEntryPath = path.join(distDir, 'cli-entry.js');
  fs.writeFileSync(cliEntryPath, cliEntryContent, { mode: 0o755 });
  console.log('Created dist cli-entry.js wrapper');

  const postinstallContent = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolvePackageJson(packageName) {
  try {
    return require.resolve(packageName + '/package.json');
  } catch {
    return undefined;
  }
}

function findInstallRoot(packageJsonPath) {
  let dir = path.dirname(packageJsonPath);
  while (dir !== path.parse(dir).root) {
    const parent = path.dirname(dir);
    if (path.basename(parent) === 'node_modules') {
      return path.dirname(parent);
    }
    dir = parent;
  }
  return undefined;
}

const chromeDevtoolsMcpPackageJson = resolvePackageJson('chrome-devtools-mcp');
if (chromeDevtoolsMcpPackageJson) {
  const installRoot = findInstallRoot(chromeDevtoolsMcpPackageJson);
  const patchDir = path.join(__dirname, 'patches');
  if (!installRoot || !existsSync(patchDir)) {
    process.exit(0);
  }
  const relativePatchDir = path.relative(installRoot, patchDir) || '.';
  const patchPackageBin = require.resolve('patch-package/index.js');
  const result = spawnSync(
    process.execPath,
    [patchPackageBin, '--patch-dir', relativePatchDir, '--error-on-fail'],
    { cwd: installRoot, stdio: 'inherit' },
  );
  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exit(result.status ?? 1);
  }
}
`;

  const postinstallPath = path.join(distDir, 'postinstall.js');
  fs.writeFileSync(postinstallPath, postinstallContent, { mode: 0o755 });
  console.log('Created dist postinstall.js');

  const rootPackageJson = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'),
  );
  const cdpTunnelOptionalDependencies = pickRequiredDependencies(
    rootPackageJson.optionalDependencies,
    CDP_TUNNEL_OPTIONAL_DEPENDENCIES,
    'optionalDependencies',
  );
  const patchPackageDependency = pickRequiredDependencies(
    { ...rootPackageJson.dependencies, ...rootPackageJson.devDependencies },
    ['patch-package'],
    'dependencies/devDependencies',
  );

  const distPackageJson = {
    name: rootPackageJson.name,
    version: rootPackageJson.version,
    description:
      rootPackageJson.description || 'Qwen Code - AI-powered coding assistant',
    repository: rootPackageJson.repository,
    type: 'module',
    main: 'cli.js',
    bin: {
      qwen: 'cli-entry.js',
    },
    scripts: {
      postinstall: 'node postinstall.js',
    },
    files: [
      'cli-entry.js',
      'postinstall.js',
      'cli.js',
      // Worker thread entry loaded by FzfWorkerHandle at runtime via
      // `resolveBundleDir(import.meta.url)` + `path.join(dir, 'fzfWorker.js')`.
      // Must ship in the tarball or the @-picker silently falls back to the
      // in-thread AsyncFzf path on big workspaces in npm-installed CLIs.
      'fzfWorker.js',
      'chunks',
      'vendor',
      '*.sb',
      'README.md',
      'LICENSE',
      'locales',
      'examples',
      'bundled',
      'web-shell',
      'patches',
    ],
    ...(bundleNativeAudioCapture
      ? { bundledDependencies: ['@qwen-code/audio-capture'] }
      : {}),
    config: rootPackageJson.config,
    dependencies: {
      ...patchPackageDependency,
    },
    optionalDependencies: {
      '@qwen-code/audio-capture': rootPackageJson.version,
      '@lydell/node-pty': '1.2.0-beta.10',
      '@lydell/node-pty-darwin-arm64': '1.2.0-beta.10',
      '@lydell/node-pty-darwin-x64': '1.2.0-beta.10',
      '@lydell/node-pty-linux-x64': '1.2.0-beta.10',
      '@lydell/node-pty-win32-arm64': '1.2.0-beta.10',
      '@lydell/node-pty-win32-x64': '1.2.0-beta.10',
      '@teddyzhu/clipboard': '0.0.5',
      '@teddyzhu/clipboard-darwin-arm64': '0.0.5',
      '@teddyzhu/clipboard-darwin-x64': '0.0.5',
      '@teddyzhu/clipboard-linux-x64-gnu': '0.0.5',
      '@teddyzhu/clipboard-linux-arm64-gnu': '0.0.5',
      '@teddyzhu/clipboard-win32-x64-msvc': '0.0.5',
      '@teddyzhu/clipboard-win32-arm64-msvc': '0.0.5',
      ...cdpTunnelOptionalDependencies,
    },
    engines: rootPackageJson.engines,
  };

  fs.writeFileSync(
    path.join(distDir, 'package.json'),
    JSON.stringify(distPackageJson, null, 2) + '\n',
  );
}

function pickRequiredDependencies(source, dependencyNames, fieldName) {
  const result = {};
  for (const dependencyName of dependencyNames) {
    const version = source?.[dependencyName];
    if (!version) {
      throw new Error(
        `Required ${fieldName} entry missing from root package.json: ${dependencyName}`,
      );
    }
    result[dependencyName] = version;
  }
  return result;
}

function printPackageStructure(distDir) {
  console.log('\n✅ Package prepared for publishing at dist/');
  console.log('\nPackage structure:');
  // Use Node.js to list directory contents (cross-platform)
  const distFiles = fs.readdirSync(distDir);
  for (const file of distFiles) {
    const filePath = path.join(distDir, file);
    const stats = fs.statSync(filePath);
    const size = stats.isDirectory() ? '<DIR>' : formatBytes(stats.size);
    console.log(`  ${size.padEnd(12)} ${file}`);
  }
}

function copyRecursiveSync(src, dest) {
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      const srcPath = path.join(src, entry);
      const destPath = path.join(dest, entry);
      copyRecursiveSync(srcPath, destPath);
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
