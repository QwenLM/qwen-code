/**
 * Build a Node.js Single Executable Application (SEA) for qwen-code.
 *
 * Expects npm run build && npm run bundle to have already run (Dockerfile
 * handles this).  Reads the bundled output from dist/, generates a SEA
 * blob, and injects it into a copy of the node binary.
 *
 * Environment:
 *   BUNDLE_NATIVE_MODULES=false  — skip native .node addon bundling
 */

import { spawnSync } from 'node:child_process';
import {
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
const seaOutputDir = join(root, 'dist', 'binary');
const seaConfigPath = join(root, 'sea-config.json');
const manifestPath = join(distDir, 'manifest.json');

function runCommand(command, args, options = {}) {
  const finalOptions = {
    stdio: 'inherit',
    cwd: root,
    shell: options.shell || false,
    ...options,
  };

  const result = spawnSync(command, args, finalOptions);

  if (result.status !== 0) {
    if (result.error) throw result.error;
    throw new Error(
      `Command failed with exit code ${result.status}: ${command} ${args.join(' ')}`,
    );
  }
  return result;
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

console.log('=== qwen-code SEA binary build ===');

// --- Verify dist/cli.js exists (produced by prior npm run bundle) ---
const cliJsPath = join(distDir, 'cli.js');
if (!existsSync(cliJsPath)) {
  console.error(
    'Error: dist/cli.js not found. Run npm run build && npm run bundle first.',
  );
  process.exit(1);
}

// --- Prepare output directory ---
if (existsSync(seaOutputDir)) {
  rmSync(seaOutputDir, { recursive: true, force: true });
}
mkdirSync(seaOutputDir, { recursive: true });

// --- Build manifest & assets map ---
const packageJson = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
);

const cliJsContent = readFileSync(cliJsPath);
const mainHash = sha256(cliJsContent);

const manifest = {
  main: 'cli.mjs',
  mainHash,
  version: packageJson.version,
  files: [],
};

const assets = {
  'manifest.json': manifestPath,
  'cli.mjs': cliJsPath,
};

// Embed vendor files (ripgrep etc.) if present
const vendorDir = join(distDir, 'vendor');
if (existsSync(vendorDir)) {
  const vendorFiles = globSync('**/*', { cwd: vendorDir, nodir: true });
  for (const vf of vendorFiles) {
    const fsPath = join(vendorDir, vf);
    const relPath = join('vendor', vf);
    const assetKey = `files:${relPath}`;
    const content = readFileSync(fsPath);
    assets[assetKey] = fsPath;
    manifest.files.push({
      key: assetKey,
      path: relPath,
      hash: sha256(content),
    });
  }
  console.log(`Embedded ${vendorFiles.length} vendor files.`);
}

// Embed bundled skills if present
const bundledDir = join(distDir, 'bundled');
if (existsSync(bundledDir)) {
  const bundledFiles = globSync('**/*', { cwd: bundledDir, nodir: true });
  for (const bf of bundledFiles) {
    const fsPath = join(bundledDir, bf);
    const relPath = join('bundled', bf);
    const assetKey = `files:${relPath}`;
    const content = readFileSync(fsPath);
    assets[assetKey] = fsPath;
    manifest.files.push({
      key: assetKey,
      path: relPath,
      hash: sha256(content),
    });
  }
  console.log(`Embedded ${bundledFiles.length} bundled skill files.`);
}

// Write manifest
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`Configured ${Object.keys(assets).length} embedded assets.`);

// --- Generate SEA config ---
const seaConfig = {
  main: 'sea/sea-launch.cjs',
  output: 'dist/binary/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  assets,
};

writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

// --- Generate SEA blob ---
console.log('Generating SEA blob...');
try {
  runCommand('node', ['--experimental-sea-config', 'sea-config.json']);
} catch (e) {
  console.error('Failed to generate SEA blob:', e.message);
  if (existsSync(seaConfigPath)) rmSync(seaConfigPath);
  if (existsSync(manifestPath)) rmSync(manifestPath);
  process.exit(1);
}

const blobPath = join(seaOutputDir, 'sea-prep.blob');
if (!existsSync(blobPath)) {
  console.error('Error: sea-prep.blob not found after generation.');
  process.exit(1);
}

// --- Prepare target binary ---
const platform = process.platform;
const arch = process.arch;
const targetName = `${platform}-${arch}`;
console.log(`Target: ${targetName}`);

const targetDir = join(seaOutputDir, targetName);
mkdirSync(targetDir, { recursive: true });

const binaryName = platform === 'win32' ? 'qwen-code.exe' : 'qwen-code';
const targetBinaryPath = join(targetDir, binaryName);

console.log(`Copying node binary to ${targetBinaryPath}...`);
copyFileSync(process.execPath, targetBinaryPath);

// Remove existing signature (Linux is a no-op)
if (platform === 'darwin') {
  try {
    spawnSync('codesign', ['--remove-signature', targetBinaryPath], {
      stdio: 'ignore',
    });
  } catch (_e) {
    /* best effort */
  }
}

// --- Inject SEA blob ---
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

// --- Cleanup ---
console.log('Cleaning up...');
rmSync(blobPath);
if (existsSync(seaConfigPath)) rmSync(seaConfigPath);
if (existsSync(manifestPath)) rmSync(manifestPath);

console.log(`Binary built: ${targetBinaryPath}`);
