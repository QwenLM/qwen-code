#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveLogRoot, sliceNewLog } from './resolve-log-root.js';

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
const tauriConfig = JSON.parse(
  fs.readFileSync(
    path.join(packageDir, 'src-tauri', 'tauri.conf.json'),
    'utf8',
  ),
);

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'qwen-desktop-release-test-'),
);
try {
  testBootstrapBridgeConfiguration();
  testZoomHotkeyScript();
  await testBootstrapWorkspaceVisibility();
  testLegacyApplicationIdentity();
  testElectronBridgeWorkflow();
  testDesktopReleaseSigningWorkflow();
  testDesktopReleaseHardening();
  testRuntimeNodePtyTargetMapping();
  testUpdaterMirrorConfiguration();
  testResolveLogRoot();
  testSliceNewLog();
  testUpdateManifest(path.join(root, 'manifest'));
  testElectronBridgeManifest(path.join(root, 'electron-bridge'));
  testVersionSynchronization(path.join(root, 'version'));
  testRuntimePreparation(path.join(root, 'runtime'));
  console.log('Desktop release helper checks passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

async function testBootstrapWorkspaceVisibility() {
  const bootstrapHtml = fs.readFileSync(
    path.join(packageDir, 'bootstrap', 'index.html'),
    'utf8',
  );
  assert.match(bootstrapHtml, /class="mark" src="qwen-code-logo\.svg"/);
  assert.ok(
    fs.existsSync(path.join(packageDir, 'bootstrap', 'qwen-code-logo.svg')),
    'The bootstrap splash mark must ship with the frontendDist directory.',
  );
  assert.doesNotMatch(bootstrapHtml, /class="mark">Q</);
  const reducedMotionBlock = bootstrapHtml.match(
    /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)(?:@media|<\/style>)/,
  );
  assert.ok(
    reducedMotionBlock,
    'The bootstrap splash must keep a reduced-motion media block.',
  );
  for (const centeringRule of [
    /body\[data-state='starting'\] \.brand \{[^}]*justify-content: center;[^}]*\}/,
    /body\[data-state='starting'\] \.status \{[^}]*text-align: center;[^}]*\}/,
  ]) {
    assert.match(
      reducedMotionBlock[1],
      centeringRule,
      'The reduced-motion startup view must keep the logo and status text on the same horizontal center.',
    );
  }
  const runtimeSource = fs.readFileSync(
    path.join(packageDir, 'src-tauri', 'src', 'runtime.rs'),
    'utf8',
  );
  assert.match(
    runtimeSource,
    /let mut child = spawn_runtime_group\(&mut command\)/,
    'DesktopRuntime::start must spawn the runtime through the hidden-console helper.',
  );
  const primary = await createBootstrapHarness();
  const { body, commands, element, listeners, resolveBootstrapState } = primary;

  listeners['runtime-starting']({
    payload: '/Users/example/Projects/qwen-code',
  });
  assert.equal(body.dataset.state, 'starting');
  assert.equal(element('#workspace').hidden, true);

  listeners['runtime-failed']({ payload: 'runtime failed' });
  assert.equal(body.dataset.state, 'error');
  assert.equal(element('#workspace').hidden, false);
  assert.equal(
    element('#workspace').textContent,
    '/Users/example/Projects/qwen-code',
  );
  await element('#logs').listeners.click();
  assert.equal(element('#workspace').hidden, false);

  element('#retry').listeners.click();
  assert.equal(commands.at(-1), 'restart_runtime');
  assert.equal(body.dataset.state, 'starting');
  assert.equal(element('#workspace').hidden, true);

  resolveBootstrapState({
    desktopVersion: '0.2.0',
    status: 'starting',
    workspace: '/Users/example/Documents',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('#title').textContent, 'Restarting Qwen Code');
  assert.equal(
    element('#workspace').hidden,
    true,
    'A stale bootstrap snapshot must not overwrite a newer recovery action.',
  );

  const failed = await createBootstrapHarness();
  failed.listeners['runtime-failed']({ payload: 'runtime failed' });
  failed.resolveBootstrapState({
    desktopVersion: '0.2.0',
    status: 'idle',
    workspace: '/Users/example/Documents/Qwen',
    error: 'runtime failed',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failed.element('#workspace').hidden, false);
  assert.equal(
    failed.element('#workspace').textContent,
    '/Users/example/Documents/Qwen',
  );

  const cancelled = await createBootstrapHarness();
  cancelled.listeners['runtime-starting']({
    payload: '/Users/example/Documents/Qwen',
  });
  cancelled.listeners['runtime-failed']({ payload: 'runtime failed' });
  await cancelled.element('#choose').listeners.click();
  assert.equal(cancelled.body.dataset.state, 'idle');
  assert.equal(cancelled.element('#workspace').hidden, false);
  assert.equal(
    cancelled.element('#workspace').textContent,
    '/Users/example/Documents/Qwen',
  );
}

async function createBootstrapHarness() {
  const elements = {};
  const element = (selector) => {
    elements[selector] ??= {
      addEventListener(event, listener) {
        this.listeners ??= {};
        this.listeners[event] = listener;
      },
      style: {},
    };
    return elements[selector];
  };
  const listeners = {};
  const commands = [];
  const body = { dataset: {} };
  let resolveBootstrapState;
  const tauri = {
    core: {
      invoke: async (command) => {
        commands.push(command);
        if (command === 'bootstrap_state') {
          return new Promise((resolve) => {
            resolveBootstrapState = resolve;
          });
        }
        if (command === 'open_logs') throw new Error('no file handler');
        if (command === 'choose_workspace') return null;
        if (command === 'restart_runtime') return new Promise(() => {});
        throw new Error(`Unexpected desktop command: ${command}`);
      },
    },
    event: {
      listen: async (event, listener) => {
        listeners[event] = listener;
      },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(packageDir, 'bootstrap', 'bootstrap.js'), 'utf8'),
    {
      document: { body, querySelector: element },
      window: { __TAURI__: tauri },
    },
    { timeout: 5000 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  return {
    body,
    commands,
    element,
    listeners,
    resolveBootstrapState: (state) => resolveBootstrapState(state),
  };
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
  assert.equal(
    config.bundle.windows.nsis.installerHooks,
    'windows/electron-migration.nsh',
  );
  const migrationHook = fs.readFileSync(
    path.join(packageDir, 'src-tauri', 'windows', 'electron-migration.nsh'),
    'utf8',
  );
  assert.match(migrationHook, /Software\\821b18a9-7c63-5bb4-9e20-51ba63d5ecc3/);
  assert.match(migrationHook, /!macro NSIS_HOOK_PREINSTALL/);
  assert.match(
    migrationHook,
    /StrCpy \$R1 \$R1 17\s*\n\s*\$\{If\} \$R0 != ""\s*\n\s*\$\{AndIf\} \$R1 == "Qwen Code Desktop"/,
  );
  assert.match(
    migrationHook,
    /\$\{AndIf\} \$\{FileExists\} "\$R0\\Uninstall Qwen Code Desktop\.exe"/,
  );
  assert.match(
    migrationHook,
    /ExecWait '"\$R0\\Uninstall Qwen Code Desktop\.exe" \/currentuser \/S --updated _\?=\$R0'/,
  );
  assert.match(migrationHook, /\$\{If\} \$R2 != 0\s*\n\s*Abort/);
}

function testElectronBridgeWorkflow() {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'desktop-release.yml'),
    'utf8',
  );
  assert.match(workflow, /^ {6}electron_bridge:$/m);
  assert.match(workflow, /create-electron-bridge-manifest\.mjs/);
  assert.match(workflow, /macos:latest-mac\.yml/);
  assert.match(workflow, /windows:latest\.yml/);
  assert.match(workflow, /linux:latest-linux\.yml/);
  assert.match(
    workflow,
    /windows_installers=\(release-assets\/\*-setup\.exe\)/,
  );
  assert.match(workflow, /linux_appimages=\(release-assets\/\*\.AppImage\)/);
  assert.match(workflow, /^\s+release-assets\/latest\.yml$/m);
  assert.match(workflow, /^\s+release-assets\/latest-linux\.yml$/m);
  assert.match(workflow, /^\s+"\$\{windows_installers\[0\]\}"$/m);
  assert.match(workflow, /^\s+"\$\{linux_appimages\[0\]\}"$/m);
  assert.match(
    workflow,
    /if \[ "\$ELECTRON_BRIDGE" = 'true' \]; then\s+echo "::error::Electron bridge \$RELEASE_VERSION cannot replace newer stable feed \$current\."\s+exit 1/,
  );
  for (const artifact of [
    'Qwen-Code-Desktop-arm64.zip',
    'Qwen-Code-Desktop-x64.zip',
    'Qwen-Code-Desktop-arm64.dmg',
    'Qwen-Code-Desktop-x64.dmg',
  ]) {
    assert.match(workflow, new RegExp(artifact.replaceAll('.', '\\.')));
  }
}

function testDesktopReleaseSigningWorkflow() {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'desktop-release.yml'),
    'utf8',
  );
  const primaryIncomplete =
    '$primaryIncomplete = ([bool]$env:WINDOWS_CERTIFICATE) -ne ' +
    '([bool]$env:WINDOWS_CERTIFICATE_PASSWORD)';
  const legacyIncomplete =
    '$legacyIncomplete = ([bool]$env:LEGACY_WIN_CSC_LINK) -ne ' +
    '([bool]$env:LEGACY_WIN_CSC_KEY_PASSWORD)';
  assert.ok(
    workflow.includes(primaryIncomplete),
    'Windows signing must fail closed when the primary certificate pair is incomplete',
  );
  assert.ok(
    workflow.includes(legacyIncomplete),
    'Windows signing must fail closed when the legacy certificate pair is incomplete',
  );
  assert.ok(
    workflow.includes(
      'elif [ "$RUNNER_OS" = \'Windows\' ] && [ -n "$WINDOWS_CONFIG" ]; then',
    ),
    'Windows builds must only pass a Tauri config when signing config exists',
  );
  assert.ok(
    workflow.includes(
      "$signature.Status -eq 'NotSigned' -and -not $env:WINDOWS_CONFIG",
    ),
    'Unsigned Windows installers are only allowed when no signing config exists',
  );
  // The step used to name the binaries it signed. It now discovers them,
  // because the runtime is a copy of the CLI's dist tree and gains native
  // payload without this package changing — an unsigned renderer library
  // reached the notary service that way. These assertions pin the discovery
  // and the properties the old list guaranteed by construction.
  assert.match(
    workflow,
    /if \[ "\$\(file -b --mime-type "\$file"\)" = 'application\/x-mach-binary' \]; then/,
    'the vendor signing step must discover Mach-O binaries rather than list them',
  );
  assert.match(
    workflow,
    /done < <\(find "\$runtime_dir" -type f -print0\)/,
    'Mach-O discovery must cover the whole staged runtime',
  );
  assert.ok(
    workflow.includes(
      '--entitlements src-tauri/NodeEntitlements.plist "$file"',
    ),
    'Node.js must use its minimal helper entitlements',
  );
  const entitlementFlags = workflow
    .slice(
      workflow.indexOf("name: 'Sign bundled vendor binaries (macOS)'"),
      workflow.indexOf(
        "name: 'Refresh bundled runtime checksums after signing",
      ),
    )
    .match(/--entitlements/g);
  assert.deepStrictEqual(
    entitlementFlags,
    ['--entitlements'],
    'only the Node.js branch may pass entitlements; everything else signs without them',
  );
  assert.match(
    workflow,
    /codesign --verify --strict "\$file"/,
    'the signing step must verify what it signed instead of leaving it to the notary service',
  );
  const nodeEntitlements = fs.readFileSync(
    path.join(packageDir, 'src-tauri', 'NodeEntitlements.plist'),
    'utf8',
  );
  const appEntitlements = fs.readFileSync(
    path.join(packageDir, 'src-tauri', 'Entitlements.plist'),
    'utf8',
  );
  assert.match(
    appEntitlements,
    /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/,
    'the app bundle must keep microphone access for voice dictation',
  );
  const infoPlist = fs.readFileSync(
    path.join(packageDir, 'src-tauri', 'Info.plist'),
    'utf8',
  );
  assert.match(
    infoPlist,
    /NSMicrophoneUsageDescription<\/key>\s*<string>.+<\/string>/,
    'the app bundle must declare a non-empty microphone usage description',
  );
  assert.match(
    nodeEntitlements,
    /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/,
    'the bundled Node.js runtime must keep its JIT entitlement',
  );
  assert.doesNotMatch(
    nodeEntitlements,
    /com\.apple\.security\.device\.audio-input/,
    'Node.js must not receive microphone access',
  );
  assert.match(
    workflow,
    /No Mach-O binary found under \$runtime_dir/,
    'a runtime with no native binary must fail rather than silently sign nothing',
  );
  assert.match(
    workflow,
    /Node\.js runtime binary not found at \$node_bin/,
    'missing Node.js runtime binary must be visible in release logs',
  );
  assert.match(
    workflow,
    /Print :com\.apple\.security\.device\.audio-input/,
    'the macOS signature check must keep verifying the audio-input entitlement',
  );
  assert.match(
    workflow,
    /Print :NSMicrophoneUsageDescription/,
    'the packaged smoke must keep verifying the microphone usage description',
  );
  assert.ok(
    workflow.indexOf("name: 'Prepare bundled runtime'") <
      workflow.indexOf("name: 'Sign bundled vendor binaries (macOS)'"),
    'vendor binaries must be signed after the runtime is prepared',
  );
  assert.ok(
    workflow.indexOf("name: 'Sign bundled vendor binaries (macOS)'") <
      workflow.indexOf("name: 'Build desktop installers'"),
    'vendor binaries must be signed before Tauri builds installers',
  );
}

