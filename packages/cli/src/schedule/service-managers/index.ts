/**
 * Service manager abstraction for installing the schedule daemon as a system service.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export interface ServiceManager {
  name: string;
  isAvailable(): Promise<boolean>;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  status(): Promise<ServiceStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  enabled: boolean;
  pid?: number;
}

export async function getServiceManager(): Promise<ServiceManager> {
  const platform = os.platform();

  if (platform === 'darwin') {
    const { LaunchdServiceManager } = await import('./launchd.js');
    return new LaunchdServiceManager();
  } else if (platform === 'linux') {
    const { SystemdServiceManager } = await import('./systemd.js');
    return new SystemdServiceManager();
  } else if (platform === 'win32') {
    const { SchtasksServiceManager } = await import('./schtasks.js');
    return new SchtasksServiceManager();
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

export async function runCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'pipe' });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      });
    });

    child.on('error', (err) => {
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}

export function getQwenBinaryPath(): string {
  return process.argv[1] || 'qwen';
}

export function getLogDir(): string {
  return path.join(os.homedir(), '.qwen', 'logs');
}

export function getStdoutLogPath(): string {
  return path.join(getLogDir(), 'schedule-daemon.log');
}

export function getStderrLogPath(): string {
  return path.join(getLogDir(), 'schedule-daemon.err.log');
}
