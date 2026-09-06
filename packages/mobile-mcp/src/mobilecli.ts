import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { execFileSync, spawn, ChildProcess } from 'node:child_process';

export interface MobilecliCrashEntry {
  processName: string;
  timestamp: string;
  id: string;
}

export interface MobilecliCrashesListResponse {
  status: 'ok';
  data: MobilecliCrashEntry[];
}

export interface MobilecliCrashGetResponse {
  status: 'ok';
  data: {
    content: string;
    id: string;
  };
}

export interface MobilecliAgentStatusResponse {
  status: 'ok' | 'fail';
  data: {
    message: string;
  };
}

export interface MobilecliDevicesOptions {
  includeOffline?: boolean;
  platform?: 'ios' | 'android';
  type?: 'real' | 'emulator' | 'simulator';
}

export interface MobilecliDeviceProvider {
  type: string; // e.g. "mobilefleet" for remote devices
  allocationId?: string;
}

export interface MobilecliDevice {
  id: string;
  name: string;
  platform: 'android' | 'ios';
  type: 'real' | 'emulator' | 'simulator';
  version: string;
  provider?: MobilecliDeviceProvider;
}

export interface MobilecliDevicesResponse {
  status: 'ok';
  data: {
    devices: MobilecliDevice[];
  };
}

const TIMEOUT = 30000;
const MAX_BUFFER_SIZE = 1024 * 1024 * 8;

export class Mobilecli {
  private path: string | null = null;

  constructor() {}

  private getPath(): string {
    if (!this.path) {
      this.path = Mobilecli.getMobilecliPath();
    }
    return this.path;
  }

  public executeCommand(args: string[]): string {
    const path = this.getPath();
    return execFileSync(path, args, { encoding: 'utf8' }).toString().trim();
  }

  public spawnCommand(args: string[]): ChildProcess {
    const binaryPath = this.getPath();
    return spawn(binaryPath, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  }

  public executeCommandBuffer(args: string[]): Buffer {
    const path = this.getPath();
    return execFileSync(path, args, {
      encoding: 'buffer',
      maxBuffer: MAX_BUFFER_SIZE,
      timeout: TIMEOUT,
    }) as Buffer;
  }

  private static getMobilecliPath(): string {
    if (process.env.MOBILECLI_PATH) {
      return process.env.MOBILECLI_PATH;
    }

    const platform = process.platform;
    const arch = process.arch;

    const normalizedPlatform = platform === 'win32' ? 'windows' : platform;
    const normalizedArch = arch === 'arm64' ? 'arm64' : 'amd64';
    const ext = platform === 'win32' ? '.exe' : '';
    const binaryName = `mobilecli-${normalizedPlatform}-${normalizedArch}${ext}`;

    // Check if mobile-mcp is installed as a package
    const currentPath = __filename;
    const pathParts = currentPath.split(sep);
    const lastNodeModulesIndex = pathParts.lastIndexOf('node_modules');

    if (lastNodeModulesIndex !== -1) {
      // We're inside node_modules, go to the last node_modules in the path
      const nodeModulesParts = pathParts.slice(0, lastNodeModulesIndex + 1);
      const lastNodeModulesPath = nodeModulesParts.join(sep);
      const mobilecliPath = join(
        lastNodeModulesPath,
        'mobilecli',
        'bin',
        binaryName,
      );

      if (existsSync(mobilecliPath)) {
        return mobilecliPath;
      }
    }

    // Not in node_modules, look one directory up from current script
    const scriptDir = dirname(__filename);
    const parentDir = dirname(scriptDir);
    const mobilecliPath = join(
      parentDir,
      'node_modules',
      'mobilecli',
      'bin',
      binaryName,
    );

    if (existsSync(mobilecliPath)) {
      return mobilecliPath;
    }

    throw new Error(
      `Could not find mobilecli binary for platform: ${platform}`,
    );
  }

  getVersion(): string {
    try {
      const output = this.executeCommand(['--version']);
      if (output.startsWith('mobilecli version ')) {
        return output.substring('mobilecli version '.length);
      }

      return 'failed';
    } catch (error: any) {
      return 'failed ' + error.message;
    }
  }

  remoteListDevices(): string {
    return this.executeCommand(['remote', 'list-devices']);
  }

  remoteAllocate(platform: 'ios' | 'android'): string {
    return this.executeCommand(['remote', 'allocate', '--platform', platform]);
  }

  remoteRelease(deviceId: string): string {
    return this.executeCommand(['remote', 'release', '--device', deviceId]);
  }

  crashesList(deviceId: string): MobilecliCrashesListResponse {
    const output = this.executeCommand([
      'device',
      'crashes',
      'list',
      '--device',
      deviceId,
    ]);
    return JSON.parse(output) as MobilecliCrashesListResponse;
  }

  crashesGet(deviceId: string, id: string): MobilecliCrashGetResponse {
    const output = this.executeCommandBuffer([
      'device',
      'crashes',
      'get',
      id,
      '--device',
      deviceId,
    ]);
    return JSON.parse(output.toString().trim()) as MobilecliCrashGetResponse;
  }

  agentStatus(deviceId: string): MobilecliAgentStatusResponse {
    const output = this.executeCommand([
      'agent',
      'status',
      '--device',
      deviceId,
    ]);
    return JSON.parse(output) as MobilecliAgentStatusResponse;
  }

  agentInstall(deviceId: string): void {
    this.executeCommand(['agent', 'install', '--device', deviceId]);
  }

  getDevices(options?: MobilecliDevicesOptions): MobilecliDevicesResponse {
    const args = ['devices'];

    if (options) {
      if (options.includeOffline) {
        args.push('--include-offline');
      }

      if (options.platform) {
        if (options.platform !== 'ios' && options.platform !== 'android') {
          throw new Error(
            `Invalid platform: ${options.platform}. Must be "ios" or "android"`,
          );
        }

        args.push('--platform', options.platform);
      }

      if (options.type) {
        if (
          options.type !== 'real' &&
          options.type !== 'emulator' &&
          options.type !== 'simulator'
        ) {
          throw new Error(
            `Invalid type: ${options.type}. Must be "real", "emulator", or "simulator"`,
          );
        }

        args.push('--type', options.type);
      }
    }

    const mobilecliOutput = this.executeCommand(args);
    return JSON.parse(mobilecliOutput) as MobilecliDevicesResponse;
  }
}
