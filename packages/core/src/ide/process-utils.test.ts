/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeEach,
  type Mock,
} from 'vitest';
import { getIdeProcessInfo } from './process-utils.js';
import os from 'node:os';

const mockedExec = vi.hoisted(() => vi.fn());
vi.mock('node:util', () => ({
  promisify: vi.fn().mockReturnValue(mockedExec),
}));
vi.mock('node:os', () => ({
  default: {
    platform: vi.fn(),
  },
}));

describe('getIdeProcessInfo', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
    mockedExec.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('on Unix', () => {
    it('should traverse up to find the shell and return grandparent process info', async () => {
      (os.platform as Mock).mockReturnValue('linux');
      // process (1000) -> shell (800) -> IDE (700)
      mockedExec
        .mockResolvedValueOnce({ stdout: '800 /bin/bash' }) // pid 1000 -> ppid 800 (shell)
        .mockResolvedValueOnce({ stdout: '700 /usr/lib/vscode/code' }) // pid 800 -> ppid 700 (IDE)
        .mockResolvedValueOnce({ stdout: '700 /usr/lib/vscode/code' }); // get command for pid 700

      const result = await getIdeProcessInfo();

      expect(result).toEqual({ pid: 700, command: '/usr/lib/vscode/code' });
    });

    it('should return shell process info if grandparent lookup fails', async () => {
      (os.platform as Mock).mockReturnValue('linux');
      mockedExec
        .mockResolvedValueOnce({ stdout: '800 /bin/bash' }) // pid 1000 -> ppid 800 (shell)
        .mockRejectedValueOnce(new Error('ps failed')) // lookup for ppid of 800 fails
        .mockResolvedValueOnce({ stdout: '800 /bin/bash' }); // get command for pid 800

      const result = await getIdeProcessInfo();
      expect(result).toEqual({ pid: 800, command: '/bin/bash' });
    });
  });

  describe('on Windows', () => {
    it('should return great-grandparent process using heuristic', async () => {
      (os.platform as Mock).mockReturnValue('win32');

      const processes = [
        {
          ProcessId: 1000,
          ParentProcessId: 900,
          Name: 'node.exe',
          CommandLine: 'node.exe',
        },
        {
          ProcessId: 900,
          ParentProcessId: 800,
          Name: 'powershell.exe',
          CommandLine: 'powershell.exe',
        },
        {
          ProcessId: 800,
          ParentProcessId: 700,
          Name: 'code.exe',
          CommandLine: 'code.exe',
        },
        {
          ProcessId: 700,
          ParentProcessId: 0,
          Name: 'wininit.exe',
          CommandLine: 'wininit.exe',
        },
      ];

      mockedExec.mockImplementation((file: string, _args: string[]) => {
        if (file === 'powershell') {
          return Promise.resolve({ stdout: JSON.stringify(processes) });
        }
        return Promise.resolve({ stdout: '' });
      });

      const result = await getIdeProcessInfo();
      // Process chain: 1000 (node.exe) -> 900 (powershell.exe) -> 800 (code.exe) -> 700 (wininit.exe)
      // ancestors = [1000, 900, 800, 700], length = 4
      // Heuristic: return ancestors[length-3] = ancestors[1] = 900 (powershell.exe)
      expect(result).toEqual({ pid: 900, command: 'powershell.exe' });
    });

    it('should handle empty process list gracefully', async () => {
      (os.platform as Mock).mockReturnValue('win32');
      mockedExec.mockResolvedValue({ stdout: '[]' });

      const result = await getIdeProcessInfo();
      // Should return current pid and empty command because process not found in map
      expect(result).toEqual({ pid: 1000, command: '' });
    });

    it('should handle malformed JSON output gracefully', async () => {
      (os.platform as Mock).mockReturnValue('win32');
      mockedExec.mockResolvedValue({ stdout: '{"invalid":json}' });

      const result = await getIdeProcessInfo();
      expect(result).toEqual({ pid: 1000, command: '' });
    });

    it('should return last ancestor if chain is too short', async () => {
      (os.platform as Mock).mockReturnValue('win32');

      const processes = [
        {
          ProcessId: 1000,
          ParentProcessId: 900,
          Name: 'node.exe',
          CommandLine: 'node.exe',
        },
        {
          ProcessId: 900,
          ParentProcessId: 0,
          Name: 'explorer.exe',
          CommandLine: 'explorer.exe',
        },
      ];

      mockedExec.mockImplementation((file: string, _args: string[]) => {
        if (file === 'powershell') {
          return Promise.resolve({ stdout: JSON.stringify(processes) });
        }
        return Promise.resolve({ stdout: '' });
      });

      const result = await getIdeProcessInfo();
      // ancestors = [1000, 900], length = 2 (< 3)
      // Heuristic: return ancestors[length-1] = ancestors[1] = 900 (explorer.exe)
      expect(result).toEqual({ pid: 900, command: 'explorer.exe' });
    });
  });
});
