/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_HOST_NAME,
} from '../src/bridge/protocol.js';

const execFileAsync = promisify(execFile);

export interface ManagedChrome {
  root: string;
  socketPath: string;
  chromeVersion: string;
  stop(): Promise<void>;
}

export async function launchManagedChrome(
  label: string,
): Promise<ManagedChrome> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const chromePath = await findChrome();
  const { stdout } = await execFileAsync(chromePath, ['--version'], {
    timeout: 5_000,
  });
  const chromeVersion = stdout.trim() || 'unknown';
  const parent = process.platform === 'darwin' ? '/tmp' : tmpdir();
  const root = await mkdtemp(join(parent, 'qbu-' + label + '-'));
  const socketPath = join(root, 'bridge.sock');
  const profile = join(root, 'profile');
  const extension = resolve(packageRoot, '../chrome-extension/dist/extension');
  const host = join(packageRoot, 'dist/native-host.js');
  try {
    await access(extension);
    await access(host);
    await mkdir(join(profile, 'NativeMessagingHosts'), { recursive: true });
    await mkdir(join(profile, 'Default'), { recursive: true });
    await writeFile(
      join(profile, 'Default', 'Preferences'),
      JSON.stringify({
        profile: { password_manager_leak_detection: false },
        credentials_enable_service: false,
        credentials_enable_autosignin: false,
      }),
    );
    const launcher = join(root, 'native-host.sh');
    await writeFile(
      launcher,
      '#!/bin/sh\nexport QWEN_BROWSER_USE_SOCKET_PATH=' +
        shellQuote(socketPath) +
        '\nexec ' +
        shellQuote(process.execPath) +
        ' ' +
        shellQuote(host) +
        '\n',
      { mode: 0o700 },
    );
    await writeFile(
      join(profile, 'NativeMessagingHosts', CHROME_NATIVE_HOST_NAME + '.json'),
      JSON.stringify({
        name: CHROME_NATIVE_HOST_NAME,
        description: 'Qwen Browser Use managed Chrome',
        path: launcher,
        type: 'stdio',
        allowed_origins: ['chrome-extension://' + CHROME_EXTENSION_ID + '/'],
      }),
    );
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--user-data-dir=' + profile,
      '--load-extension=' + extension,
      '--disable-extensions-except=' + extension,
      '--window-size=1280,900',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      'about:blank',
    ],
    {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  chrome.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    if (!text.includes('DEPRECATED_ENDPOINT')) {
      process.stderr.write('[managed-chrome] ' + text);
    }
  });

  return {
    root,
    socketPath,
    chromeVersion,
    async stop() {
      await stopProcess(chrome);
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function withManagedChrome(
  label: string,
  run: (chrome: ManagedChrome) => Promise<void>,
): Promise<void> {
  const chrome = await launchManagedChrome(label);
  const previous = process.env['QWEN_BROWSER_USE_SOCKET_PATH'];
  process.env['QWEN_BROWSER_USE_SOCKET_PATH'] = chrome.socketPath;
  try {
    await run(chrome);
  } finally {
    if (previous === undefined) {
      delete process.env['QWEN_BROWSER_USE_SOCKET_PATH'];
    } else {
      process.env['QWEN_BROWSER_USE_SOCKET_PATH'] = previous;
    }
    await chrome.stop();
  }
}

async function findChrome(): Promise<string> {
  const configured = process.env['QWEN_BROWSER_USE_CHROME']?.trim();
  if (configured) return configured;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
  ];
  for (const cache of [
    join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
  ]) {
    try {
      for (const entry of (await readdir(cache)).sort()) {
        if (!/^chromium-\d+$/.test(entry)) continue;
        candidates.unshift(
          join(
            cache,
            entry,
            'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          ),
          join(cache, entry, 'chrome-linux64/chrome'),
        );
      }
    } catch {
      // Cache root is absent.
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('Chrome was not found; set QWEN_BROWSER_USE_CHROME');
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  signal(child, 'SIGTERM');
  await Promise.race([
    exit,
    new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    signal(child, 'SIGKILL');
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
    ]);
  }
}

function signal(child: ChildProcess, signalName: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signalName);
    } else {
      child.kill(signalName);
    }
  } catch {
    // Process is already gone.
  }
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
