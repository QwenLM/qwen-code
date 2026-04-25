/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ElectronCommandLine {
  appendSwitch(name: string, value?: string): void;
}

export function configureDesktopRemoteDebugging(
  commandLine: ElectronCommandLine,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const port = getDesktopCdpPort(env);
  if (!port) {
    return false;
  }

  commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  commandLine.appendSwitch('remote-debugging-port', port);
  return true;
}

function getDesktopCdpPort(env: NodeJS.ProcessEnv): string | null {
  const rawPort = env['QWEN_DESKTOP_CDP_PORT']?.trim();
  if (!rawPort || !/^\d+$/u.test(rawPort)) {
    return null;
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return String(port);
}
