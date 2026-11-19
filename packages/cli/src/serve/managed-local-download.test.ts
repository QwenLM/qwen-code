/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installManagedLocalRuntime } from './managed-local-download.js';

vi.mock('../utils/stdioHelpers.js', () => ({ writeStderrLine: vi.fn() }));

describe('Managed server first-use download', () => {
  const version = '0.25.4-preview.1';
  const target = 'darwin-arm64';
  const name = `qwen-managed-agent-server-${version}.jar`;
  const jar = Buffer.concat([
    Buffer.from('504b0304', 'hex'),
    Buffer.from('server fixture'),
  ]);
  const digest = createHash('sha256').update(jar).digest('hex');
  let root: string;
  let directory: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const response = (url: string) =>
    url.endsWith('.sha256')
      ? new Response(`${digest}  ${name}\n`)
      : new Response(jar);

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'managed-download-'));
    directory = path.join(root, version, target);
    fetchMock = vi.fn<typeof fetch>(async (url) => response(String(url)));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  const install = () => installManagedLocalRuntime(version, target, directory);

  it('downloads the exact CLI version once, checks it, and installs a system-Java payload', async () => {
    await install();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/v${version}/${name}.sha256`,
      `https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/v${version}/${name}`,
    ]);
    expect(await readFile(path.join(directory, 'server.jar'))).toEqual(jar);
    expect(
      JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')),
    ).toEqual({
      schemaVersion: 1,
      cliVersion: version,
      target,
      javaMajor: 21,
      javaSource: 'system',
      serverSha256: digest,
    });
    expect((await readdir(directory)).sort()).toEqual([
      'manifest.json',
      'server.jar',
    ]);
    if (process.platform !== 'win32') {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect(
        (await lstat(path.join(directory, 'server.jar'))).mode & 0o777,
      ).toBe(0o600);
    }
    fetchMock.mockRejectedValue(new Error('offline'));
    await install();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the same version on GitHub when the OSS release is unavailable', async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).includes('aliyuncs.com')
        ? new Response('', { status: 404 })
        : response(String(url)),
    );
    await install();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/v${version}/${name}.sha256`,
      `https://github.com/QwenLM/qwen-code/releases/download/v${version}/${name}.sha256`,
      `https://github.com/QwenLM/qwen-code/releases/download/v${version}/${name}`,
    ]);
    expect(await readFile(path.join(directory, 'server.jar'))).toEqual(jar);
  });

  it('discards a corrupt mirror download before installing a verified fallback', async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).includes('aliyuncs.com') && !String(url).endsWith('.sha256')
        ? new Response('corrupt')
        : response(String(url)),
    );
    await install();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(await readFile(path.join(directory, 'server.jar'))).toEqual(jar);
    expect(await readdir(path.dirname(directory))).toEqual([target]);
  });

  it('serializes simultaneous installations and reuses the winner without downloading again', async () => {
    await Promise.all([install(), install()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(directory, 'server.jar'))).toEqual(jar);
  }, 10_000);

  it('cleans abandoned staging directories and safely retries a failed installation', async () => {
    await mkdir(
      path.join(path.dirname(directory), `.${target}-download-abandoned`),
      { recursive: true },
    );
    fetchMock.mockRejectedValue(new Error('connection interrupted'));
    await expect(install()).rejects.toThrow(`CLI ${version}, ${target}`);
    expect(await readdir(path.dirname(directory))).toEqual([]);
    fetchMock.mockImplementation(async (url) => response(String(url)));
    await install();
    expect(await readFile(path.join(directory, 'server.jar'))).toEqual(jar);
  });

  it('does not replace an existing payload even if it is incomplete', async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'server.jar'),
      'existing damaged payload',
    );
    await install();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(path.join(directory, 'server.jar'), 'utf8')).toBe(
      'existing damaged payload',
    );
  });

  it.each([
    'mismatch',
    'wrong-name',
    'oversized-checksum',
    'wrong-jar',
    'oversized-jar',
    'broken-stream',
  ])('refuses %s without publishing any partial runtime', async (failure) => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith('.sha256')) {
        if (failure === 'mismatch')
          return new Response(`${'0'.repeat(64)}  ${name}\n`);
        if (failure === 'wrong-name')
          return new Response(`${digest}  another.jar\n`);
        if (failure === 'oversized-checksum')
          return new Response('x'.repeat(1025));
        if (failure === 'wrong-jar')
          return new Response(
            `${createHash('sha256').update('not a jar').digest('hex')}  ${name}\n`,
          );
        return response(String(url));
      }
      if (failure === 'wrong-jar') return new Response('not a jar');
      if (failure === 'oversized-jar')
        return new Response(jar, {
          headers: { 'content-length': String(256 * 1024 * 1024 + 1) },
        });
      if (failure === 'broken-stream')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('truncated body'));
            },
          }),
        );
      return new Response(jar);
    });
    await expect(install()).rejects.toThrow(
      'Could not install Managed runtime',
    );
    expect(await readdir(path.dirname(directory))).toEqual([]);
  });

  it('bounds both mirror attempts and cleans up when the download times out', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockImplementation(async (_url, options) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.headers).toEqual({
        'User-Agent': `qwen-code/${version}`,
      });
      throw new DOMException('fixture timeout', 'TimeoutError');
    });
    await expect(install()).rejects.toThrow('fixture timeout');
    expect(timeout.mock.calls).toEqual([[300_000], [300_000]]);
    expect(await readdir(path.dirname(directory))).toEqual([]);
  });

  it.each(['../escape', 'latest', 'v0.25.3', '0.25.3/escape'])(
    'refuses unsafe or unversioned release %s before filesystem or network changes',
    async (invalid) => {
      await expect(
        installManagedLocalRuntime(invalid, target, directory),
      ).rejects.toThrow('release version');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    },
  );
});
