/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { runLogger } from './runLogger.js';
import * as shellUtils from './shell-utils.js';
import { quote } from 'shell-quote';
import { exec } from './Shell.js';
import { windowsPathToPosixPath } from './windowsPaths.js';
import {
  readWindowsProcessSnapshot,
  selectWindowsDescendants,
  terminateWindowsProcesses,
  type WindowsProcessIdentity,
  WINDOWS_PROCESS_CALL_TIMEOUT_MS,
} from './windowsProcessSnapshot.js';

const windows = process.platform === 'win32';
const sleepScript =
  'sleep 900 & target=$!; sleep 0.1; builtin printf "TARGET=%s\\n" "$(< /proc/$target/winpid)"; wait "$target"';
const nodeLeaf = "console.log('TARGET='+process.pid);setInterval(()=>{},1000)";
const nestedSequential = `bash -c ${quote([`bash -c ${quote([sleepScript + '; ' + sleepScript])}; ${sleepScript}`])}; ${sleepScript}`;
const nestedConcurrent = `bash -c ${quote([`bash -c ${quote([sleepScript])} & ${sleepScript}; wait`])} & ${sleepScript}; wait`;
const cases: Array<{ name: string; script: string; targets?: number }> = [
  { name: 'three-level sequential sleep', script: nestedSequential },
  {
    name: 'three-level concurrent sleep',
    script: nestedConcurrent,
    targets: 3,
  },
  ...Array.from({ length: 20 }, (_, index) => ({
    name: `sleep round ${index}`,
    script: sleepScript,
  })),
  { name: 'pipeline', script: `(${sleepScript}) | cat` },
  {
    name: 'exec sleep',
    // Observe the replacement from a sibling before reporting its native PID.
    script:
      'leader=$BASHPID; old=$(< /proc/$leader/winpid); (for ((i=0;i<200;i++)); do current=$(< /proc/$leader/winpid) || exit 1; if [[ $current != "$old" && -n $current ]]; then builtin echo "TARGET=$current"; exit; fi; sleep 0.025; done) & exec sleep 900',
  },
  {
    name: 'native Node descendant',
    script: quote([
      windowsPathToPosixPath(process.execPath),
      '-e',
      `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(nodeLeaf)}],{stdio:'inherit'});setInterval(()=>{},1000)`,
    ]),
  },
];

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for child identity');
    await delay(25);
  }
}

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

describe.skipIf(!windows).each(['system', 'constrained'] as const)(
  'Windows Git Bash background stop (%s)',
  (mode) => {
    beforeAll(async () => {
      const { stdout } = await shellUtils.spawnAsync(
        path.win32.join(
          process.env['SystemRoot'] ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$ExecutionContext.SessionState.LanguageMode',
        ],
        { windowsHide: true, timeout: WINDOWS_PROCESS_CALL_TIMEOUT_MS },
      );
      runLogger.log(
        `[WindowsStopTest] group=${mode}, systemLanguageMode=${stdout.trim()}`,
      );
    });
    beforeEach(() => {
      if (mode !== 'constrained') return;
      const spawn = shellUtils.spawnAsync;
      vi.spyOn(shellUtils, 'spawnAsync').mockImplementation(
        (executable, args, options) => {
          const index = args.indexOf('-EncodedCommand');
          if (/powershell\.exe$/i.test(executable) && index >= 0) {
            const script = Buffer.from(args[index + 1]!, 'base64').toString(
              'utf16le',
            );
            const constrained =
              "if ($ExecutionContext.SessionState.LanguageMode -ne 'ConstrainedLanguage') { $ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage' }; " +
              "if ($ExecutionContext.SessionState.LanguageMode -ne 'ConstrainedLanguage') { throw 'ConstrainedLanguage was not enabled' }; " +
              script;
            args = [...args];
            args[index + 1] = Buffer.from(constrained, 'utf16le').toString(
              'base64',
            );
          }
          // Execute the real helper, with the same cmdlets and OS processes as production.
          return spawn(executable, args, options);
        },
      );
    });
    afterEach(() => vi.restoreAllMocks());
    it('treats an already exited PID as a successful no-op', async () => {
      // Exit through stdin EOF, without sending any termination signal.
      const child = spawn(
        process.execPath,
        [
          '-e',
          'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))',
        ],
        {
          stdio: ['pipe', 'ignore', 'ignore'],
          windowsHide: true,
        },
      );
      const exited = once(child, 'exit');
      try {
        const identity = (await readWindowsProcessSnapshot()).find(
          (entry) => entry.pid === child.pid,
        );
        expect(identity).toBeDefined();
        child.stdin!.end();
        await exited;
        await expect(
          terminateWindowsProcesses([identity!]),
        ).resolves.toBeUndefined();
      } finally {
        child.stdin!.end();
        await exited;
      }
    }, 180000);
    it.each(cases)(
      'reclaims $name and preserves a concurrent task',
      async ({ script, targets = 1 }) => {
        let output = '';
        let unrelatedOutput = '';
        const unrelated = await exec(
          sleepScript,
          new AbortController().signal,
          'bash',
          {
            preventCwdChanges: true,
            onStdout: (chunk) => {
              unrelatedOutput += chunk;
            },
          },
        );
        const command = await exec(
          script,
          new AbortController().signal,
          'bash',
          {
            preventCwdChanges: true,
            onStdout: (chunk) => {
              output += chunk;
            },
          },
        );
        void command.result.catch(() => {});
        void unrelated.result.catch(() => {});
        let target = 0;
        let other = 0;
        let owned: WindowsProcessIdentity[] = [];
        try {
          await waitUntil(
            () =>
              [...output.matchAll(/TARGET=\d+/g)].length >= targets &&
              /TARGET=\d+/.test(unrelatedOutput),
          );
          target = Number(/TARGET=(\d+)/.exec(output)![1]);
          other = Number(/TARGET=(\d+)/.exec(unrelatedOutput)![1]);
          owned = selectWindowsDescendants(await readWindowsProcessSnapshot(), [
            command.pid!,
            unrelated.pid!,
            target,
            other,
          ]);
          expect(gone(target)).toBe(false);
          command.background('windows-stop-probe');
          const stopping = command.kill();
          await Promise.all([stopping, command.kill()]);
          expect((await command.result).interrupted).toBe(true);
          expect(gone(target)).toBe(true);
          expect(gone(command.pid!)).toBe(true);
          expect(gone(other)).toBe(false);
          // Include every observed leaf and native descendant, not just the
          // first TARGET line, and check again after the stop has returned.
          await delay(3000);
          const remaining = await readWindowsProcessSnapshot();
          const ownPids = new Set([
            command.pid!,
            ...[...output.matchAll(/TARGET=(\d+)/g)].map((match) =>
              Number(match[1]),
            ),
          ]);
          const ownIdentities = selectWindowsDescendants(owned, [...ownPids]);
          expect(
            remaining.filter((p) =>
              ownIdentities.some(
                (entry) => entry.pid === p.pid && entry.created === p.created,
              ),
            ),
          ).toEqual([]);
          for (const pid of ownPids) expect(gone(pid)).toBe(true);
          expect(gone(other)).toBe(false);
        } finally {
          await Promise.allSettled([command.kill(), unrelated.kill()]);
          // Match creation times too: a recycled test PID is not ours to kill.
          await terminateWindowsProcesses(owned).catch(() => {});
          command.cleanup();
          unrelated.cleanup();
        }
      },
      360000,
    );
  },
);
