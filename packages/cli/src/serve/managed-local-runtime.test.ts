/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveManagedLocalRuntime } from './managed-local-runtime.js';

vi.mock('../utils/version.js', () => ({ getCliVersion: async () => '0.25.3' }));

describe.skipIf(process.platform === 'win32')(
  'Managed local packaged runtime',
  () => {
    let directory: string;
    let manifest: Record<string, unknown>;
    beforeEach(async () => {
      directory = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'managed-local-runtime-')),
      );
      vi.stubEnv('QWEN_HOME', path.join(directory, 'home'));
      vi.stubEnv('QWEN_MANAGED_LOCAL_RUNTIME_DIR', undefined);
      vi.stubEnv('JAVA_HOME', undefined);
      const jar = Buffer.from('test server bytes');
      await mkdir(path.join(directory, 'jre', 'bin'), { recursive: true });
      await writeFile(path.join(directory, 'cli.js'), '');
      await writeFile(path.join(directory, 'server.jar'), jar);
      await writeFile(
        path.join(directory, 'jre', 'release'),
        'JAVA_VERSION="21.0.12"\n',
      );
      await writeFile(
        path.join(directory, 'jre', 'bin', 'java'),
        '#!/bin/sh\nexit 0\n',
      );
      await chmod(path.join(directory, 'jre', 'bin', 'java'), 0o755);
      manifest = {
        schemaVersion: 1,
        cliVersion: '0.25.3',
        target: `${process.platform}-${process.arch}`,
        javaMajor: 21,
        serverSha256: createHash('sha256').update(jar).digest('hex'),
      };
      await save();
    });
    afterEach(async () => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    });
    const save = () =>
      writeFile(
        path.join(directory, 'manifest.json'),
        JSON.stringify(manifest),
      );
    const resolve = () =>
      resolveManagedLocalRuntime(path.join(directory, 'cli.js'), directory);
    const install = async (destination: string) => {
      await mkdir(destination, { recursive: true });
      for (const file of ['manifest.json', 'server.jar', 'jre']) {
        await cp(path.join(directory, file), path.join(destination, file), {
          recursive: true,
        });
      }
      return destination;
    };
    const installHome = () =>
      install(
        path.join(
          directory,
          'home',
          'managed-runtime',
          '0.25.3',
          `${process.platform}-${process.arch}`,
        ),
      );
    const useSystemJava = async () => {
      manifest['javaSource'] = 'system';
      await save();
      await rm(path.join(directory, 'jre'), { recursive: true });
    };
    const createJava = async (name: string, major = '21') => {
      const home = path.join(directory, name);
      const executable = path.join(home, 'bin', 'java');
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s\\n' '    java.specification.version = ${major}' >&2\n`,
        { mode: 0o755 },
      );
      return { home, executable };
    };

    it('resolves the colocated Java binary instead of requiring Java on PATH', async () => {
      vi.stubEnv('PATH', path.join(directory, 'empty'));
      vi.stubEnv('JAVA_HOME', path.join(directory, 'missing'));
      expect(await resolve()).toEqual({
        java: path.join(directory, 'jre', 'bin', 'java'),
        serverJar: path.join(directory, 'server.jar'),
        cliEntry: path.join(directory, 'cli.js'),
      });
    });
    it('uses canonical JAVA_HOME Java for an explicitly lightweight payload', async () => {
      await useSystemJava();
      const selected = await createJava('java home');
      const link = path.join(directory, 'linked-java-home');
      await symlink(selected.home, link);
      vi.stubEnv('JAVA_HOME', link);
      vi.stubEnv('PATH', path.join(directory, 'empty'));
      expect((await resolve()).java).toBe(selected.executable);
    });
    it('uses the first executable Java on PATH when JAVA_HOME is unset', async () => {
      await useSystemJava();
      const disabled = await createJava('not-executable', '17');
      await chmod(disabled.executable, 0o644);
      const selected = await createJava('path-java');
      vi.stubEnv(
        'PATH',
        [
          path.dirname(disabled.executable),
          path.dirname(selected.executable),
        ].join(path.delimiter),
      );
      expect((await resolve()).java).toBe(selected.executable);
    });
    it.each(['missing', '17', '25', '21.0.12', 'malformed'])(
      'refuses %s JAVA_HOME without trying a valid Java on PATH',
      async (major) => {
        await useSystemJava();
        const alternative = await createJava('valid-path-java');
        const selected =
          major === 'missing'
            ? { home: path.join(directory, 'missing') }
            : await createJava('selected-java', major);
        vi.stubEnv('JAVA_HOME', selected.home);
        vi.stubEnv('PATH', path.dirname(alternative.executable));
        await expect(resolve()).rejects.toThrow('requires local Java 21');
      },
    );
    it('refuses the first wrong Java on PATH rather than finding another version', async () => {
      await useSystemJava();
      const first = await createJava('first', '17');
      const second = await createJava('second');
      vi.stubEnv(
        'PATH',
        [path.dirname(first.executable), path.dirname(second.executable)].join(
          path.delimiter,
        ),
      );
      await expect(resolve()).rejects.toThrow('requires local Java 21');
    });
    it('provides a local-Java installation hint when PATH has no Java', async () => {
      await useSystemJava();
      vi.stubEnv('PATH', path.join(directory, 'empty'));
      await expect(resolve()).rejects.toThrow(
        'No executable java found on PATH',
      );
    });
    it('bounds the version probe and refuses a Java executable that hangs', async () => {
      await useSystemJava();
      const selected = await createJava('hanging-java');
      await writeFile(selected.executable, '#!/bin/sh\nexec /bin/sleep 30\n');
      vi.stubEnv('JAVA_HOME', selected.home);
      await expect(resolve()).rejects.toThrow('Could not verify Java 21');
    }, 15_000);
    it.each([undefined, 'bundled'])(
      'does not use local Java for an incomplete bundled payload (%s)',
      async (source) => {
        if (source) manifest['javaSource'] = source;
        await save();
        await rm(path.join(directory, 'jre'), { recursive: true });
        const alternative = await createJava('system-java');
        vi.stubEnv('JAVA_HOME', alternative.home);
        await expect(resolve()).rejects.toThrow('verification failed');
      },
    );
    it('refuses an unknown Java source', async () => {
      manifest['javaSource'] = 'auto';
      await save();
      await expect(resolve()).rejects.toThrow('must match CLI');
    });
    it.each(['cliVersion', 'target', 'javaMajor'])(
      'refuses mismatched %s',
      async (field) => {
        manifest[field] = 'wrong';
        await save();
        await expect(resolve()).rejects.toThrow('must match CLI');
      },
    );
    it('refuses a modified server or wrong Java runtime before spawn', async () => {
      await writeFile(path.join(directory, 'server.jar'), 'changed');
      await expect(resolve()).rejects.toThrow('checksum mismatch');
      manifest['serverSha256'] = createHash('sha256')
        .update('changed')
        .digest('hex');
      await save();
      await writeFile(
        path.join(directory, 'jre', 'release'),
        'JAVA_VERSION="17.0.1"\n',
      );
      await expect(resolve()).rejects.toThrow('not Java 21');
    });
    it('provides an actionable missing-payload error', async () => {
      await rm(path.join(directory, 'manifest.json'));
      await expect(resolve()).rejects.toThrow('Managed local distribution');
    });
    it('discovers an exact version and platform runtime in Qwen home', async () => {
      const installed = await installHome();
      const runtime = await resolveManagedLocalRuntime(
        path.join(directory, 'cli.js'),
      );
      expect(runtime).toEqual({
        java: path.join(installed, 'jre', 'bin', 'java'),
        serverJar: path.join(installed, 'server.jar'),
        cliEntry: path.join(directory, 'cli.js'),
      });
    });
    it('keeps a colocated payload authoritative even when it becomes invalid', async () => {
      await installHome();
      const colocated = await install(path.join(directory, 'managed-runtime'));
      const entry = path.join(directory, 'cli.js');
      expect((await resolveManagedLocalRuntime(entry)).serverJar).toBe(
        path.join(colocated, 'server.jar'),
      );
      await rm(path.join(colocated, 'manifest.json'));
      await expect(resolveManagedLocalRuntime(entry)).rejects.toThrow(
        `invalid at ${colocated}`,
      );
    });
    it('does not replace an explicitly selected missing runtime with an installed one', async () => {
      await installHome();
      await install(path.join(directory, 'managed-runtime'));
      const selected = path.join(directory, 'missing');
      vi.stubEnv('QWEN_MANAGED_LOCAL_RUNTIME_DIR', selected);
      await expect(
        resolveManagedLocalRuntime(path.join(directory, 'cli.js')),
      ).rejects.toThrow(`invalid at ${selected}`);
    });
    it('requires local Java before downloading a missing default runtime', async () => {
      vi.stubEnv('PATH', path.join(directory, 'empty'));
      const download = vi.fn();
      vi.stubGlobal('fetch', download);
      await expect(
        resolveManagedLocalRuntime(path.join(directory, 'cli.js')),
      ).rejects.toThrow('requires local Java 21');
      expect(download).not.toHaveBeenCalled();
    });
    it('downloads a missing default runtime and then uses it offline without replacing corrupt cache contents', async () => {
      const selected = await createJava('local-java');
      vi.stubEnv('JAVA_HOME', selected.home);
      const jar = Buffer.from('504b030401020304', 'hex');
      const digest = createHash('sha256').update(jar).digest('hex');
      const download = vi.fn(
        async (url: string) =>
          new Response(
            url.endsWith('.sha256')
              ? `${digest}  qwen-managed-agent-server-0.25.3.jar\n`
              : jar,
          ),
      );
      vi.stubGlobal('fetch', download);
      const entry = path.join(directory, 'cli.js');
      const runtime = await resolveManagedLocalRuntime(entry);
      expect(runtime.java).toBe(selected.executable);
      expect(runtime.serverJar).toBe(
        path.join(
          directory,
          'home',
          'managed-runtime',
          '0.25.3',
          `${process.platform}-${process.arch}`,
          'server.jar',
        ),
      );
      expect(download).toHaveBeenCalledTimes(2);
      download.mockRejectedValue(new Error('offline'));
      expect(await resolveManagedLocalRuntime(entry)).toEqual(runtime);
      await writeFile(runtime.serverJar, 'corrupt cached server');
      await expect(resolveManagedLocalRuntime(entry)).rejects.toThrow(
        'checksum mismatch',
      );
      expect(download).toHaveBeenCalledTimes(2);
    });
    it.each([
      { ...process.versions, node: '21.7.3' },
      { ...process.versions, bun: '1.2.3' },
    ])(
      'refuses an unsupported JavaScript runtime before loading the payload',
      async (versions) => {
        vi.stubGlobal('process', { ...process, versions });
        await expect(resolve()).rejects.toThrow('requires Node.js 22 or newer');
      },
    );
  },
);
