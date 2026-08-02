#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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
const electronBridgeScript = path.join(
  repoRoot,
  '.github',
  'scripts',
  'create-electron-bridge-manifest.mjs',
);
const versionScript = path.join(packageDir, 'scripts', 'version.js');

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'qwen-desktop-release-test-'),
);
try {
  testBootstrapBridgeConfiguration();
  testLegacyApplicationIdentity();
  testElectronBridgeWorkflow();
  testUpdateManifest(path.join(root, 'manifest'));
  testElectronBridgeManifest(path.join(root, 'electron-bridge'));
  testVersionSynchronization(path.join(root, 'version'));
  console.log('Desktop release helper checks passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function testLegacyApplicationIdentity() {
  const config = JSON.parse(
    fs.readFileSync(
      path.join(packageDir, 'src-tauri', 'tauri.conf.json'),
      'utf8',
    ),
  );
  assert.equal(config.productName, 'Qwen Code Desktop');
  assert.equal(config.identifier, 'com.alibaba.qwen-code');
}

function testElectronBridgeWorkflow() {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'desktop-release.yml'),
    'utf8',
  );
  assert.match(workflow, /^ {6}electron_bridge:$/m);
  assert.match(workflow, /create-electron-bridge-manifest\.mjs/);
  for (const artifact of [
    'Qwen-Code-Desktop-arm64.zip',
    'Qwen-Code-Desktop-x64.zip',
    'Qwen-Code-Desktop-arm64.dmg',
    'Qwen-Code-Desktop-x64.dmg',
  ]) {
    assert.match(workflow, new RegExp(artifact.replaceAll('.', '\\.')));
  }
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

function testElectronBridgeManifest(directory) {
  const assets = path.join(directory, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  const artifacts = [
    'Qwen-Code-Desktop-arm64.zip',
    'Qwen-Code-Desktop-x64.zip',
    'Qwen-Code-Desktop-arm64.dmg',
    'Qwen-Code-Desktop-x64.dmg',
  ];
  for (const artifact of artifacts) {
    fs.writeFileSync(path.join(assets, artifact), `contents:${artifact}`);
  }
  const output = path.join(directory, 'latest-mac.yml');
  execFileSync(process.execPath, [
    electronBridgeScript,
    '--assets',
    assets,
    '--version',
    '0.1.0',
    '--release-date',
    '2026-08-03T00:00:00.000Z',
    '--output',
    output,
  ]);
  const manifest = fs.readFileSync(output, 'utf8');
  assert.match(manifest, /^version: 0\.1\.0$/m);
  assert.match(manifest, /^releaseDate: '2026-08-03T00:00:00\.000Z'$/m);
  for (const artifact of artifacts) {
    const contents = fs.readFileSync(path.join(assets, artifact));
    const sha512 = crypto
      .createHash('sha512')
      .update(contents)
      .digest('base64');
    assert.match(
      manifest,
      new RegExp(
        `^  - url: ${artifact.replaceAll('.', '\\.')}\\n    sha512: ${sha512.replaceAll('+', '\\+')}\\n    size: ${contents.length}$`,
        'm',
      ),
    );
  }
  const arm64Contents = fs.readFileSync(path.join(assets, artifacts[0]));
  const arm64Sha512 = crypto
    .createHash('sha512')
    .update(arm64Contents)
    .digest('base64');
  assert.match(manifest, /^path: Qwen-Code-Desktop-arm64\.zip$/m);
  assert.match(
    manifest,
    new RegExp(`^sha512: ${arm64Sha512.replaceAll('+', '\\+')}$`, 'm'),
  );

  fs.rmSync(path.join(assets, artifacts[1]));
  const failure = spawnSync(
    process.execPath,
    [
      electronBridgeScript,
      '--assets',
      assets,
      '--version',
      '0.1.0',
      '--output',
      output,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /Missing Electron bridge artifact/);
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
