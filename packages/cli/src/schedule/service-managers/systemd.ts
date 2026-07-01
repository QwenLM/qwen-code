/**
 * Linux systemd service manager for the schedule daemon.
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

const SERVICE_NAME = 'qwen-schedule-daemon';

function getServiceFilePath(): string {
  return path.join(
    os.homedir(),
    '.config',
    'systemd',
    'user',
    `${SERVICE_NAME}.service`,
  );
}

function generateServiceFile(): string {
  const qwenBinary = getQwenBinaryPath();
  const stdoutLog = getStdoutLogPath();
  const stderrLog = getStderrLogPath();

  return `[Unit]
Description=Qwen Schedule Daemon
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${qwenBinary} schedule daemon start
Restart=always
RestartSec=10
StandardOutput=append:${stdoutLog}
StandardError=append:${stderrLog}
WorkingDirectory=${os.homedir()}

[Install]
WantedBy=default.target
`;
}

export class SystemdServiceManager implements ServiceManager {
  name = 'systemd';

  async isAvailable(): Promise<boolean> {
    const result = await runCommand('which', ['systemctl']);
    return result.exitCode === 0;
  }

  async install(): Promise<void> {
    const servicePath = getServiceFilePath();
    const serviceDir = path.dirname(servicePath);

    await fs.mkdir(serviceDir, { recursive: true });
    await fs.mkdir(path.dirname(getStdoutLogPath()), { recursive: true });
    await fs.writeFile(servicePath, generateServiceFile(), 'utf-8');

    // Reload systemd daemon
    await runCommand('systemctl', ['--user', 'daemon-reload']);

    // Enable and start the service
    const enableResult = await runCommand('systemctl', [
      '--user',
      'enable',
      SERVICE_NAME,
    ]);
    if (enableResult.exitCode !== 0) {
      throw new Error(
        `Failed to enable systemd service: ${enableResult.stderr}`,
      );
    }

    const startResult = await runCommand('systemctl', [
      '--user',
      'start',
      SERVICE_NAME,
    ]);
    if (startResult.exitCode !== 0) {
      throw new Error(`Failed to start systemd service: ${startResult.stderr}`);
    }
  }

  async uninstall(): Promise<void> {
    const servicePath = getServiceFilePath();

    // Stop and disable the service
    try {
      await runCommand('systemctl', ['--user', 'stop', SERVICE_NAME]);
    } catch {
      // Ignore stop errors
    }

    try {
      await runCommand('systemctl', ['--user', 'disable', SERVICE_NAME]);
    } catch {
      // Ignore disable errors
    }

    // Remove the service file
    try {
      await fs.unlink(servicePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    // Reload systemd daemon
    await runCommand('systemctl', ['--user', 'daemon-reload']);
  }

  async status(): Promise<ServiceStatus> {
    const servicePath = getServiceFilePath();

    let installed = false;
    try {
      await fs.access(servicePath);
      installed = true;
    } catch {
      return { installed: false, running: false, enabled: false };
    }

    const result = await runCommand('systemctl', [
      '--user',
      'is-active',
      SERVICE_NAME,
    ]);
    const running = result.exitCode === 0 && result.stdout === 'active';

    const enabledResult = await runCommand('systemctl', [
      '--user',
      'is-enabled',
      SERVICE_NAME,
    ]);
    const enabled =
      enabledResult.exitCode === 0 && enabledResult.stdout === 'enabled';

    return { installed, running, enabled };
  }

  async start(): Promise<void> {
    const result = await runCommand('systemctl', [
      '--user',
      'start',
      SERVICE_NAME,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start service: ${result.stderr}`);
    }
  }

  async stop(): Promise<void> {
    const result = await runCommand('systemctl', [
      '--user',
      'stop',
      SERVICE_NAME,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to stop service: ${result.stderr}`);
    }
  }
}
