#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repoRoot = path.resolve(packageDir, '../..');
const manifestScript = path.join(
  repoRoot,
  '.github',
  'scripts',
  'create-desktop-update-manifest.mjs',
);
const versionScript = path.join(packageDir, 'scripts', 'version.js');

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'qwen-desktop-release-test-'),
);
try {
  testBootstrapBridgeConfiguration();
  testPackagedSmokeWindowsLogPath();
  testUpdateManifest(path.join(root, 'manifest'));
  testVersionSynchronization(path.join(root, 'version'));
  console.log('Desktop release helper checks passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function testPackagedSmokeWindowsLogPath() {
  const smoke = fs.readFileSync(
    path.join(packageDir, 'scripts', 'smoke-packaged.js'),
    'utf8',
  );
  assert.match(
    smoke,
    /process\.platform === 'win32'\s*\? path\.join\(localAppData, appId, 'logs'\)/,
  );
  assert.match(
    smoke,
    /process\.platform === 'win32' && !localAppData[\s\S]*LOCALAPPDATA is required to locate Windows desktop logs/,
  );
  assert.doesNotMatch(smoke, /^\s*LOCALAPPDATA:/m);
  assert.match(smoke, /const previousLog = fs\.readFileSync\(logPath/);
  assert.ok(
    smoke.indexOf('const previousLog = fs.readFileSync(logPath') <
      smoke.indexOf('const child = spawn(executable'),
    'previousLog must be captured before the child is spawned',
  );
  assert.match(smoke, /if \(!contents\.startsWith\(previousLog\)\)/);
  assert.match(smoke, /truncated or rotated during the smoke/);
  const config = JSON.parse(
    fs.readFileSync(
      path.join(packageDir, 'src-tauri', 'tauri.conf.json'),
      'utf8',
    ),
  );
  assert.match(
    smoke,
    new RegExp(`const appId = '${config.identifier.replaceAll('.', '\\.')}'`),
  );
}

function testBootstrapBridgeConfiguration() {
  const config = JSON.parse(
    fs.readFileSync(
      path.join(packageDir, 'src-tauri', 'tauri.conf.json'),
      'utf8',
    ),
  );
  assert.equal(
    config.app?.withGlobalTauri,
    true,
    'The Bootstrap UI requires window.__TAURI__ for desktop commands.',
  );
  assert.deepEqual(
    config.app?.security?.capabilities,
    ['bootstrap'],
    'The Bootstrap UI capability must be enabled for the main window.',
  );
  const capability = JSON.parse(
    fs.readFileSync(
      path.join(packageDir, 'src-tauri', 'capabilities', 'bootstrap.json'),
      'utf8',
    ),
  );
  assert.deepEqual(capability.windows, ['main']);
  assert.equal(
    capability.remote,
    undefined,
    'The bootstrap capability must not grant remote IPC access.',
  );
  assert.deepEqual(capability.permissions, [
    'core:event:allow-listen',
    'core:event:allow-unlisten',
  ]);
}

function testUpdateManifest(directory) {
  const assets = path.join(directory, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  const artifacts = [
    'Qwen-Code-aarch64-apple-darwin.app.tar.gz',
    'Qwen-Code-x86_64-apple-darwin.app.tar.gz',
    'Qwen-Code_0.1.0_x64-setup.exe',
    'Qwen-Code_0.1.0_amd64.AppImage',
  ];
  for (const artifact of artifacts) {
    assert.ok(
      !artifact.includes(' '),
      `Artifact name must not contain spaces: ${artifact}`,
    );
  }
  for (const artifact of artifacts) {
    fs.writeFileSync(path.join(assets, artifact), artifact);
    fs.writeFileSync(
      path.join(assets, `${artifact}.sig`),
      `signature:${artifact}\n`,
    );
  }
  const output = path.join(directory, 'desktop-latest.json');
  execFileSync(process.execPath, [
    manifestScript,
    '--assets',
    assets,
    '--repository',
    'QwenLM/qwen-code',
    '--tag',
    'desktop-v0.1.0',
    '--version',
    '0.1.0',
    '--output',
    output,
  ]);
  const manifest = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [
    'darwin-aarch64',
    'darwin-x86_64',
    'linux-x86_64',
    'windows-x86_64',
  ]);
  for (const [platform, artifact] of [
    ['darwin-aarch64', artifacts[0]],
    ['darwin-x86_64', artifacts[1]],
    ['windows-x86_64', artifacts[2]],
    ['linux-x86_64', artifacts[3]],
  ]) {
    assert.equal(
      manifest.platforms[platform].signature,
      `signature:${artifact}`,
    );
    assert.equal(
      manifest.platforms[platform].url,
      `https://github.com/QwenLM/qwen-code/releases/download/desktop-v0.1.0/${encodeURIComponent(artifact)}`,
    );
  }

  fs.rmSync(path.join(assets, `${artifacts[3]}.sig`));
  const failure = spawnSync(
    process.execPath,
    [
      manifestScript,
      '--assets',
      assets,
      '--repository',
      'QwenLM/qwen-code',
      '--tag',
      'desktop-v0.1.0',
      '--version',
      '0.1.0',
      '--output',
      output,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /Missing updater signature/);
}

function testVersionSynchronization(directory) {
  fs.mkdirSync(path.join(directory, 'src-tauri'), { recursive: true });
  fs.copyFileSync(
    path.join(packageDir, 'package.json'),
    path.join(directory, 'package.json'),
  );
  fs.copyFileSync(
    path.join(packageDir, 'src-tauri', 'Cargo.toml'),
    path.join(directory, 'src-tauri', 'Cargo.toml'),
  );
  fs.copyFileSync(
    path.join(packageDir, 'src-tauri', 'tauri.conf.json'),
    path.join(directory, 'src-tauri', 'tauri.conf.json'),
  );
  execFileSync(process.execPath, [versionScript, '1.2.3'], {
    cwd: directory,
    env: { ...process.env, QWEN_DESKTOP_PACKAGE_DIR: directory },
  });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
      .version,
    '1.2.3',
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(directory, 'src-tauri', 'tauri.conf.json'),
        'utf8',
      ),
    ).version,
    '1.2.3',
  );
  assert.match(
    fs.readFileSync(path.join(directory, 'src-tauri', 'Cargo.toml'), 'utf8'),
    /^version = "1\.2\.3"$/m,
  );
}
