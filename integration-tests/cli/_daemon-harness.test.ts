/**
 * Regression coverage for the shared daemon descendant harness.
 *
 * The ACP child matcher must not depend on the repository checkout path.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import { countDescendants } from './_daemon-harness.js';

const describePOSIX = process.platform === 'win32' ? describe.skip : describe;

describePOSIX('_daemon-harness descendant counting', () => {
  it('matches only the exact --acp child when the entry path contains no qwen', async () => {
    const childScript = `
      const { spawn } = require('node:child_process');

      const roles = process.argv.slice(1);
      const children = roles.map((role) =>
        spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 10000)', '--' + role],
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

      setInterval(() => {}, 10000);
    `;

    const parent = spawn(
      process.execPath,
      ['-e', childScript, 'acp', 'acp-foo', 'experimental-acp'],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );

    try {
      if (parent.pid === undefined || parent.stdout === null) {
        throw new Error('test parent process did not start correctly');
      }

      const readyLine = await new Promise<string>((resolve, reject) => {
        let buffer = '';

        const onData = (chunk: Buffer) => {
          buffer += chunk.toString();
          const newline = buffer.indexOf('\n');

          if (newline !== -1) {
            parent.stdout?.off('data', onData);
            resolve(buffer.slice(0, newline));
          }
        };

        parent.stdout.on('data', onData);
        parent.once('error', reject);
      });

      const { pids } = JSON.parse(readyLine) as {
        pids: Array<number | undefined>;
      };

      const [acpPid, acpFooPid, experimentalAcpPid] = pids;

      if (
        acpPid === undefined ||
        acpFooPid === undefined ||
        experimentalAcpPid === undefined
      ) {
        throw new Error('test child processes did not expose PIDs');
      }

      // Give the child processes a moment to become visible to pgrep.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const { acpChildren } = countDescendants(parent.pid);

      expect([...acpChildren].sort((a, b) => a - b)).toEqual([acpPid]);

      expect(acpChildren).not.toContain(acpFooPid);
      expect(acpChildren).not.toContain(experimentalAcpPid);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        parent.kill('SIGTERM');
        await once(parent, 'exit');
      }
    }
  });
});
