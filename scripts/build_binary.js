/**
 * Build a Node SEA (Single Executable Application) binary for qwen-code.
 *
 * Ported from gemini-cli/scripts/build_binary.js. Key differences:
 *   - Bundle path: dist/cli.js (qwen-code esbuild output)
 *   - SEA asset name: cli.mjs (was gemini.mjs)
 *   - Binary name: qwen-code (was gemini)
 *   - SEA launcher: sea/sea-launch.cjs
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  rmSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { globSync } from 'glob';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distDir = join(root, 'dist');
const bundleDir = distDir;
const stagingDir = join(distDir, 'native_modules');
const seaConfigPath = join(root, 'sea-config.json');
const manifestPath = join(distDir, 'manifest.json');

function runCommand(command, args, options = {}) {
  let finalCommand = command;
  let useShell = options.shell || false;

  if (
    process.platform === 'win32' &&
    (command === 'npm' || command === 'npx')
  ) {
    finalCommand = `${command}.cmd`;
    useShell = true;
  }

  const finalOptions = {
    stdio: 'inherit',
    cwd: root,
    shell: useShell,
    ...options,
  };

  const result = spawnSync(finalCommand, args, finalOptions);

  if (result.status !== 0) {
    if (result.error) {
      throw result.error;
    }
    throw new Error(
      `Command failed with exit code ${result.status}: ${command}`,
    );
  }

  return result;
}

function removeSignature(filePath) {
  console.log(`Removing signature from ${filePath}...`);
  try {
    if (process.platform === 'darwin') {
      spawnSync('codesign', ['--remove-signature', filePath], {
        stdio: 'ignore',
      });
    }
  } catch {
    // Best effort
  }
}

function signFile(filePath) {
  if (process.platform === 'darwin') {
    const identity = process.env.APPLE_IDENTITY || '-';
    console.log(`Signing ${filePath} (Identity: ${identity})...`);
    runCommand('codesign', [
      '--sign',
      identity,
      '--force',
      '--timestamp',
      '--options',
      'runtime',
      filePath,
    ]);
  } else if (process.platform === 'linux') {
    console.log(`Skipping signing for ${filePath} on Linux.`);
  }
}

console.log('Build Binary Script Started...');

const outputDir = join(distDir, 'binary');
if (existsSync(outputDir)) {
  rmSync(outputDir, { recursive: true, force: true });
}
mkdirSync(outputDir, { recursive: true });

const cliBundlePath = join(distDir, 'cli.js');
if (!existsSync(cliBundlePath)) {
  console.error('Error: dist/cli.js not found. Run `npm run bundle` first.');
  process.exit(1);
}

const includeNativeModules = process.env.BUNDLE_NATIVE_MODULES !== 'false';
console.log(`Include Native Modules: ${includeNativeModules}`);

if (includeNativeModules) {
  console.log('Staging native modules...');
  if (existsSync(stagingDir))
    rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  const lydellSrc = join(root, 'node_modules/@lydell');
  const lydellStaging = join(stagingDir, 'node_modules/@lydell');

  if (existsSync(lydellSrc)) {
    mkdirSync(dirname(lydellStaging), { recursive: true });
    cpSync(lydellSrc, lydellStaging, { recursive: true });
  } else {
    console.warn('Warning: @lydell/node-pty not found.');
  }

  const clipboardSrc = join(root, 'node_modules/@teddyzhu');
  const clipboardStaging = join(stagingDir, 'node_modules/@teddyzhu');
  if (existsSync(clipboardSrc)) {
    mkdirSync(dirname(clipboardStaging), { recursive: true });
    cpSync(clipboardSrc, clipboardStaging, { recursive: true });
  }

  try {
    const nodeFiles = globSync('**/*.node', {
      cwd: stagingDir,
      absolute: true,
    });
    for (const file of nodeFiles) {
      signFile(file);
    }
  } catch (e) {
    console.warn('Warning: Failed to sign native modules:', e.code);
  }
} else {
  console.log('Skipping native modules (BUNDLE_NATIVE_MODULES=false)');
}

console.log('Generating SEA configuration and manifest...');
const packageJson = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
);

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

const cliContent = readFileSync(cliBundlePath);
const cliHash = sha256(cliContent);

const assets = {
  'cli.mjs': cliBundlePath,
  'manifest.json': manifestPath,
};

const manifest = {
  main: 'cli.mjs',
  mainHash: cliHash,
  version: packageJson.version,
  files: [],
};