function testDesktopReleaseHardening() {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'desktop-release.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /IS_PRERELEASE" = 'true' \] && \[\[ ! "\$version" =~ \^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+-/,
    'prerelease builds must not reuse a stable Desktop version',
  );
  assert.match(
    workflow,
    /\*-setup\.exe\|\*-setup\.exe\.sig/,
    'Windows release collection must allow only installer executables',
  );
  assert.doesNotMatch(
    workflow.slice(
      workflow.indexOf('elif [ "$RUNNER_OS" = \'Windows\' ]'),
      workflow.indexOf('elif [ "$RUNNER_OS" = \'Linux\' ]'),
    ),
    /\*\.exe\)/,
    'Windows release collection must not include embedded executables',
  );
  assert.match(
    workflow,
    /\*\.AppImage\|\*\.AppImage\.sig\|\*\.deb\|\*\.deb\.sig/,
    'Linux release collection must allow only installers and updater signatures',
  );

  const prepareRuntime = fs.readFileSync(
    path.join(packageDir, 'scripts', 'prepare-runtime.js'),
    'utf8',
  );
  assert.match(
    prepareRuntime,
    /QWEN_DESKTOP_NODE_CACHE_DIR/,
    'runtime preparation must cache verified Node.js archives',
  );
  assert.match(
    workflow,
    /desktop-node-v2-\$\{\{ matrix\.rust_target \}\}-\$\{\{ env\.NODE_VERSION \}\}-\$\{\{ inputs\.dry_run \}\}/,
    'release builds must persist the bundled Node.js archive cache',
  );
  assert.match(workflow, /actions\/cache\/restore@/);
  assert.match(workflow, /actions\/cache\/save@/);
  assert.equal(
    (
      workflow.match(
        /path: '\$\{\{ steps\.node-cache-path\.outputs\.path \}\}'/g,
      ) ?? []
    ).length,
    2,
    'cache restore and save must share the configured cache path',
  );
  assert.ok(
    prepareRuntime.indexOf('replaceRuntime();') >
      prepareRuntime.indexOf('writeChecksums();'),
    'runtime replacement must happen only after assembly and checksums finish',
  );
}

