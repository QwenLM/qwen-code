/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export function inventory(root: string): Record<string, unknown> {
  if (!fs.existsSync(root)) return {};
  const rows: Record<string, unknown> = {};
  const visit = (file: string) => {
    const stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), file);
    const name = path.relative(root, file) || '.';
    rows[name] = stat.isDirectory()
      ? { type: 'dir', mode: stat.mode & 0o7777 }
      : {
          type: 'file',
          mode: stat.mode & 0o7777,
          bytes: stat.size,
          sha256: createHash('sha256')
            .update(fs.readFileSync(file))
            .digest('hex'),
        };
    if (stat.isDirectory())
      for (const child of fs.readdirSync(file).sort())
        visit(path.join(file, child));
  };
  visit(root);
  return rows;
}

export async function startExtensionGitFixture(root: string) {
  const git = fs.realpathSync(
    process.env['QWEN_E2E_GIT_BIN'] ?? '/usr/bin/git',
  );
  const seed = path.join(root, 'seed');
  const publisher = path.join(root, 'publisher');
  const gitHome = path.join(root, 'git-home');
  const gitTemp = path.join(root, 'git-tmp');
  for (const directory of [seed, publisher, gitHome, gitTemp])
    fs.mkdirSync(directory, { recursive: true });
  const env = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: gitHome,
    TMPDIR: gitTemp,
    TMP: gitTemp,
    TEMP: gitTemp,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'chiga0',
    GIT_AUTHOR_EMAIL: 'arno.ga0@outlook.com',
    GIT_COMMITTER_NAME: 'chiga0',
    GIT_COMMITTER_EMAIL: 'arno.ga0@outlook.com',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  };
  const prepare = (args: string[]) => {
    const result = spawnSync(git, ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: seed,
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const names = ['owned-partial-a', 'owned-partial-b'];
  const commands = names.map(
    (name) =>
      `---\ndescription: ${name} command\n---\nReply ${name.toUpperCase()}\n`,
  );
  const plugins = names.map((name, index) => ({
    name,
    description: `Owned partial ${index + 1}`,
    source: `./plugins/${name}`,
    commands: [`./commands/owned-${index ? 'b' : 'a'}-proof.md`],
  }));
  const write = (relative: string, value: unknown) => {
    const file = path.join(seed, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
    );
  };
  write('.claude-plugin/marketplace.json', {
    name: 'owned-partial-market',
    owner: { name: 'Owned fixture' },
    plugins,
  });
  names.forEach((name, index) => {
    write(`plugins/${name}/.claude-plugin/plugin.json`, {
      name,
      version: '1.0.0',
    });
    write(
      `plugins/${name}/commands/owned-${index ? 'b' : 'a'}-proof.md`,
      commands[index],
    );
  });
  prepare(['init', '--initial-branch=feat/owned-partial-fixture']);
  prepare(['add', '.']);
  prepare(['commit', '--no-gpg-sign', '-m', 'Owned command-only fixture']);
  const head = prepare(['rev-parse', 'HEAD']);
  prepare([
    'clone',
    '--bare',
    '--no-hardlinks',
    seed,
    path.join(publisher, 'repository.git'),
  ]);
  const seal = (file: string) => {
    if (fs.statSync(file).isDirectory()) {
      for (const child of fs.readdirSync(file)) seal(path.join(file, child));
      fs.chmodSync(file, 0o555);
    } else fs.chmodSync(file, 0o444);
  };
  seal(publisher);
  const baseline = inventory(publisher);
  const requests: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const children = new Set<ChildProcess>();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://127.0.0.1');
      const body: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        assert(bytes <= 8 * 1024 * 1024, 'bounded Git request');
        body.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(body);
      const observation: Record<string, unknown> = {
        method: req.method,
        url: req.url,
        bodyBase64: raw.toString('base64'),
      };
      requests.push(observation);
      assert.deepEqual(inventory(publisher), baseline);
      if (url.pathname === '/catalog.json' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(catalog));
        return;
      }
      assert(
        (url.pathname === '/repository.git/info/refs' &&
          req.method === 'GET' &&
          url.searchParams.get('service') === 'git-upload-pack') ||
          (url.pathname === '/repository.git/git-upload-pack' &&
            req.method === 'POST'),
        'only catalog and read-only smart Git routes',
      );
      const child = spawn(git, ['http-backend'], {
        env: {
          ...env,
          GIT_PROJECT_ROOT: publisher,
          GIT_HTTP_EXPORT_ALL: '1',
          REQUEST_METHOD: req.method!,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          CONTENT_LENGTH: String(raw.length),
          REMOTE_ADDR: '127.0.0.1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.add(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      const code = await new Promise<number | null>((resolve, reject) => {
        let failure: unknown;
        child.once('error', (error) => {
          failure ??= error;
        });
        child.stdin.once('error', (error) => {
          failure ??= error;
        });
        child.once('close', (code) => {
          if (failure) reject(failure);
          else resolve(code);
        });
        child.stdin.end(raw);
      }).finally(() => {
        clearTimeout(timer);
        children.delete(child);
      });
      observation['exitCode'] = code;
      observation['stderr'] = Buffer.concat(stderr).toString();
      assert.equal(code, 0, String(observation['stderr']));
      assert.deepEqual(inventory(publisher), baseline);
      const reply = Buffer.concat(stdout);
      observation['responseBase64'] = reply.toString('base64');
      const end = reply.indexOf('\r\n\r\n');
      assert(end >= 0, 'Git CGI header boundary');
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of reply.subarray(0, end).toString().split('\r\n')) {
        const colon = line.indexOf(':');
        assert(colon > 0);
        const name = line.slice(0, colon).toLowerCase();
        if (name === 'status')
          status = Number(
            line
              .slice(colon + 1)
              .trim()
              .split(' ')[0],
          );
        else headers[name] = line.slice(colon + 1).trim();
      }
      res.writeHead(status, headers);
      res.end(reply.subarray(end + 4));
    } catch (error) {
      errors.push(String(error));
      res.writeHead(500);
      res.end('Owned fixture failure');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const repository = `http://127.0.0.1:${address.port}/repository.git`;
  const catalogURL = `http://127.0.0.1:${address.port}/catalog.json`;
  const catalog: object = {
    name: 'owned-partial-market',
    owner: { name: 'Owned fixture' },
    plugins: plugins.map((plugin) => ({
      ...plugin,
      source: { source: 'url', url: `${repository}:${plugin.name}` },
    })),
  };
  return {
    git,
    names,
    commands,
    publisher,
    baseline,
    head,
    repository,
    catalogURL,
    requests,
    errors,
    guard: () => assert.deepEqual(inventory(publisher), baseline),
    close: async () => {
      for (const child of children) child.kill('SIGTERM');
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      assert.equal(children.size, 0, 'no owned Git CGI child remains');
      assert.deepEqual(inventory(publisher), baseline);
    },
  };
}