function addAssetsFromDir(baseDir, runtimePrefix) {
  const fullDir = join(stagingDir, baseDir);
  if (!existsSync(fullDir)) return;

  const items = globSync('**/*', { cwd: fullDir, nodir: true });
  for (const item of items) {
    const relativePath = join(runtimePrefix, item);
    const assetKey = `files:${relativePath}`;
    const fsPath = join(fullDir, item);

    const content = readFileSync(fsPath);
    const hash = sha256(content);

    assets[assetKey] = fsPath;
    manifest.files.push({ key: assetKey, path: relativePath, hash: hash });
  }
}

// Add .sb sandbox profiles if present
const sbFiles = globSync('sandbox-macos-*.sb', { cwd: bundleDir });
for (const sbFile of sbFiles) {
  const fsPath = join(bundleDir, sbFile);
  const content = readFileSync(fsPath);
  const hash = sha256(content);
  assets[sbFile] = fsPath;
  manifest.files.push({ key: sbFile, path: sbFile, hash: hash });
}

// Add vendor dir (ripgrep binaries) if present
const vendorDir = join(distDir, 'vendor');
if (existsSync(vendorDir)) {
  const vendorFiles = globSync('**/*', { cwd: vendorDir, nodir: true });
  for (const vf of vendorFiles) {
    const fsPath = join(vendorDir, vf);
    const relativePath = join('vendor', vf);
    const assetKey = `vendor:${vf}`;
    const content = readFileSync(fsPath);
    const hash = sha256(content);
    assets[assetKey] = fsPath;
    manifest.files.push({ key: assetKey, path: relativePath, hash: hash });
  }
}

if (includeNativeModules) {
  addAssetsFromDir('node_modules/@lydell', 'node_modules/@lydell');
  addAssetsFromDir('node_modules/@teddyzhu', 'node_modules/@teddyzhu');
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const seaConfig = {
  main: 'sea/sea-launch.cjs',
  output: 'dist/binary/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  assets: assets,
};

writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
console.log(`Configured ${Object.keys(assets).length} embedded assets.`);

console.log('Generating SEA blob...');
try {
  runCommand('node', ['--experimental-sea-config', 'sea-config.json']);
} catch (e) {
  console.error('Failed to generate SEA blob:', e.message);
  if (existsSync(seaConfigPath)) rmSync(seaConfigPath);
  if (existsSync(manifestPath)) rmSync(manifestPath);
  if (existsSync(stagingDir))
    rmSync(stagingDir, { recursive: true, force: true });
  process.exit(1);
}

const blobPath = join(outputDir, 'sea-prep.blob');
if (!existsSync(blobPath)) {
  console.error('Error: sea-prep.blob not found.');
  process.exit(1);
}

const platform = process.platform;
const arch = process.arch;
const targetName = `${platform}-${arch}`;
console.log(`Targeting: ${targetName}`);

const targetDir = join(outputDir, targetName);
mkdirSync(targetDir, { recursive: true });

const nodeBinary = process.execPath;
const binaryName = platform === 'win32' ? 'qwen-code.exe' : 'qwen-code';
const targetBinaryPath = join(targetDir, binaryName);

console.log(`Copying node binary from ${nodeBinary} to ${targetBinaryPath}...`);
copyFileSync(nodeBinary, targetBinaryPath);

if (platform === 'darwin') {
  const fileResult = spawnSync('file', [targetBinaryPath], {
    encoding: 'utf8',
  });
  if (fileResult.stdout && fileResult.stdout.includes('universal binary')) {
    console.log(`Extracting ${arch} slice from universal binary...`);
    runCommand('lipo', [
      targetBinaryPath,
      '-extract',
      arch,
      '-output',
      targetBinaryPath,
    ]);
  }
}

removeSignature(targetBinaryPath);

console.log('Injecting SEA blob...');
const sentinelFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

try {
  const args = [
    'postject',
    targetBinaryPath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    sentinelFuse,
  ];

  if (platform === 'darwin') {
    args.push('--macho-segment-name', 'NODE_SEA');
  }

  runCommand('npx', args);
  console.log('Injection successful.');
} catch (e) {
  console.error('Postject failed:', e.message);
  process.exit(1);
}

console.log('Signing final executable...');
try {
  signFile(targetBinaryPath);
} catch (e) {
  console.warn('Warning: Final signing failed:', e.code);
}

console.log('Cleaning up artifacts...');
rmSync(blobPath);
if (existsSync(seaConfigPath)) rmSync(seaConfigPath);
if (existsSync(manifestPath)) rmSync(manifestPath);
if (existsSync(stagingDir))
  rmSync(stagingDir, { recursive: true, force: true });

console.log(`\n✅ Binary built: ${targetBinaryPath}`);
