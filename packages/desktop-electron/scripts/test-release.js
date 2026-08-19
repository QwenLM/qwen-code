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
const main = read('src/main/index.ts');
const browserPanel = read('src/main/browser-panel.ts');
const computerUse = read('src/main/computer-use.ts');
const preload = read('src/preload/index.ts');
const preloadComputerUse = read('src/preload/computer-use.ts');
const preloadPanel = read('src/preload/browser-panel.ts');
const sharedBrowserPanel = read('src/shared/browser-panel.ts');
const sharedComputerUse = read('src/shared/computer-use.ts');
const runtime = read('src/main/runtime.ts');
const runtimeBuilder = read('scripts/prepare-runtime.js');
const entitlements = read('build/entitlements.mac.plist');
const afterPack = read('scripts/electron-builder-after-pack.cjs');
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
testStandaloneWebShellOwnership();
testDesktopSurfaceScope();
testReleaseWorkflow();
testVersionSynchronization();
console.log('Electron desktop isolation and Web Shell parity checks passed.');

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
  assert.notEqual(manifest.build.appId, tauriManifest.identifier);
  assert.notEqual(manifest.build.productName, tauriManifest.productName);
  assert.equal(manifest.build.mac.extendInfo, undefined);
  assert.equal(
    manifest.build.afterPack,
    'scripts/electron-builder-after-pack.cjs',
  );
  assert.equal(manifest.build.asar, true);
  assert.deepEqual(manifest.build.files, [
    'dist/main/**/*',
    'dist/preload/**/*',
    'dist/renderer/**/*',
    'package.json',
  ]);
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
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /webSecurity: true/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /page-title-updated/);
  assert.match(main, /did-change-theme-color/);
  assert.match(main, /nativeTheme\.themeSource/);
  assert.match(main, /setBackgroundColor/);
  assert.match(main, /titleBarStyle:.*'hidden'/);
  assert.match(main, /insertCSS\(MACOS_TITLE_BAR_CSS\)/);
  assert.match(main, /insertCSS\(BROWSER_PANEL_CSS\)/);
  assert.match(main, /\[data-sidebar-shell\] > aside/);
  assert.match(main, /padding-top: 40px/);
  assert.match(main, /\[data-testid='chat-context-header'\]/);
  assert.match(main, /\[data-web-shell-new-session-dot-field\]/);
  assert.match(main, /app-region: drag/);
  assert.match(main, /app-region: no-drag/);
  assert.doesNotMatch(main, /content: 'Qwen Code'/);
  assert.match(main, /button\[title\]\)::after/);
  assert.match(main, /github\.com\/electron\/electron\/issues\/49843/);
  assert.match(runtime, /--require-auth/);
  assert.match(runtime, /127\.0\.0\.1/);
  assert.match(runtime, /url\.hash = new URLSearchParams\(\{ token \}\)/);
  assert.doesNotMatch(runtime, /--allow-origin|qwen-desktop:\/\//);
  assert.match(main, /preload: path\.join/);
  assert.match(browserPanel, /WebContentsView/);
  assert.match(browserPanel, /contextIsolation: true/);
  assert.match(browserPanel, /nodeIntegration: false/);
  assert.match(browserPanel, /sandbox: true/);
  assert.match(browserPanel, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(browserPanel, /will-download/);
  assert.match(browserPanel, /event\.sender\.id === window\.webContents\.id/);
  assert.match(sharedBrowserPanel, /qwen-browser-panel/);
  assert.doesNotMatch(sharedBrowserPanel, /persist:/);
  assert.match(preloadPanel, /shouldOpenLinkInApp/);
  assert.match(preloadPanel, /event\.stopImmediatePropagation\(\)/);
  assert.doesNotMatch(preload, /contextBridge|exposeInMainWorld/);
  assert.doesNotMatch(computerUse, /desktopCapturer/);
  assert.match(computerUse, /Authorization: `Bearer \$\{runtime\.token\}`/);
  assert.match(
    computerUse,
    /\/session\/\$\{encodeURIComponent\(sessionId\)\}\/events/,
  );
  assert.match(computerUse, /'Last-Event-ID': '0'/);
  assert.match(computerUse, /\/computer-use\/frame/);
  assert.match(computerUse, /\/cancel/);
  assert.match(computerUse, /setContentProtection\(true\)/);
  assert.match(computerUse, /contextIsolation: true/);
  assert.match(computerUse, /nodeIntegration: false/);
  assert.match(computerUse, /sandbox: true/);
  assert.match(computerUse, /event\.sender\.id === window\.webContents\.id/);
  assert.match(preloadComputerUse, /installComputerUseControl/);
  assert.match(sharedComputerUse, /computer_use__/);
  assert.doesNotMatch(preloadComputerUse, /contextBridge|exposeInMainWorld/);
}

function testStandaloneWebShellOwnership() {
  assert.match(main, /loadURL\(runtime\.authenticatedWebUrl\(\)\)/);
  assert.match(runtimeBuilder, /build.*packages\/web-shell/s);
  assert.match(runtimeBuilder, /web-shell\/index\.html/);
  assert.match(runtimeBuilder, /copyDirectory\(distDir, libDir\)/);
  assert.doesNotMatch(main, /WebShellWithProviders|desktop\.css/);
  for (const dependency of [
    '@tailwindcss/vite',
    '@vitejs/plugin-react',
    'katex',
    'react',
    'react-dom',
    'tailwindcss',
    'vite',
  ]) {
    assert.equal(manifest.devDependencies[dependency], undefined);
  }
}

function testDesktopSurfaceScope() {
  assert.doesNotMatch(main, /new-chat-window|voice-overlay/);
  assert.doesNotMatch(entitlements, /audio-input/);
  for (const permission of [
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
  ]) {
    assert.match(afterPack, new RegExp(permission));
  }
  const sourceFiles = listFiles(path.join(packageDir, 'src'));
  assert.deepEqual(
    sourceFiles.map((file) => path.relative(packageDir, file)).sort(),
    [
      'src/main/browser-panel.ts',
      'src/main/computer-use.ts',
      'src/main/index.ts',
      'src/main/runtime.test.ts',
      'src/main/runtime.ts',
      'src/main/state.test.ts',
      'src/main/state.ts',
      'src/preload/browser-panel.ts',
      'src/preload/computer-use-surface.ts',
      'src/preload/computer-use.ts',
      'src/preload/index.ts',
      'src/renderer/computer-use-surface.css',
      'src/renderer/computer-use-surface.html',
      'src/shared/browser-panel.test.ts',
      'src/shared/browser-panel.ts',
      'src/shared/computer-use.test.ts',
      'src/shared/computer-use.ts',
    ],
  );
  const productionFiles = sourceFiles.filter(
    (file) => !file.endsWith('.test.ts'),
  );
  for (const file of productionFiles) {
    const contents = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(contents, /@tauri-apps|__TAURI__|src-tauri/);
    assert.doesNotMatch(
      contents,
      /packages\/desktop(?:\/|')/,
      `Legacy Electron source referenced by ${file}`,
    );
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
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  });
}

function read(relative) {
  return fs.readFileSync(path.join(packageDir, relative), 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
