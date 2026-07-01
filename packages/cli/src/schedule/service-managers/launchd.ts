/**
 * macOS launchd service manager for the schedule daemon.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ServiceManager, ServiceStatus } from './index.js';
import {
  runCommand,
  getQwenBinaryPath,
  getStdoutLogPath,
  getStderrLogPath,
} from './index.js';

const SERVICE_LABEL = 'dev.qwen.schedule-daemon';

function getPlistPath(): string {
  return path.join(
    os.homedir(),
    'Library',
    'LaunchAgents',
    `${SERVICE_LABEL}.plist`,
  );
}

function generatePlist(): string {
  const qwenBinary = getQwenBinaryPath();
  const stdoutLog = getStdoutLogPath();
  const stderrLog = getStderrLogPath();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${qwenBinary}</string>
        <string>schedule</string>
        <string>daemon</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${stdoutLog}</string>
    <key>StandardErrorPath</key>
    <string>${stderrLog}</string>
    <key>WorkingDirectory</key>
    <string>${os.homedir()}</string>
</dict>
</plist>
`;
}

export class LaunchdServiceManager implements ServiceManager {
  name = 'launchd';

  async isAvailable(): Promise<boolean> {
    const result = await runCommand('which', ['launchctl']);
    return result.exitCode === 0;
  }

  async install(): Promise<void> {
    const plistPath = getPlistPath();
    const plistDir = path.dirname(plistPath);

    await fs.mkdir(plistDir, { recursive: true });
    await fs.mkdir(path.dirname(getStdoutLogPath()), { recursive: true });
    await fs.writeFile(plistPath, generatePlist(), 'utf-8');

    const result = await runCommand('launchctl', ['load', '-w', plistPath]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to load launchd service: ${result.stderr}`);
    }
  }

  async uninstall(): Promise<void> {
    const plistPath = getPlistPath();

    try {
      await runCommand('launchctl', ['unload', '-w', plistPath]);
    } catch {
      // Ignore unload errors
    }

    try {
      await fs.unlink(plistPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async status(): Promise<ServiceStatus> {
    const plistPath = getPlistPath();

    let installed = false;
    try {
      await fs.access(plistPath);
      installed = true;
    } catch {
      return { installed: false, running: false, enabled: false };
    }

    const result = await runCommand('launchctl', ['list', SERVICE_LABEL]);
    const running =
      result.exitCode === 0 && result.stdout.includes(SERVICE_LABEL);
    const enabled = installed;

    return { installed, running, enabled };
  }

  async start(): Promise<void> {
    const result = await runCommand('launchctl', ['start', SERVICE_LABEL]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start service: ${result.stderr}`);
    }
  }

  async stop(): Promise<void> {
    const result = await runCommand('launchctl', ['stop', SERVICE_LABEL]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to stop service: ${result.stderr}`);
    }
  }
}