function testRuntimeNodePtyTargetMapping() {
  const prepareRuntime = fs.readFileSync(
    path.join(packageDir, 'scripts', 'prepare-runtime.js'),
    'utf8',
  );
  const literal =
    /const NODE_PTY_PREBUILD_PACKAGE = new Map\(\[([\s\S]*?)\]\);/.exec(
      prepareRuntime,
    );
  assert.ok(
    literal,
    'runtime preparation must map desktop targets to node-pty prebuild packages',
  );
  const mapping = vm.runInNewContext(`new Map([${literal[1]}])`);
  const allowList = /!\[\s*([\s\S]*?)\]\.includes\(resolved\)/.exec(
    prepareRuntime,
  );
  assert.ok(allowList, 'desktopTarget() must keep validating its targets');
  const supported = vm.runInNewContext(`[${allowList[1]}]`);
  assert.deepEqual(
    [...mapping.keys()].sort(),
    [...supported].sort(),
    'every target desktopTarget() accepts needs a node-pty prebuild package',
  );
  for (const target of supported) {
    // The wrapper requires `@lydell/node-pty-${process.platform}-${process.arch}`
    // at runtime, and the standalone packager keys Windows as 'win-x64': reusing
    // that map here would stage '@lydell/node-pty-undefined' for 'win32-x64'.
    assert.equal(
      mapping.get(target),
      `@lydell/node-pty-${target}`,
      `${target} must stage the prebuild package its own wrapper requires`,
    );
  }

  // Cross-built prebuilds must stay exact so staging fetches the same version
  // that the frozen root install verified (#11872).
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  assert.match(
    rootPackage.optionalDependencies?.['@lydell/node-pty-darwin-x64'],
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    'the darwin-x64 prebuild must stay pinned so a cross-building leg can fetch its locked version',
  );
}

