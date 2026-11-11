/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const existsSync = vi.fn<(path: string) => boolean>();
const readFileSync = vi.fn<(path: string, encoding: string) => string>();
const cpus = vi.fn<() => Array<{ model: string }>>();
const execFileSync = vi.fn<(file: string, args: string[]) => string>();

vi.mock('node:fs', () => ({
  existsSync: (path: string) => existsSync(path),
  readFileSync: (path: string, encoding: string) =>
    readFileSync(path, encoding),
}));

vi.mock('node:os', () => ({
  cpus: () => cpus(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (file: string, args: string[]) => execFileSync(file, args),
}));

const { detectContainer, detectRosetta } = await import('./hostEnvironment.js');

describe('detectContainer', () => {
  const originalDockerContainer = process.env['DOCKER_CONTAINER'];
  const originalPlatform = process.platform;

  beforeEach(() => {
    existsSync.mockReset();
    readFileSync.mockReset();
    existsSync.mockReturnValue(false);
    readFileSync.mockReturnValue('');
    delete process.env['DOCKER_CONTAINER'];
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalDockerContainer === undefined) {
      delete process.env['DOCKER_CONTAINER'];
    } else {
      process.env['DOCKER_CONTAINER'] = originalDockerContainer;
    }
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('skips probing off Linux', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });
    existsSync.mockReturnValue(true);

    expect(detectContainer()).toBe(false);
    expect(existsSync).not.toHaveBeenCalled();
  });

  it('detects Docker via the /.dockerenv marker', () => {
    existsSync.mockImplementation((path) => path === '/.dockerenv');

    expect(detectContainer()).toBe(true);
  });

  it('detects podman via the /run/.containerenv marker', () => {
    existsSync.mockImplementation((path) => path === '/run/.containerenv');

    expect(detectContainer()).toBe(true);
  });

  it('detects containerd from the PID 1 cgroup', () => {
    existsSync.mockImplementation((path) => path === '/proc/1/cgroup');
    readFileSync.mockReturnValue('0::/system.slice/containerd.service');

    expect(detectContainer()).toBe(true);
  });

  it('detects Kubernetes from the PID 1 cgroup', () => {
    existsSync.mockImplementation((path) => path === '/proc/1/cgroup');
    readFileSync.mockReturnValue('0::/kubepods/besteffort/pod123');

    expect(detectContainer()).toBe(true);
  });

  it('falls back to the DOCKER_CONTAINER env var', () => {
    process.env['DOCKER_CONTAINER'] = '1';

    expect(detectContainer()).toBe(true);
  });

  it('returns false on a plain host', () => {
    expect(detectContainer()).toBe(false);
  });

  it('returns false when the cgroup names no container runtime', () => {
    existsSync.mockImplementation((path) => path === '/proc/1/cgroup');
    readFileSync.mockReturnValue('0::/init.scope');

    expect(detectContainer()).toBe(false);
  });

  it('treats an unreadable cgroup as not a container', () => {
    existsSync.mockImplementation((path) => path === '/proc/1/cgroup');
    readFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    expect(detectContainer()).toBe(false);
  });

  it('never lets a filesystem failure escape', () => {
    existsSync.mockImplementation(() => {
      throw new Error('EPERM');
    });

    expect(() => detectContainer()).not.toThrow();
    expect(detectContainer()).toBe(false);
  });
});

describe('detectRosetta', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  function fakeHost(platform: string, arch: string) {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
    Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  }

  beforeEach(() => {
    cpus.mockReset();
    execFileSync.mockReset();
    cpus.mockReturnValue([{ model: 'Apple M4 Pro' }]);
    execFileSync.mockReturnValue('0');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    Object.defineProperty(process, 'arch', {
      value: originalArch,
      configurable: true,
    });
  });

  it('detects translation when an x64 process reports an Apple chip', () => {
    fakeHost('darwin', 'x64');
    cpus.mockReturnValue([{ model: 'Apple M4 Pro' }]);

    expect(detectRosetta()).toBe(true);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('reports false on a genuine Intel Mac', () => {
    fakeHost('darwin', 'x64');
    cpus.mockReturnValue([
      { model: 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz' },
    ]);

    expect(detectRosetta()).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('skips detection entirely on native arm64', () => {
    fakeHost('darwin', 'arm64');

    expect(detectRosetta()).toBe(false);
    expect(cpus).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('skips detection entirely off macOS', () => {
    fakeHost('linux', 'x64');

    expect(detectRosetta()).toBe(false);
    expect(cpus).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('falls back to sysctl when the CPU model names no known vendor', () => {
    fakeHost('darwin', 'x64');
    cpus.mockReturnValue([{ model: 'Virtual CPU @ 3.00GHz' }]);
    execFileSync.mockReturnValue('1\n');

    expect(detectRosetta()).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('sysctl', [
      '-n',
      'sysctl.proc_translated',
    ]);
  });

  it('honours a negative sysctl fallback', () => {
    fakeHost('darwin', 'x64');
    cpus.mockReturnValue([{ model: 'Virtual CPU @ 3.00GHz' }]);
    execFileSync.mockReturnValue('0\n');

    expect(detectRosetta()).toBe(false);
  });

  it('reports false when the sysctl fallback is unavailable', () => {
    fakeHost('darwin', 'x64');
    cpus.mockReturnValue([{ model: 'Virtual CPU @ 3.00GHz' }]);
    execFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(detectRosetta()).toBe(false);
  });

  it('never lets a cpus() failure escape', () => {
    fakeHost('darwin', 'x64');
    cpus.mockImplementation(() => {
      throw new Error('EINVAL');
    });

    expect(() => detectRosetta()).not.toThrow();
    expect(detectRosetta()).toBe(false);
  });
});
