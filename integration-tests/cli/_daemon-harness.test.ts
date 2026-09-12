/**
 * Regression coverage for the shared daemon descendant harness.
 *
 * The ACP child matcher must not depend on the repository checkout path.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, onTestFinished } from 'vitest';

import { countDescendants } from './_daemon-harness.js';

const describePOSIX = process.platform === 'win32' ? describe.skip : describe;

describePOSIX('_daemon-harness descendant counting', () => {
  it('matches only the exact --acp child when the entry path contains no qwen', async () => {
    const childPids: number[] = [];

    const childScript = `
      const { spawn } = require('node:child_process');

      const childArgs = JSON.parse(process.argv[1]);
      const children = childArgs.map((args) =>
        spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 10000)', '--', ...args],
          {
            stdio: 'ignore',
            detached: false,
          },
        ),
      );

      console.log(
        JSON.stringify({
          pids: children.map((child) => child.pid),
        }),
      );

      process.on('SIGTERM', () => {
        for (const child of children) {
          child.kill('SIGTERM');
        }
        setTimeout(() => process.exit(0), 100);
      });

      setTimeout(() => process.exit(0), 60000);
      setInterval(() => {}, 10000);
    `;

    const parent = spawn(
      process.execPath,
      [
        '-e',
        childScript,
        '--',
        JSON.stringify([
          ['--acp'],
          ['--acp', '--extra-flag'],
          ['--acp-foo'],
          ['--experimental-acp'],
        ]),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const cleanup = () => {
      for (const pid of childPids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // The child may have already exited.
        }
      }

      if (parent.exitCode === null && parent.signalCode === null) {
        parent.kill('SIGTERM');
      }
    };

    onTestFinished(cleanup);

    try {
      if (parent.pid === undefined || parent.stdout === null) {
        throw new Error('test parent process did not start correctly');
      }

      let stderr = '';

      parent.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const readyLine = await new Promise<string>((resolve, reject) => {
        let buffer = '';

        const timer = setTimeout(() => {
          reject(
            new Error(
              `timed out waiting for fixture PIDs${stderr ? `: ${stderr}` : ''}`,
            ),
          );
        }, 5000);

        const cleanupReadyWait = () => {
          clearTimeout(timer);
          parent.stdout?.off('data', onData);
          parent.off('error', onError);
          parent.off('exit', onExit);
        };

        const onData = (chunk: Buffer) => {
          buffer += chunk.toString();
          const newline = buffer.indexOf('\n');

          if (newline !== -1) {
            cleanupReadyWait();
            resolve(buffer.slice(0, newline));
          }
        };

        const onError = (error: Error) => {
          cleanupReadyWait();
          reject(error);
        };

        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanupReadyWait();
          reject(
            new Error(
              `harness parent exited (code=${code} signal=${signal}) before printing PIDs${
                stderr ? `: ${stderr}` : ''
              }`,
            ),
          );
        };

        parent.stdout.on('data', onData);
        parent.once('error', onError);
        parent.once('exit', onExit);
      });

      const { pids } = JSON.parse(readyLine) as {
        pids: Array<number | undefined>;
      };

      const [acpPid, acpWithArgsPid, acpFooPid, experimentalAcpPid] = pids;

      if (
        acpPid === undefined ||
        acpWithArgsPid === undefined ||
        acpFooPid === undefined ||
        experimentalAcpPid === undefined
      ) {
        throw new Error('test child processes did not expose PIDs');
      }

      childPids.push(acpPid, acpWithArgsPid, acpFooPid, experimentalAcpPid);

      // Give the child processes a moment to become visible to pgrep.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const { acpChildren } = countDescendants(parent.pid);

      expect([...acpChildren].sort((a, b) => a - b)).toEqual(
        [acpPid, acpWithArgsPid].sort((a, b) => a - b),
      );

      expect(acpChildren).not.toContain(acpFooPid);
      expect(acpChildren).not.toContain(experimentalAcpPid);
    } finally {
      cleanup();

      if (parent.exitCode === null && parent.signalCode === null) {
        await once(parent, 'exit');
      }
    }
  });
});
