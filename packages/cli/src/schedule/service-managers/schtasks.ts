/**
 * Windows schtasks service manager for the schedule daemon.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ServiceManager, ServiceStatus } from './index.js';
import { runCommand, getQwenBinaryPath, getStdoutLogPath } from './index.js';

const TASK_NAME = 'QwenScheduleDaemon';

function getMarkerFilePath(): string {
  return path.join(os.homedir(), '.qwen', 'schedule-daemon-service.marker');
}

export class SchtasksServiceManager implements ServiceManager {
  name = 'schtasks';

  async isAvailable(): Promise<boolean> {
    const result = await runCommand('where', ['schtasks']);
    return result.exitCode === 0;
  }

  async install(): Promise<void> {
    const qwenBinary = getQwenBinaryPath();
    const stdoutLog = getStdoutLogPath();

    // Ensure log directory exists
    await fs.mkdir(path.dirname(stdoutLog), { recursive: true });

    // Create the scheduled task
    const command = `"${process.execPath}" "${qwenBinary}" schedule daemon start`;
    const result = await runCommand('schtasks', [
      '/create',
      '/tn',
      TASK_NAME,
      '/tr',
      command,
      '/sc',
      'onlogon',
      '/rl',
      'highest',
      '/f', // Force creation if exists
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to create scheduled task: ${result.stderr}`);
    }

    // Write marker file to track installation
    await fs.writeFile(getMarkerFilePath(), 'installed', 'utf-8');
  }

  async uninstall(): Promise<void> {
    // Delete the scheduled task
    try {
      await runCommand('schtasks', ['/delete', '/tn', TASK_NAME, '/f']);
    } catch {
      // Ignore errors if task doesn't exist
    }

    // Remove marker file
    try {
      await fs.unlink(getMarkerFilePath());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async status(): Promise<ServiceStatus> {
    const markerPath = getMarkerFilePath();

    let installed = false;
    try {
      await fs.access(markerPath);
      installed = true;
    } catch {
      return { installed: false, running: false, enabled: false };
    }

    // Query the task status
    const result = await runCommand('schtasks', [
      '/query',
      '/tn',
      TASK_NAME,
      '/fo',
      'list',
    ]);
    if (result.exitCode !== 0) {
      return { installed: false, running: false, enabled: false };
    }

    const running =
      result.stdout.includes('Running') &&
      result.stdout.includes('Status:                 Running');
    const enabled =
      result.stdout.includes('Enabled') && !result.stdout.includes('Disabled');

    return { installed, running, enabled };
  }

  async start(): Promise<void> {
    const result = await runCommand('schtasks', ['/run', '/tn', TASK_NAME]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start task: ${result.stderr}`);
    }
  }

  async stop(): Promise<void> {
    const result = await runCommand('schtasks', ['/end', '/tn', TASK_NAME]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to stop task: ${result.stderr}`);
    }
  }
}
