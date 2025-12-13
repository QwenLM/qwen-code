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

    it('should return parent process info if grandparent lookup fails', async () => {
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
    it('should traverse up and find the great-grandchild of the root process', async () => {
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
        // Fallback for getProcessInfo calls if any (should not happen in new logic for Windows traversal)
        return Promise.resolve({ stdout: '' });
      });

      const result = await getIdeProcessInfo();
      // 1000 -> 900 -> 800 -> 700 (root child)
      // Great-grandchild of root (700) is 900.
      // Wait, logic is:
      // 700 (root child) -> 800 (grandchild) -> 900 (great-grandchild) -> 1000 (current)
      // The code looks for the grandchild of the root.
      // Root is 0 (conceptually). Child of root is 700. Grandchild is 800.
      // The code says:
      // "We've found the grandchild of the root (`currentPid`). The IDE process is its child, which we've stored in `previousPid`."

      // Let's trace the loop in `getIdeProcessInfoForWindows`:
      // currentPid = 1000, previousPid = 1000
      // Loop 1:
      //   proc = 1000. parentPid = 900.
      //   parentProc = 900. parentProc.parentPid = 800 != 0.
      //   previousPid = 1000. currentPid = 900.
      // Loop 2:
      //   proc = 900. parentPid = 800.
      //   parentProc = 800. parentProc.parentPid = 700 != 0.
      //   previousPid = 900. currentPid = 800.
      // Loop 3:
      //   proc = 800. parentPid = 700.
      //   parentProc = 700. parentProc.parentPid = 0.
      //   MATCH!
      //   ideProc = processMap.get(previousPid) = processMap.get(900) = powershell.exe
      //   return { pid: 900, command: 'powershell.exe' }

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
      mockedExec.mockResolvedValue({ stdout: '{"invalid":json}' }); // Malformed JSON will throw in JSON.parse

      // If JSON.parse fails, getProcessTreeForWindows returns empty map.
      // Then getIdeProcessInfoForWindows returns current pid.

      // Wait, mockedExec throws? No, JSON.parse throws.
      // getProcessTreeForWindows catches error and returns empty map.

      const result = await getIdeProcessInfo();
      expect(result).toEqual({ pid: 1000, command: '' });
    });
  });
});
