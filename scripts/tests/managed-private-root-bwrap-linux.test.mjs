/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { executePrivateRootBwrap } from '../../packages/core/dist/src/sandbox/private-root-bwrap.js';

const busybox = '/bin/busybox';

const shell = (script, ...args) => ({
  executable: busybox,
  args: ['sh', '-ceu', script, 'sh', ...args],
});

const confirmed = (result, exitCode = 0) =>
  assert.deepEqual(
    result.sandboxStatus,
    { state: 'confirmed', exitCode },
    result.output,
  );

test(
  'Managed private-root Bubblewrap on non-root Linux',
  { timeout: 30_000 },
  async (t) => {
    assert.equal(process.platform, 'linux');
    assert.notEqual(process.getuid(), 0);
    t.diagnostic(
      execFileSync('/usr/bin/bwrap', ['--version'], {
        encoding: 'utf8',
      }).trim(),
    );

    const root = await mkdtemp('/tmp/qwen-private-root-');
    t.after(() => rm(root, { recursive: true, force: true }));
    const [rootfs, installation, state, first, second] = [
      'image',
      'installation',
      'state',
      'first',
      'second',
    ].map((name) => path.join(root, name));
    await Promise.all(
      [rootfs, installation, state, first, second].map((dir) => mkdir(dir)),
    );
    await Promise.all(
      ['bin', 'workspace', 'tmp', 'dev'].map((name) =>
        mkdir(path.join(rootfs, name)),
      ),
    );
    await copyFile(busybox, path.join(rootfs, busybox));
    const hostFile = path.join(root, 'host-marker');
    await writeFile(hostFile, 'host');
    for (const workspace of [first, second]) {
      await writeFile(path.join(workspace, 'marker'), path.basename(workspace));
    }

    const policy = {
      rootfs,
      installation,
      state,
      filesystem: 'workspace-write',
      workspace: first,
    };
    const launch = (
      command,
      overrides = {},
      signal = AbortSignal.timeout(5000),
    ) =>
      executePrivateRootBwrap(
        { ...policy, ...overrides },
        command,
        () => {},
        signal,
      );
    const run = async (command, overrides) =>
      (await launch(command, overrides)).result;

    if (process.env['QWEN_TEST_BWRAP_SETUP_REFUSAL'] === '1') {
      const marker = path.join(first, 'setup-marker');
      const command = shell('printf started > "$1"', marker);
      execFileSync(command.executable, command.args, { timeout: 3000 });
      assert.equal(await readFile(marker, 'utf8'), 'started');
      await rm(marker);

      const result = await run(
        shell(
          '(printf started > "$1") 2>/dev/null || true; printf started > setup-marker',
          marker,
        ),
      );
      assert.equal(result.sandboxStatus.state, 'unconfirmed');
      assert.match(
        result.output,
        /bwrap:.*(?:namespace|operation not permitted|read-only file system)/i,
      );
      assert.equal(existsSync(marker), false);
      t.diagnostic(result.output.trim());
      return;
    }

    await t.test(
      'confines reads and writes in both Workspace directions',
      async () => {
        for (const [workspace, sibling] of [
          [first, second],
          [second, first],
        ]) {
          const siblingFile = path.join(sibling, 'marker');
          const absLink = path.join(workspace, 'absolute-link');
          const relLink = path.join(workspace, 'relative-link');
          await symlink(siblingFile, absLink);
          await symlink(path.relative(workspace, siblingFile), relLink);
          for (const link of [absLink, relLink]) {
            assert.equal(await readFile(link, 'utf8'), path.basename(sibling));
          }
          const result = await run(
            shell(
              `
        [ "$PWD" = /workspace ] && [ "$(pwd)" = /workspace ] || exit 10
        /bin/busybox cat marker
        printf written > result
        for target do
          if /bin/busybox cat "$target" 2>/dev/null; then exit 11; fi
          if (printf changed > "$target") 2>/dev/null; then exit 12; fi
        done
      `,
              hostFile,
              siblingFile,
              'absolute-link',
              'relative-link',
              '/image-write',
            ),
            { workspace },
          );
          confirmed(result);
          assert.equal(result.output, path.basename(workspace));
          assert.equal(
            await readFile(path.join(workspace, 'result'), 'utf8'),
            'written',
          );
          assert.equal(
            await readFile(siblingFile, 'utf8'),
            path.basename(sibling),
          );
          assert.equal(await readFile(hostFile, 'utf8'), 'host');
          assert.equal(existsSync(path.join(rootfs, 'image-write')), false);
        }
      },
    );

    await t.test(
      'protects input, environment, mount mode and the status descriptor',
      async () => {
        const key = 'QWEN_TEST_PRIVATE_ROOT_PARENT';
        const previous = process.env[key];
        process.env[key] = 'parent-value';
        t.after(() => {
          if (previous === undefined) delete process.env[key];
          else process.env[key] = previous;
        });
        assert.equal(
          execFileSync(
            busybox,
            ['sh', '-c', 'printf "%s" "$QWEN_TEST_PRIVATE_ROOT_PARENT"'],
            { encoding: 'utf8' },
          ),
          'parent-value',
        );

        const result = await run(
          {
            ...shell(`
        /bin/busybox cat marker
        if (printf changed > marker) 2>/dev/null; then exit 20; fi
        if (printf forged >&3) 2>/dev/null; then exit 21; fi
        [ ! -e /proc ] && [ -z "\${QWEN_TEST_PRIVATE_ROOT_PARENT+x}" ] || exit 22
        [ "$HOME:$TMPDIR:$TMP:$TEMP" = /tmp:/tmp:/tmp:/tmp ] || exit 23
        [ "$PATH:$LANG" = /usr/bin:/bin:C ] || exit 25
        /bin/busybox cat > /tmp/input
        /bin/busybox cat /tmp/input
      `),
            stdin: Buffer.from('stdin-bytes'),
          },
          { filesystem: 'read-only' },
        );
        confirmed(result);
        assert.equal(result.output, 'firststdin-bytes');
        assert.equal(
          await readFile(path.join(first, 'marker'), 'utf8'),
          'first',
        );

        const nonzero = await run(
          shell(`
      [ ! -e /tmp/input ] || exit 24
      printf '%s' '{"exit-code":0}'
      exit 29
    `),
        );
        confirmed(nonzero, 29);
        assert.equal(nonzero.output, '{"exit-code":0}');
      },
    );

    await t.test(
      'isolates network and PIDs and refuses nested user namespaces',
      async () => {
        const outer = spawn(busybox, ['sleep', '30'], { stdio: 'ignore' });
        const exited = once(outer, 'exit');
        t.after(async () => {
          outer.kill();
          await exited;
        });
        await once(outer, 'spawn');
        assert.ok(outer.pid > 2);
        process.kill(outer.pid, 0);
        execFileSync(busybox, ['unshare', '-U', busybox, 'true'], {
          timeout: 3000,
        });

        let connections = 0;
        const server = createServer((socket) => {
          connections++;
          socket.end('outer-loopback');
        });
        t.after(() => server.close());
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const port = String(server.address().port);
        const client = ['nc', '-w', '1', '127.0.0.1', port];
        const connection = spawn(busybox, client, {
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        t.after(() => connection.kill());
        const closed = once(connection, 'close');
        let output = '';
        for await (const chunk of connection.stdout) output += chunk;
        assert.deepEqual(await closed, [0, null]);
        assert.equal(output, 'outer-loopback');
        assert.equal(connections, 1);
        const result = await run(
          shell(
            `
      if kill -0 "$1" 2>/dev/null; then exit 30; fi
      if /bin/busybox nc -w 1 127.0.0.1 "$2" </dev/null 2>/dev/null; then exit 31; fi
      if /bin/busybox unshare -U /bin/busybox true 2>/dev/null; then exit 32; fi
    `,
            String(outer.pid),
            port,
          ),
        );
        confirmed(result);
        process.kill(outer.pid, 0);
        assert.equal(connections, 1);
      },
    );

    await t.test(
      'cancels a started payload without background promotion',
      { timeout: 10_000 },
      async () => {
        const stop = new AbortController();
        const startupDeadline = AbortSignal.timeout(5000);
        const handle = await launch(
          shell('printf started > running; exec /bin/busybox sleep 60'),
          {},
          AbortSignal.any([stop.signal, startupDeadline]),
        );
        const marker = path.join(first, 'running');
        while (!existsSync(marker))
          await delay(15, undefined, { signal: startupDeadline });
        assert.equal(await readFile(marker, 'utf8'), 'started');
        stop.abort({ kind: 'background' });
        const result = await handle.result;
        assert.equal(result.aborted, true);
        assert.notEqual(result.promoted, true);
        assert.deepEqual(result.sandboxStatus, { state: 'interrupted' });
      },
    );

    await t.test(
      'refuses a missing launcher and never uses a missing image executable on the host',
      async () => {
        const marker = path.join(first, 'host-fallback');
        const command = {
          executable: '/bin/sh',
          args: ['-c', 'printf fallback > "$1"', 'sh', marker],
        };
        execFileSync(command.executable, command.args, { timeout: 3000 });
        assert.equal(await readFile(marker, 'utf8'), 'fallback');
        await rm(marker);
        await assert.rejects(
          launch(command, { bwrapPath: path.join(installation, 'missing') }),
          { code: 'ENOENT' },
        );
        const result = await run(command);
        assert.deepEqual(result.sandboxStatus, {
          state: 'unconfirmed',
          payloadExitObserved: false,
        });
        assert.equal(existsSync(marker), false);
      },
    );

    await t.test(
      'rejects overlapping sources and unsafe image and launcher shapes',
      async () => {
        const command = shell('exit 0');
        const alias = path.join(root, 'image-alias');
        await symlink(rootfs, alias);
        for (const filesystem of ['read-only', 'workspace-write']) {
          for (const workspace of [rootfs, alias, state]) {
            await assert.rejects(
              launch(command, { workspace, filesystem }),
              /overlaps/,
            );
          }
        }
        await assert.rejects(launch(command, { rootfs: state }), /overlaps/);
        await assert.rejects(launch(command, { rootfs: 'image' }), /absolute/);

        const flagged = path.join(installation, 'setuid-launcher');
        await writeFile(flagged, '');
        await chmod(flagged, 0o4755);
        await assert.rejects(
          launch(command, { bwrapPath: flagged }),
          /non-setuid/,
        );

        await writeFile(path.join(rootfs, 'tmp', 'populated'), '');
        await assert.rejects(launch(command), /empty directories/);
        await rm(path.join(rootfs, 'tmp'), { recursive: true });
        await symlink(first, path.join(rootfs, 'tmp'));
        await assert.rejects(launch(command), /empty directories/);
      },
    );
  },
);