function testRuntimePreparation(directory) {
  const testPackageDir = path.join(directory, 'packages', 'desktop-shell');
  const testScript = path.join(testPackageDir, 'scripts', 'prepare-runtime.js');
  const sourceRoot = path.join(directory, 'source');
  const runtimeDir = path.join(testPackageDir, 'runtime');
  const cacheRoot = path.join(directory, 'cache');
  const nodeVersion = process.versions.node;
  // darwin-x64 on purpose: this test runs on a linux-x64 CI host, so the
  // target's prebuild can never come from a host node_modules — the same shape
  // as the release matrix's x86_64-apple-darwin leg, which cross-builds on an
  // arm64 macos-15 runner (#11872).
  const archiveName = `node-v${nodeVersion}-darwin-x64.tar.gz`;
  const cacheDir = path.join(cacheRoot, `v${nodeVersion}`);
  const cachedArchivePath = path.join(cacheDir, archiveName);
  const archivePath = path.join(directory, archiveName);
  const checksumsPath = path.join(directory, 'SHASUMS256.txt');
  const fetchLog = path.join(directory, 'fetch.log');
  const fetchMock = path.join(directory, 'mock-fetch.mjs');
  const npmLog = path.join(directory, 'npm.log');
  const npmStub = path.join(directory, 'mock-npm.mjs');
  const extractedRoot = path.join(directory, `node-v${nodeVersion}-darwin-x64`);

  fs.mkdirSync(path.join(sourceRoot, 'dist', 'web-shell', 'assets'), {
    recursive: true,
  });
  // The exact pins staging resolves its package specs from.
  const nodePtyPins = {
    '@lydell/node-pty': '0.0.0-test',
    '@lydell/node-pty-darwin-x64': '0.0.0-test',
  };
  fs.writeFileSync(
    path.join(sourceRoot, 'package.json'),
    JSON.stringify({
      version: '0.0.0-test',
      optionalDependencies: nodePtyPins,
    }),
  );
  fs.mkdirSync(path.dirname(testScript), { recursive: true });
  fs.copyFileSync(
    path.join(packageDir, 'scripts', 'prepare-runtime.js'),
    testScript,
  );
  fs.writeFileSync(
    path.join(directory, '.nvmrc'),
    `${process.versions.node.split('.')[0]}\n`,
  );
  fs.writeFileSync(
    path.join(testPackageDir, 'package.json'),
    JSON.stringify({ version: '0.0.0-test' }),
  );
  fs.writeFileSync(path.join(testPackageDir, 'NOTICE'), 'test notice');
  fs.writeFileSync(path.join(sourceRoot, 'LICENSE'), 'test license');
  for (const file of [
    'cli.js',
    'cli-entry.js',
    path.join('web-shell', 'index.html'),
    path.join('web-shell', 'assets', 'app.js'),
  ]) {
    fs.writeFileSync(path.join(sourceRoot, 'dist', file), 'test');
  }
  // Staging installs the target's pinned packages into a throwaway prefix
  // instead of reading a host node_modules that cannot hold a cross-built
  // target's addon (#11872), so npm is stubbed: it records the argv it is
  // given and materializes those packages under --prefix. Nothing here creates
  // sourceRoot/node_modules, and the assertions below check it stays absent.
  fs.writeFileSync(
    npmStub,
    `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.QWEN_TEST_NPM_LOG, JSON.stringify(args) + '\\n');
const modules = path.join(args[args.indexOf('--prefix') + 1], 'node_modules');
for (const spec of args.filter((arg) => arg.startsWith('@lydell/'))) {
  const at = spec.lastIndexOf('@');
  const name = spec.slice(0, at);
  const dir = path.join(modules, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\\n');
  const prebuild = name.slice('@lydell/node-pty-'.length);
  if (!prebuild) continue;
  const addonDir = path.join(dir, 'prebuilds', prebuild);
  fs.mkdirSync(addonDir, { recursive: true });
  fs.writeFileSync(path.join(addonDir, 'pty.node'), 'test addon');
  fs.writeFileSync(path.join(addonDir, 'pty.pdb'), 'test symbols');
}
`,
  );
  fs.mkdirSync(path.join(extractedRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(extractedRoot, 'bin', 'node'), 'node');
  fs.writeFileSync(path.join(extractedRoot, 'LICENSE'), 'node license');
  execFileSync('tar', [
    '-czf',
    archivePath,
    '-C',
    directory,
    path.basename(extractedRoot),
  ]);
  const archiveHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(archivePath))
    .digest('hex');
  fs.writeFileSync(checksumsPath, `${archiveHash}  ${archiveName}\n`);
  fs.writeFileSync(
    fetchMock,
    `import fs from 'node:fs';
globalThis.fetch = async (url) => {
  const value = String(url);
  const source = value.endsWith('/SHASUMS256.txt')
    ? process.env.QWEN_TEST_NODE_CHECKSUMS
    : process.env.QWEN_TEST_NODE_ARCHIVE;
  fs.appendFileSync(process.env.QWEN_TEST_FETCH_LOG, value + '\\n');
  return new Response(fs.readFileSync(source), { status: 200 });
};
`,
  );

  const env = {
    ...process.env,
    QWEN_CODE_COMMIT: 'test-commit',
    QWEN_CODE_ROOT: sourceRoot,
    QWEN_DESKTOP_NODE_CACHE_DIR: cacheRoot,
    QWEN_DESKTOP_SKIP_BUILD: '1',
    QWEN_DESKTOP_TARGET: 'x86_64-apple-darwin',
    QWEN_TEST_FETCH_LOG: fetchLog,
    QWEN_TEST_NPM_LOG: npmLog,
    QWEN_TEST_NODE_ARCHIVE: archivePath,
    QWEN_TEST_NODE_CHECKSUMS: checksumsPath,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(fetchMock).href}`,
    ]
      .filter(Boolean)
      .join(' '),
    npm_execpath: npmStub,
  };
  const first = spawnSync(process.execPath, [testScript], {
    encoding: 'utf8',
    env,
  });
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stdout, /Using cached Node\.js runtime/);
  assert.ok(fs.existsSync(cachedArchivePath));
  assert.ok(
    fs.existsSync(path.join(runtimeDir, 'qwen-code', 'checksums.json')),
  );

  // The Web Terminal resolves its PTY backend from lib/, so the runtime has to
  // carry the wrapper and this target's prebuild under lib/node_modules
  // (#11872).
  const stagedLydellDir = path.join(
    runtimeDir,
    'qwen-code',
    'lib',
    'node_modules',
    '@lydell',
  );
  assert.equal(
    fs.readFileSync(path.join(stagedLydellDir, 'node-pty', 'index.js'), 'utf8'),
    'module.exports = {};\n',
  );
  const stagedAddon = path.join(
    stagedLydellDir,
    'node-pty-darwin-x64',
    'prebuilds',
    'darwin-x64',
    'pty.node',
  );
  assert.ok(fs.existsSync(stagedAddon));
  assert.equal(
    fs.existsSync(path.join(path.dirname(stagedAddon), 'pty.pdb')),
    false,
    'debug symbols must not be bundled into the runtime',
  );
  const stagedChecksums = JSON.parse(
    fs.readFileSync(
      path.join(runtimeDir, 'qwen-code', 'checksums.json'),
      'utf8',
    ),
  );
  assert.equal(
    stagedChecksums[
      'lib/node_modules/@lydell/node-pty-darwin-x64/prebuilds/darwin-x64/pty.node'
    ],
    crypto.createHash('sha256').update('test addon').digest('hex'),
    'the staged prebuild must be checksummed so signing refresh and smoke verification cover it',
  );

  // ...and it has to get there by fetching the TARGET's pinned package, at the
  // version package.json pins, not out of a host node_modules that cannot
  // contain a darwin-x64 addon.
  const installs = fs
    .readFileSync(npmLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(installs.length, 1);
  assert.deepEqual(
    installs[0].filter((arg) => arg.startsWith('@lydell/')),
    ['@lydell/node-pty@0.0.0-test', '@lydell/node-pty-darwin-x64@0.0.0-test'],
  );
  assert.ok(
    installs[0].includes('--force'),
    'npm must be allowed to install a prebuild whose os/cpu do not match this host',
  );
  assert.equal(
    fs.existsSync(path.join(sourceRoot, 'node_modules')),
    false,
    'staging must not read or need a host node_modules',
  );

  const second = spawnSync(process.execPath, [testScript], {
    encoding: 'utf8',
    env,
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Using cached Node\.js runtime/);

  fs.appendFileSync(cachedArchivePath, 'tampered');
  const poisonedHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(cachedArchivePath))
    .digest('hex');
  fs.writeFileSync(
    path.join(cacheDir, 'SHASUMS256.txt'),
    `${poisonedHash}  ${archiveName}\n`,
  );
  const recoveredCache = spawnSync(process.execPath, [testScript], {
    encoding: 'utf8',
    env,
  });
  assert.equal(recoveredCache.status, 0, recoveredCache.stderr);
  assert.doesNotMatch(recoveredCache.stdout, /Using cached Node\.js runtime/);
  const fetches = fs.readFileSync(fetchLog, 'utf8').trim().split('\n');
  assert.equal(fetches.filter((url) => url.endsWith(archiveName)).length, 2);
  assert.equal(
    fetches.filter((url) => url.endsWith('SHASUMS256.txt')).length,
    3,
  );
  assert.equal(fs.existsSync(path.join(cacheDir, 'SHASUMS256.txt')), false);

  // A target the repo pins nothing for must still produce a runtime: the root
  // package.json does not pin @lydell/node-pty-linux-arm64 (upstream publishes
  // it), and failing the build there would trade a missing Web Terminal for no
  // app at all (#11872). Dropping the pins reproduces that for this fixture's
  // target.
  fs.writeFileSync(
    path.join(sourceRoot, 'package.json'),
    JSON.stringify({ version: '0.0.0-test' }),
  );
  const degraded = spawnSync(process.execPath, [testScript], {
    encoding: 'utf8',
    env,
  });
  assert.equal(degraded.status, 0, degraded.stderr);
  assert.match(degraded.stderr, /@lydell\/node-pty-darwin-x64 is not pinned/);
  assert.equal(
    fs.existsSync(path.join(runtimeDir, 'qwen-code', 'lib', 'node_modules')),
    false,
  );

  const marker = path.join(runtimeDir, 'qwen-code', 'complete-marker');
  fs.writeFileSync(marker, 'preserve me');
  const strandedRoot = path.join(runtimeDir, '.prepare-stranded');
  fs.mkdirSync(strandedRoot);
  fs.renameSync(
    path.join(runtimeDir, 'qwen-code'),
    path.join(strandedRoot, 'previous'),
  );
  fs.rmSync(path.join(sourceRoot, 'LICENSE'));
  const failed = spawnSync(process.execPath, [testScript], {
    encoding: 'utf8',
    env,
  });
  assert.notEqual(failed.status, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve me');
  assert.deepEqual(
    fs.readdirSync(runtimeDir).filter((entry) => entry.startsWith('.prepare-')),
    [],
  );
}

function testUpdaterMirrorConfiguration() {
  assert.deepEqual(tauriConfig.plugins?.updater?.endpoints, [
    'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/desktop/latest/desktop-latest.json',
    'https://github.com/QwenLM/qwen-code/releases/download/desktop-latest/desktop-latest.json',
  ]);
  const main = fs.readFileSync(
    path.join(packageDir, 'src-tauri', 'src', 'main.rs'),
    'utf8',
  );
  assert.match(
    main,
    /const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs\(3\);/,
  );
  assert.match(
    main,
    /app\.updater_builder\(\)\s*\.timeout\(UPDATE_CHECK_TIMEOUT\)/,
  );
  assert.match(main, /"QWEN_DESKTOP_DISABLE_UPDATES"/);
  // The gate must run before the task is spawned: moving it inside the task,
  // after check_for_update, would still phone home to the update feed.
  assert.match(
    main,
    /fn check_updates_silently\(app: AppHandle\) \{\s*if cfg!\(debug_assertions\) \|\| updates_disabled\(\) \{\s*return;\s*\}\s*tauri::async_runtime::spawn\(/,
  );
  assert.equal((main.match(/check_for_update\(&app\)/g) ?? []).length, 2);
}

function testBootstrapBridgeConfiguration() {
  assert.equal(
    tauriConfig.app?.withGlobalTauri,
    true,
    'The Bootstrap UI requires window.__TAURI__ for desktop commands.',
  );
  assert.deepEqual(
    tauriConfig.app?.security?.capabilities,
    ['bootstrap', 'web-shell-external-url'],
    'The local bootstrap and remote Web Shell capabilities must be enabled.',
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
    'core:window:allow-start-dragging',
    'allow-bootstrap-state',
    'allow-change-zoom',
    'allow-choose-workspace',
    'allow-install-update',
    'allow-open-logs',
    'allow-restart-runtime',
  ]);

  // Declaring an app ACL manifest makes every app command opt-in, so one that
  // is registered but missing from build.rs is denied at runtime with no build
  // error to point at it.
  const build = fs.readFileSync(
    path.join(packageDir, 'src-tauri', 'build.rs'),
    'utf8',
  );
  const main = fs.readFileSync(
    path.join(packageDir, 'src-tauri', 'src', 'main.rs'),
    'utf8',
  );
  // One class shared by both parsers, and wide enough for any Rust identifier.
  // If the two drift, or the class is narrower than the names it parses, a
  // command is dropped from `listed` and `registered` identically: deepEqual
  // still passes and the grant loop below never demands its capability, so a
  // command that is registered but ungranted ships green and is only denied at
  // runtime. Both parses stay bounded to the declaration slices, so the wide
  // class cannot pick up unrelated identifiers elsewhere in the file.
  const COMMAND_NAME = '[A-Za-z0-9_]+';
  const commandsStart = build.indexOf('const COMMANDS');
  const listed = [
    ...build
      .slice(commandsStart, build.indexOf('];', commandsStart))
      .matchAll(new RegExp(`"(${COMMAND_NAME})"`, 'g')),
  ].map(([, command]) => command);
  const handlerStart = main.indexOf('generate_handler![');
  const registered = [
    ...main
      .slice(handlerStart, main.indexOf('])', handlerStart))
      .matchAll(new RegExp(`\\b(${COMMAND_NAME}),`, 'g')),
  ].map(([, command]) => command);
  assert.deepEqual(
    [...listed].sort(),
    [...registered].sort(),
    'build.rs must list exactly the commands main.rs registers.',
  );
  for (const command of listed) {
    assert.ok(
      capability.permissions.includes(`allow-${command.replaceAll('_', '-')}`),
      `The bootstrap capability must grant ${command}.`,
    );
  }
  assert.ok(
    registered.includes('change_zoom'),
    'The zoom shortcut script invokes change_zoom; renaming the command means renaming it there too.',
  );

  const webShellCapability = JSON.parse(
    fs.readFileSync(
      path.join(
        packageDir,
        'src-tauri',
        'capabilities',
        'web-shell-external-url.json',
      ),
      'utf8',
    ),
  );
  assert.equal(webShellCapability.local, false);
  assert.deepEqual(webShellCapability.remote, {
    urls: ['http://127.0.0.1:*'],
  });
  assert.deepEqual(webShellCapability.windows, ['main']);
  // The daemon-served page reaches exactly two things: the external-URL opener
  // and the zoom shortcut. The workspace, updater, and log commands stay
  // bootstrap-only.
  assert.deepEqual(webShellCapability.permissions, [
    'core:window:allow-start-dragging',
    {
      identifier: 'opener:allow-open-url',
      allow: [{ url: 'http://*' }, { url: 'https://*' }, { url: 'mailto:*' }],
    },
    'allow-change-zoom',
  ]);

  assert.match(main, /title_bar_style\(tauri::TitleBarStyle::Overlay\)/);
  assert.match(main, /hidden_title\(true\)/);
  assert.match(main, /initialization_script\(MACOS_TITLEBAR_INIT_SCRIPT\)/);
}

function testZoomHotkeyScript() {
  const main = fs.readFileSync(
    path.join(packageDir, 'src-tauri', 'src', 'main.rs'),
    'utf8',
  );
  const script = /const ZOOM_HOTKEY_SCRIPT: &str = r#"([\s\S]*?)"#;/.exec(
    main,
  )?.[1];
  assert.ok(script, 'main.rs must keep the zoom shortcut script.');
  // Simulating the constant proves nothing if the webview never receives it, so
  // pin the injection the same way the titlebar script is pinned above.
  assert.match(main, /initialization_script\(ZOOM_HOTKEY_SCRIPT\)/);
  // Pinning only the injection would leave the persisted factor free to go
  // unapplied: both application sites discard their Result via `let _ =`, so
  // dropping either - or re-applying on Started, before the document exists -
  // ships green with no runtime error, and the README's "the chosen factor is
  // restored on the next launch" quietly stops being true.
  assert.match(main, /\.on_page_load\(/);
  assert.match(
    main,
    /PageLoadEvent::Finished/,
    'Zoom must be re-applied after the document finishes loading.',
  );
  assert.match(
    main,
    /webview\.set_zoom\(state\.settings\.zoom\(\)\.unwrap_or\(DEFAULT_ZOOM\)\)/,
    'on_page_load must apply the persisted factor to the webview.',
  );
  assert.match(
    main,
    /let _ = window\.set_zoom\(zoom\);/,
    'Startup must apply the persisted factor to the first document.',
  );

  const listeners = [];
  const invoked = [];
  vm.runInNewContext(
    script,
    {
      window: {
        __TAURI__: {
          core: {
            invoke: async (command, args) => {
              invoked.push({ command, args });
            },
          },
        },
        addEventListener: (event, listener, options) => {
          listeners.push({ event, listener, options });
        },
      },
    },
    { timeout: 5000 },
  );

  let stopped = false;
  const dispatch = (event, properties) => {
    const registered = listeners.find((entry) => entry.event === event);
    assert.ok(registered, `The script must listen for ${event}.`);
    let prevented = false;
    stopped = false;
    registered.listener({
      preventDefault: () => {
        prevented = true;
      },
      // Spied rather than left unstubbed: without it a stopPropagation() on any
      // path throws a TypeError before send() and the failure names the stub
      // instead of the gesture the script claims.
      stopPropagation: () => {
        stopped = true;
      },
      ...properties,
    });
    return prevented;
  };

  assert.equal(
    listeners.find((entry) => entry.event === 'keydown').options,
    true,
    'The keydown listener must capture, so an editor that stops propagation cannot swallow the shortcut.',
  );
  // Read field by field: the options object comes from the vm realm, so it has
  // a different Object.prototype than a literal here.
  const wheel = listeners.find((entry) => entry.event === 'wheel').options;
  assert.equal(wheel.capture, true);
  assert.equal(
    wheel.passive,
    false,
    'The wheel listener must stay non-passive to suppress the pinch gesture.',
  );

  for (const [properties, action] of [
    [{ metaKey: true, key: '=' }, 'in'],
    [{ ctrlKey: true, key: '+' }, 'in'],
    [{ ctrlKey: true, key: '-' }, 'out'],
    [{ metaKey: true, key: '0' }, 'reset'],
  ]) {
    assert.equal(dispatch('keydown', properties), true);
    assert.equal(invoked.at(-1).command, 'change_zoom');
    assert.equal(invoked.at(-1).args.action, action);
  }

  // Shortcuts the shell does not own must reach the page untouched.
  const owned = invoked.length;
  for (const properties of [
    { ctrlKey: true, key: 'a' },
    { key: '=' },
    { altKey: true, metaKey: true, key: '=' },
  ]) {
    assert.equal(dispatch('keydown', properties), false);
  }
  assert.equal(invoked.length, owned);

  // A trackpad pinch reaches the page as a ctrlKey wheel event, in both
  // directions: one discrete notch stays exactly one zoom step.
  assert.equal(dispatch('wheel', { ctrlKey: true, deltaY: -120 }), true);
  assert.equal(invoked.at(-1).command, 'change_zoom');
  assert.equal(invoked.at(-1).args.action, 'in');
  // Cancelling the default is not enough: the notch keeps propagating, and the
  // page's own wheel consumers then read a scroll that provably will not
  // happen. TranscriptViewport drops the selection and scroll anchor and pages
  // history in; MessageList marks user scroll intent.
  assert.equal(
    stopped,
    true,
    'A committed zoom step must stop propagating to the page wheel consumers.',
  );
  assert.equal(dispatch('wheel', { ctrlKey: true, deltaY: 120 }), true);
  assert.equal(invoked.at(-1).args.action, 'out');
  assert.equal(stopped, true, 'Both pinch directions must stop propagating.');
  // ctrl+shift+wheel is the horizontal-scroll gesture, not a pinch.
  assert.equal(
    dispatch('wheel', { ctrlKey: true, shiftKey: true, deltaY: -120 }),
    false,
    'ctrl+shift+wheel must reach the page instead of zooming.',
  );
  assert.equal(
    stopped,
    false,
    'ctrl+shift+wheel must keep propagating: the shell does not own it.',
  );
  assert.equal(dispatch('wheel', { deltaY: -120 }), false);
  assert.equal(
    stopped,
    false,
    'Plain scrolling must keep propagating, or the desktop shell loses transcript scroll, edge history loading and wheel intent.',
  );
  assert.equal(invoked.length, owned + 2);

  // A real pinch arrives as a burst of small deltas. Steps must follow the
  // accumulated movement, not the event count, or a gentle pinch sweeps the
  // factor to the clamp and the flusher persists it.
  const burst = invoked.length;
  for (let event = 0; event < 30; event += 1) {
    dispatch('wheel', { ctrlKey: true, deltaY: -2 });
  }
  // Exact, not merely bounded from above. An upper bound alone passes both when
  // the threshold is lowered - a third of a mouse notch then buys a full step,
  // which is the clamp-sweeping outcome this comment says the accumulator
  // prevents - and when it is raised past the burst total, where the pinch path
  // is simply dead and emits nothing.
  assert.equal(
    invoked.length - burst,
    1,
    `A 30-event pinch burst (-60) must emit exactly one zoom step, got ${
      invoked.length - burst
    }.`,
  );
  assert.equal(invoked.at(-1).args.action, 'in');

  // No vertical movement means nothing to zoom: the event, and the horizontal
  // scroll it belongs to, must pass through unowned.
  const afterBurst = invoked.length;
  assert.equal(dispatch('wheel', { ctrlKey: true, deltaY: 0 }), false);
  assert.equal(
    dispatch('wheel', { ctrlKey: true, deltaX: 50, deltaY: 0 }),
    false,
  );
  assert.equal(
    stopped,
    false,
    'A horizontal swipe carries no zoom: it and its scroll must pass through.',
  );
  assert.equal(invoked.length, afterBurst);

  // The other side of the threshold, which is what pins it from below: a burst
  // that stops one event short must buy nothing at all. It is already owned
  // though - preventDefault has cancelled its scroll on every event - so it
  // must stop propagating too, or the page's wheel consumers read a scroll that
  // cannot happen once per sub-threshold event while no zoom is emitted.
  const subThreshold = invoked.length;
  for (let event = 0; event < 29; event += 1) {
    assert.equal(
      dispatch('wheel', { ctrlKey: true, deltaY: -2 }),
      true,
      'An owned sub-threshold pinch event must still cancel the native scroll.',
    );
  }
  assert.equal(
    invoked.length,
    subThreshold,
    `A sub-threshold burst (-58) must not zoom, got ${
      invoked.length - subThreshold
    }.`,
  );
  assert.equal(
    stopped,
    true,
    'An owned sub-threshold pinch must stop propagating to the page wheel consumers.',
  );
}

function testResolveLogRoot() {
  const paths = {
    isolatedHome: path.join('/', 'home'),
    isolatedState: path.join('/', 'state'),
    appId: tauriConfig.identifier,
  };

  assert.equal(
    resolveLogRoot('darwin', {}, paths),
    path.join('/', 'home', 'Library', 'Logs', tauriConfig.identifier),
  );
  assert.equal(
    resolveLogRoot('linux', {}, paths),
    path.join('/', 'state', tauriConfig.identifier, 'logs'),
  );
  assert.equal(
    resolveLogRoot('win32', { LOCALAPPDATA: path.join('C:', 'x') }, paths),
    path.join('C:', 'x', tauriConfig.identifier, 'logs'),
  );
  assert.throws(
    () => resolveLogRoot('win32', {}, paths),
    /LOCALAPPDATA is required/,
  );

  // Structural invariants that cannot be tested through the exported helper:
  // the smoke must not override LOCALAPPDATA in the child env, and the
  // pre-spawn snapshot must precede the spawn call.
  const smoke = fs.readFileSync(
    path.join(packageDir, 'scripts', 'smoke-packaged.js'),
    'utf8',
  );
  assert.doesNotMatch(smoke, /^\s*LOCALAPPDATA:/m);
  assert.match(
    smoke,
    /QWEN_DESKTOP_DISABLE_SETTINGS_PERSISTENCE: '1'/,
    'Windows packaged smoke must not persist its temporary desktop state',
  );
  assert.match(
    smoke,
    /const logRoot = resolveLogRoot\(process\.platform, process\.env, \{/,
    'smoke must resolve log root via resolveLogRoot',
  );
  assert.match(
    smoke,
    /const appId = JSON\.parse\(\s*fs\.readFileSync\(\s*path\.join\(packageDir, 'src-tauri', 'tauri\.conf\.json'\),\s*'utf8',\s*\),\s*\)\.identifier;/,
    'smoke appId must be derived from the tauri.conf.json identifier',
  );
  const previousLogIndex = smoke.indexOf(
    'let previousLog = fs.readFileSync(logPath',
  );
  const spawnIndex = smoke.indexOf('const child = spawn(executable');
  assert.notEqual(previousLogIndex, -1, 'smoke must capture previousLog');
  assert.notEqual(spawnIndex, -1, 'smoke must spawn the child');
  assert.ok(
    previousLogIndex < spawnIndex,
    'previousLog must be captured before the child is spawned',
  );
  const readNewLogCalls = smoke.match(/const contents = readNewLog\(\)/g);
  assert.ok(
    readNewLogCalls && readNewLogCalls.length === 1,
    'the polling loop must be the only incremental readNewLog() call site',
  );
  assert.match(
    smoke,
    /console\.warn\([\s\S]*?previousLog = contents;/,
    'a rewritten log must warn and rebase the slice baseline',
  );
  assert.match(
    smoke,
    /const contents = fs\.readFileSync\(logPath, \{\s*encoding: 'utf8',\s*flag: 'a\+',\s*\}\);\s*throw smokeError\('Timed out waiting for packaged desktop runtime\.', contents\);/,
    'the timeout error must embed the full log, not the incremental delta',
  );
  assert.match(
    smoke,
    /sliceNewLog\(/,
    'smoke must slice the log via the tested sliceNewLog helper',
  );
  assert.match(
    smoke,
    /function smokeError[\s\S]*?Log: \$\{logPath\}/,
    'smokeError must embed the log path like the timeout error does',
  );
}

function testSliceNewLog() {
  assert.deepEqual(sliceNewLog('hello', ''), {
    text: 'hello',
    baseline: '',
  });
  assert.deepEqual(sliceNewLog('hello world', 'hello'), {
    text: ' world',
    baseline: 'hello',
  });
  assert.deepEqual(sliceNewLog('new', 'old'), {
    text: 'new',
    baseline: '',
  });
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
    '--base-url',
    'https://mirror.example/desktop/v0.1.0/',
    '--output',
    output,
  ]);
  const mirrorManifest = JSON.parse(fs.readFileSync(output, 'utf8'));
  for (const [platform, artifact] of [
    ['darwin-aarch64', artifacts[0]],
    ['darwin-x86_64', artifacts[1]],
    ['windows-x86_64', artifacts[2]],
    ['linux-x86_64', artifacts[3]],
  ]) {
    assert.equal(
      mirrorManifest.platforms[platform].url,
      `https://mirror.example/desktop/v0.1.0/${encodeURIComponent(artifact)}`,
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
  artifacts.push(
    'Qwen-Code-Desktop_0.1.0_x64-setup.exe',
    'Qwen-Code-Desktop_0.1.0_amd64.AppImage',
  );
  for (const artifact of artifacts.slice(4)) {
    fs.writeFileSync(path.join(assets, artifact), `contents:${artifact}`);
  }
  const macOutput = path.join(directory, 'latest-mac.yml');
  for (const [platform, filename, selected] of [
    ['macos', 'latest-mac.yml', artifacts.slice(0, 4)],
    ['windows', 'latest.yml', artifacts.slice(4, 5)],
    ['linux', 'latest-linux.yml', artifacts.slice(5, 6)],
  ]) {
    const output = path.join(directory, filename);
    execFileSync(process.execPath, [
      electronBridgeScript,
      '--assets',
      assets,
      '--platform',
      platform,
      '--version',
      '0.1.0',
      '--output',
      output,
    ]);
    const manifest = fs.readFileSync(output, 'utf8');
    assert.match(manifest, /^version: 0\.1\.0$/m);
    assert.match(
      manifest,
      /^releaseDate: '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z'$/m,
    );
    for (const artifact of selected) {
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
      if (artifact === selected[0]) {
        assert.match(
          manifest,
          new RegExp(`^path: ${artifact.replaceAll('.', '\\.')}$`, 'm'),
        );
        assert.match(
          manifest,
          new RegExp(`^sha512: ${sha512.replaceAll('+', '\\+')}$`, 'm'),
        );
      }
    }
    assert.equal(
      (manifest.match(/^ {2}- url:/gm) ?? []).length,
      selected.length,
    );
  }
  const duplicateWindowsArtifact = path.join(
    assets,
    'Qwen-Code-Desktop_0.1.0_arm64-setup.exe',
  );
  fs.writeFileSync(duplicateWindowsArtifact, 'duplicate');
  const ambiguousWindows = spawnSync(
    process.execPath,
    [
      electronBridgeScript,
      '--assets',
      assets,
      '--platform',
      'windows',
      '--version',
      '0.1.0',
      '--output',
      path.join(directory, 'ambiguous-windows.yml'),
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(ambiguousWindows.status, 0);
  assert.match(ambiguousWindows.stderr, /found 2/);
  fs.rmSync(duplicateWindowsArtifact);

  fs.rmSync(path.join(assets, artifacts[1]));
  const failure = spawnSync(
    process.execPath,
    [
      electronBridgeScript,
      '--assets',
      assets,
      '--platform',
      'macos',
      '--version',
      '0.1.0',
      '--output',
      macOutput,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /Expected one Electron bridge artifact/);

  const invalidVersion = spawnSync(
    process.execPath,
    [
      electronBridgeScript,
      '--assets',
      assets,
      '--platform',
      'macos',
      '--version',
      '0.1',
      '--output',
      macOutput,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(invalidVersion.status, 0);
  assert.match(invalidVersion.stderr, /Invalid --version/);

  const missingOutput = spawnSync(
    process.execPath,
    [
      electronBridgeScript,
      '--assets',
      assets,
      '--platform',
      'macos',
      '--version',
      '0.1.0',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(missingOutput.status, 0);
  assert.match(missingOutput.stderr, /Missing --output/);
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
