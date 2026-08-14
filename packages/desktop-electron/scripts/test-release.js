#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repoRoot = path.resolve(packageDir, '../..');
const manifest = readJson(path.join(packageDir, 'package.json'));
const tauriManifest = readJson(
  path.join(repoRoot, 'packages/desktop-shell/src-tauri/tauri.conf.json'),
);
const workflow = fs.readFileSync(
  path.join(repoRoot, '.github/workflows/desktop-electron-build.yml'),
  'utf8',
);
const ciWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github/workflows/desktop-electron-ci.yml'),
  'utf8',
);
const rootCiWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github/workflows/ci.yml'),
  'utf8',
);

testPackageIdentity();
testSecurityBoundary();
testWebShellOwnership();
testReleaseWorkflow();
testVersionSynchronization();
console.log('Electron desktop isolation checks passed.');

function testPackageIdentity() {
  assert.equal(manifest.name, '@qwen-code/desktop-electron');
  assert.equal(manifest.main, 'dist/main/index.cjs');
  assert.equal(manifest.build.appId, 'com.alibaba.qwen-code.electron-preview');
  assert.equal(
    manifest.build.productName,
    'Qwen Code Desktop Electron Preview',
  );
  assert.equal(
    manifest.build.mac.executableName,
    'Qwen Code Desktop Electron Preview',
  );
  assert.equal(
    manifest.build.executableName,
    'qwen-code-desktop-electron-preview',
  );
  assert.notEqual(manifest.build.appId, tauriManifest.identifier);
  assert.notEqual(manifest.build.productName, tauriManifest.productName);
  assert.equal(
    manifest.build.mac.extendInfo.NSMicrophoneUsageDescription,
    'Qwen Code uses the microphone for voice input and realtime conversations.',
  );
  assert.equal(manifest.build.asar, true);
  assert.equal(
    manifest.build.beforeBuild,
    'scripts/electron-builder-before-build.cjs',
  );
  assert.deepEqual(manifest.build.extraResources, [
    { from: 'runtime/qwen-code', to: 'runtime/qwen-code' },
  ]);
  assert.ok(manifest.devDependencies.electron);
  assert.ok(manifest.devDependencies['electron-builder']);
  assert.equal(manifest.dependencies?.['electron-updater'], undefined);
  assert.equal(manifest.build.publish, null);
  assert.equal(manifest.devDependencies['@tauri-apps/cli'], undefined);
  assert.equal(manifest.scripts.tauri, undefined);
}

function testSecurityBoundary() {
  const main = fs.readFileSync(
    path.join(packageDir, 'src/main/index.ts'),
    'utf8',
  );
  const preload = fs.readFileSync(
    path.join(packageDir, 'src/preload/index.ts'),
    'utf8',
  );
  const runtime = fs.readFileSync(
    path.join(packageDir, 'src/main/runtime.ts'),
    'utf8',
  );
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /mediaTypes\[0\] === 'audio'/);
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.doesNotMatch(preload, /ipcRenderer\.(?:send|sendSync|postMessage)/);
  assert.match(runtime, /--require-auth/);
  assert.match(runtime, /--allow-origin/);
  assert.match(runtime, /qwen-desktop:\/\/app/);
  assert.match(runtime, /127\.0\.0\.1/);
}

function testWebShellOwnership() {
  const renderer = fs.readFileSync(
    path.join(packageDir, 'src/renderer/main.tsx'),
    'utf8',
  );
  assert.match(
    renderer,
    /import \{[\s\S]*WebShellWithProviders[\s\S]*\} from '@qwen-code\/web-shell'/,
  );
  assert.match(renderer, /<WebShellWithProviders/);
  assert.match(renderer, /compactThinking/);
  assert.match(renderer, /markdownTableMode="advanced"/);
  const types = fs.readFileSync(
    path.join(packageDir, 'src/shared/types.ts'),
    'utf8',
  );
  const voiceConfig = types.match(
    /export interface VoiceOverlayLaunchConfig \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(voiceConfig);
  assert.doesNotMatch(voiceConfig, /daemonBaseUrl|daemonToken|workspace/);

  const productionFiles = listFiles(path.join(packageDir, 'src'));
  for (const file of productionFiles) {
    const contents = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      contents,
      /packages\/desktop(?:\/|')/,
      `Legacy Electron source referenced by ${file}`,
    );
    assert.doesNotMatch(contents, /@tauri-apps|__TAURI__|src-tauri/);
  }
}

function testReleaseWorkflow() {
  assert.doesNotMatch(workflow, /\btauri\b/i);
  assert.doesNotMatch(workflow, /\bcargo\b/i);
  assert.match(workflow, /electron-builder/);
  assert.match(workflow, /desktop_target: 'darwin-arm64'/);
  assert.match(workflow, /desktop_target: 'darwin-x64'/);
  assert.match(workflow, /desktop_target: 'win32-x64'/);
  assert.match(workflow, /desktop_target: 'linux-x64'/);
  assert.match(workflow, /npm run smoke:packaged/);
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/);
  assert.match(workflow, /actions\/upload-artifact/);
  assert.doesNotMatch(workflow, /gh release|desktop-latest|contents: 'write'/i);
  assert.match(ciWorkflow, /packages\/desktop-electron\/\*\*/);
  assert.match(ciWorkflow, /packages\/web-shell\/\*\*/);
  assert.doesNotMatch(rootCiWorkflow, /desktop_electron|desktop-electron/i);
}

function testVersionSynchronization() {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qwen-electron-version-'),
  );
  try {
    fs.copyFileSync(
      path.join(packageDir, 'package.json'),
      path.join(temporary, 'package.json'),
    );
    fs.copyFileSync(
      path.join(packageDir, 'package-lock.json'),
      path.join(temporary, 'package-lock.json'),
    );
    const stagedManifest = readJson(path.join(temporary, 'package.json'));
    stagedManifest.version = '9.8.7';
    fs.writeFileSync(
      path.join(temporary, 'package.json'),
      `${JSON.stringify(stagedManifest, null, 2)}\n`,
    );
    const staleLock = readJson(path.join(temporary, 'package-lock.json'));
    staleLock.version = '9.8.7';
    staleLock.packages[''].version = '0.0.0';
    fs.writeFileSync(
      path.join(temporary, 'package-lock.json'),
      `${JSON.stringify(staleLock, null, 2)}\n`,
    );
    execFileSync(
      process.execPath,
      [path.join(packageDir, 'scripts/version.js'), '9.8.7'],
      {
        env: { ...process.env, QWEN_DESKTOP_PACKAGE_DIR: temporary },
        stdio: 'pipe',
      },
    );
    assert.equal(
      readJson(path.join(temporary, 'package.json')).version,
      '9.8.7',
    );
    const lock = readJson(path.join(temporary, 'package-lock.json'));
    assert.equal(lock.version, '9.8.7');
    assert.equal(lock.packages[''].version, '9.8.7');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function listFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolute) : [absolute];
    })
    .filter((file) => /\.(?:ts|tsx)$/.test(file) && !file.endsWith('.test.ts'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
