/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(packageRoot, '../../dist/desktop');

const resourcesDir = findResourcesDir(outputRoot);
const appBundlePath = findAppBundlePath(outputRoot);
const requiredResources = [
  join(resourcesDir, 'qwen-cli', 'cli.js'),
  join(resourcesDir, 'app.asar'),
];

for (const resourcePath of requiredResources) {
  if (!existsSync(resourcePath)) {
    throw new Error(`Missing packaged desktop resource: ${resourcePath}`);
  }
}

console.log(`Packaged app bundle: ${appBundlePath}`);
console.log(`Packaged resources: ${resourcesDir}`);

if (process.argv.includes('--launch')) {
  await smokeLaunch(appBundlePath);
}

console.log('Desktop package smoke check passed.');

function findResourcesDir(root) {
  if (!existsSync(root)) {
    throw new Error(`Desktop package output is missing: ${root}`);
  }

  if (process.platform === 'darwin') {
    const appBundle = findAppBundlePath(root);
    return join(appBundle, 'Contents', 'Resources');
  }

  const candidates = collectDirectories(root).filter((dir) =>
    existsSync(join(dir, 'resources')),
  );
  const resources = candidates
    .map((dir) => join(dir, 'resources'))
    .find((dir) => existsSync(join(dir, 'app.asar')));
  if (!resources) {
    throw new Error(`Could not find packaged resources under ${root}`);
  }

  return resources;
}

function findAppBundlePath(root) {
  if (process.platform !== 'darwin') {
    const executableDir = collectDirectories(root).find((dir) =>
      existsSync(join(dir, 'resources', 'app.asar')),
    );
    if (!executableDir) {
      throw new Error(`Could not find packaged app directory under ${root}`);
    }
    return executableDir;
  }

  const appBundle = collectDirectories(root).find((dir) =>
    dir.endsWith('.app'),
  );
  if (!appBundle) {
    throw new Error(`Could not find .app bundle under ${root}`);
  }

  return appBundle;
}

async function smokeLaunch(appBundlePath) {
  const executablePath = getExecutablePath(appBundlePath);
  if (!existsSync(executablePath)) {
    throw new Error(`Packaged executable is missing: ${executablePath}`);
  }

  const child = spawn(executablePath, [], {
    env: {
      ...process.env,
      QWEN_DESKTOP_SMOKE: '1',
    },
    stdio: 'ignore',
  });

  const exit = await waitForEarlyExit(child, 3000);
  if (exit) {
    throw new Error(
      `Packaged app exited during smoke launch: code=${exit.code}, signal=${exit.signal}`,
    );
  }

  child.kill('SIGTERM');
  await waitForExit(child, 5000);
  console.log(`Packaged launch smoke passed: ${executablePath}`);
}

function getExecutablePath(appBundlePath) {
  if (process.platform === 'darwin') {
    return join(appBundlePath, 'Contents', 'MacOS', 'Qwen Code');
  }

  if (process.platform === 'win32') {
    return join(appBundlePath, 'Qwen Code.exe');
  }

  return join(appBundlePath, 'qwen-code');
}

function waitForEarlyExit(child, ms) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, ms);
    const handleExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', handleExit);
    };
    child.once('exit', handleExit);
  });
}

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, ms);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function collectDirectories(root) {
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    result.push(current);
    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry);
      if (statSync(fullPath).isDirectory()) {
        pending.push(fullPath);
      }
    }
  }

  return result;
}
