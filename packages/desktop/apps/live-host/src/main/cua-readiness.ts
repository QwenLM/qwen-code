import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import type { PermissionState } from '../shared/protocol.ts';
import { PINNED_CUA_DRIVER_VERSION } from '../shared/cua-driver-version.ts';

const execFileAsync = promisify(execFile);
const MAX_STATUS_BYTES = 64 * 1024;
const CUA_BUNDLE_ID = 'com.trycua.driver';
const CUA_TEAM_ID = 'YCK386LBJ7';
const CUA_EXECUTABLE_SUFFIX = join(
  'CuaDriver.app',
  'Contents',
  'MacOS',
  'cua-driver',
);

export type CuaReadiness = {
  installed: boolean;
  accessibility: PermissionState;
  screenRecording: PermissionState;
  appshot: boolean;
};

const EMPTY_READINESS: CuaReadiness = {
  installed: false,
  accessibility: 'not_determined',
  screenRecording: 'not_determined',
  appshot: false,
};

export function parseCuaPermissionStatus(value: string): CuaReadiness {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ...EMPTY_READINESS, installed: true };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...EMPTY_READINESS, installed: true };
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.accessibility !== 'boolean' ||
    typeof record.screen_recording !== 'boolean'
  ) {
    return { ...EMPTY_READINESS, installed: true };
  }
  const accessibility = record.accessibility ? 'granted' : 'denied';
  const screenRecording = record.screen_recording ? 'granted' : 'denied';
  return {
    installed: true,
    accessibility,
    screenRecording,
    appshot:
      accessibility === 'granted' &&
      screenRecording === 'granted' &&
      record.screen_recording_capturable === true,
  };
}

export function hasExpectedCuaDriverIdentity(value: string): boolean {
  return (
    value
      .split(/\r?\n/u)
      .some((line) => line.trim() === `Identifier=${CUA_BUNDLE_ID}`) &&
    value
      .split(/\r?\n/u)
      .some((line) => line.trim() === `TeamIdentifier=${CUA_TEAM_ID}`)
  );
}

export function isCuaDriverBundleExecutablePath(path: string): boolean {
  const normalized = normalize(path);
  const macosDirectory = dirname(normalized);
  const contentsDirectory = dirname(macosDirectory);
  const appDirectory = dirname(contentsDirectory);
  return (
    basename(normalized) === 'cua-driver' &&
    basename(macosDirectory) === 'MacOS' &&
    basename(contentsDirectory) === 'Contents' &&
    basename(appDirectory) === 'CuaDriver.app' &&
    normalized.endsWith(CUA_EXECUTABLE_SUFFIX)
  );
}

type ExecFileResult = { stdout: string; stderr: string };
type BoundedExec = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<ExecFileResult>;

const boundedExec: BoundedExec = async (file, args, options) => {
  const result = await execFileAsync(file, [...args], options);
  return { stdout: result.stdout, stderr: result.stderr };
};

export async function validateCuaDriverBundle(
  executable: string,
  run: BoundedExec = boundedExec,
): Promise<boolean> {
  if (!isCuaDriverBundleExecutablePath(executable)) return false;
  try {
    await access(executable, constants.X_OK);
    const appPath = dirname(dirname(dirname(executable)));
    if ((await lstat(executable)).isSymbolicLink()) return false;
    for (const directory of [
      dirname(executable),
      dirname(dirname(executable)),
      appPath,
    ]) {
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        return false;
      }
    }
    const metadata = await run(
      '/usr/libexec/PlistBuddy',
      [
        '-c',
        'Print :CFBundleIdentifier',
        join(appPath, 'Contents', 'Info.plist'),
      ],
      { timeout: 5_000, maxBuffer: MAX_STATUS_BYTES },
    );
    if (metadata.stdout.trim() !== CUA_BUNDLE_ID) return false;
    await run(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', appPath],
      {
        timeout: 5_000,
        maxBuffer: MAX_STATUS_BYTES,
      },
    );
    const signature = await run(
      '/usr/bin/codesign',
      ['-dv', '--verbose=4', appPath],
      { timeout: 5_000, maxBuffer: MAX_STATUS_BYTES },
    );
    return hasExpectedCuaDriverIdentity(
      `${signature.stdout}\n${signature.stderr}`,
    );
  } catch {
    return false;
  }
}

export async function findInstalledCuaDriver(
  home = homedir(),
  arch = process.arch,
  validate: (executable: string) => Promise<boolean> =
    validateCuaDriverBundle,
): Promise<string | undefined> {
  const root = join(home, '.qwen', 'computer-use');
  const architecture = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64';
  const versionDirectory = `cua-driver-rs-${PINNED_CUA_DRIVER_VERSION}`;
  const candidate = join(
    root,
    versionDirectory,
    `cua-driver-rs-${PINNED_CUA_DRIVER_VERSION}-${architecture}`,
    'CuaDriver.app',
    'Contents',
    'MacOS',
    'cua-driver',
  );
  return (await validate(candidate)) ? candidate : undefined;
}

export class CuaReadinessMonitor {
  private timer: NodeJS.Timeout | undefined;
  private driverPath: string | undefined;
  private lastState = '';
  private lastStatusDaemonLaunch = 0;
  private statusDaemonLaunchAttempts = 0;
  private polling = false;

  constructor(
    private readonly onState: (state: CuaReadiness) => void,
    private readonly intervalMs = 3_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  requestPermission(_kind: 'accessibility' | 'screenRecording'): void {
    this.statusDaemonLaunchAttempts = 0;
    void this.grantPermissions();
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    this.driverPath = this.driverPath ?? (await findInstalledCuaDriver());
    if (!this.driverPath) {
      this.publish(EMPTY_READINESS);
      return;
    }

    let state: CuaReadiness;
    try {
      const { stdout } = await execFileAsync(
        this.driverPath,
        ['permissions', 'status', '--json'],
        { timeout: 5_000, maxBuffer: MAX_STATUS_BYTES },
      );
      state = parseCuaPermissionStatus(stdout);
    } catch {
      state = { ...EMPTY_READINESS, installed: true };
    }
    this.publish(state);
    if (
      state.accessibility === 'not_determined' ||
      state.screenRecording === 'not_determined'
    ) {
      await this.ensureStatusDaemon();
    }
  }

  private async ensureStatusDaemon(): Promise<void> {
    this.driverPath = this.driverPath ?? (await findInstalledCuaDriver());
    if (
      !this.driverPath ||
      this.statusDaemonLaunchAttempts >= 3 ||
      Date.now() - this.lastStatusDaemonLaunch < 10_000
    ) {
      return;
    }
    this.lastStatusDaemonLaunch = Date.now();
    this.statusDaemonLaunchAttempts += 1;
    const appPath = join(this.driverPath, '..', '..', '..');
    await boundedExec(
      '/usr/bin/open',
      ['-n', '-g', '-a', appPath, '--args', 'serve', '--no-permissions-gate'],
      { timeout: 5_000, maxBuffer: MAX_STATUS_BYTES },
    ).catch(() => undefined);
  }

  private async grantPermissions(): Promise<void> {
    this.driverPath = this.driverPath ?? (await findInstalledCuaDriver());
    if (!this.driverPath) return;
    await boundedExec(this.driverPath, ['permissions', 'grant'], {
      timeout: 30_000,
      maxBuffer: MAX_STATUS_BYTES,
    }).catch(() => undefined);
  }

  private publish(state: CuaReadiness): void {
    const serialized = JSON.stringify(state);
    if (serialized === this.lastState) return;
    this.lastState = serialized;
    this.onState(state);
  }
}
