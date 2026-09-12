#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';
import {
  installChromeNativeHost,
  nativeHostInstallHome,
  statusChromeNativeHost,
  uninstallChromeNativeHost,
} from '../src/native-host-installer.js';

const command = process.argv[2] ?? 'status';
const options = {
  homeDir: nativeHostInstallHome(),
  nativeHostPath: fileURLToPath(new URL('../native-host.js', import.meta.url)),
};

const result =
  command === 'install'
    ? await installChromeNativeHost(options)
    : command === 'uninstall'
      ? await uninstallChromeNativeHost(options)
      : command === 'status'
        ? await statusChromeNativeHost(options)
        : null;

if (!result) {
  process.stderr.write(
    'Usage: native-host-setup.js install|status|uninstall\n',
  );
  process.exit(2);
}
process.stdout.write(JSON.stringify({ command, ...result }) + '\n');
