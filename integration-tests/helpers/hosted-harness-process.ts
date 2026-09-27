/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const HOSTED_TOKEN = 'hosted-process-fixture-token';
export const HOSTED_DIGEST = `sha256:${'a'.repeat(64)}`;
export const HOSTED_CLI = path.resolve(
  import.meta.dirname,
  '../../dist/cli.js',
);

export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeout = 30_000,
) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error(`Timed out after ${timeout}ms`);
    await delay(30);
  }
}

export class HostedHarnessProcess {
  root = '';
  baseUrl = '';
  bootId = '';
  output = '';
  child?: ChildProcess;
  private exited?: Promise<void>;
  private spawnError?: Error;

  async start(
    modelUrl: string,
    options: {
      hostname?: string;
      startupTimeout?: number;
      args?: string[];
    } = {},
  ) {
    await access(HOSTED_CLI).catch(() => {
      throw new Error(
        'Missing packaged CLI: run npm run build && npm run bundle',
      );
    });
    this.root = await mkdtemp(path.join(tmpdir(), 'hosted-no-tool-'));
    try {
      const config = path.join(this.root, '.qwen');
      await mkdir(config);
      await writeFile(
        path.join(config, 'settings.json'),
        JSON.stringify({
          security: { auth: { selectedType: 'openai' } },
          model: { name: 'hosted-fixture' },
          telemetry: { enabled: false },
          modelProviders: {
            openai: [
              {
                id: 'hosted-fixture',
                envKey: 'OPENAI_API_KEY',
                baseUrl: modelUrl,
              },
            ],
          },
        }),
      );
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (
          /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TMP|TEMP|TMPDIR)$/i.test(
            key,
          )
        )
          env[key] = value;
      }
      this.child = spawn(
        process.execPath,
        options.args ?? [
          HOSTED_CLI,
          'serve',
          '--profile',
          'hosted-harness',
          '--http-bridge',
          '--no-web',
          '--hostname',
          options.hostname ?? '127.0.0.1',
          '--port',
          '0',
          '--token',
          HOSTED_TOKEN,
          '--hosted-harness-capability-digest',
          HOSTED_DIGEST,
          '--workspace',
          this.root,
        ],
        {
          cwd: this.root,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...env,
            HOME: this.root,
            USERPROFILE: this.root,
            QWEN_HOME: config,
            QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(
              this.root,
              'system-settings.json',
            ),
            QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(
              this.root,
              'system-defaults.json',
            ),
            QWEN_RUNTIME_DIR: path.join(this.root, 'runtime'),
            OPENAI_API_KEY: 'local-fixture-key',
            OPENAI_BASE_URL: modelUrl,
            OPENAI_MODEL: 'hosted-fixture',
            QWEN_MODEL: 'hosted-fixture',
            QWEN_SANDBOX: 'false',
            NO_COLOR: '1',
          },
        },
      );
      const append = (data: Buffer) => {
        this.output = (this.output + data.toString()).slice(-16_384);
      };
      this.child.stdout!.on('data', append);
      this.child.stderr!.on('data', append);
      this.exited = new Promise<void>((resolve) => {
        this.child!.once('error', (error) => {
          this.spawnError = error;
          resolve();
        });
        this.child!.once('close', () => resolve());
      });
      await waitUntil(() => {
        if (this.spawnError) throw this.spawnError;
        if (this.child!.exitCode !== null || this.child!.signalCode !== null)
          throw new Error(`Hosted CLI exited: ${this.output}`);
        const match = this.output.match(
          /qwen serve listening on (http:\/\/127\.0\.0\.1:\d+)/,
        );
        if (match) this.baseUrl = match[1];
        return !!match;
      }, options.startupTimeout);
      await waitUntil(async () => {
        const capabilities = await this.request('/capabilities');
        const text = await capabilities.text();
        if (capabilities.status === 503) return false;
        if (!capabilities.ok)
          throw new Error(
            `Capabilities returned ${capabilities.status}: ${text}`,
          );
        const body = JSON.parse(text) as { hostedHarness: { bootId: string } };
        this.bootId = body.hostedHarness.bootId;
        return true;
      }, options.startupTimeout);
    } catch (error) {
      await this.close();
      throw error;
    }
    return this;
  }

  headers(clientId?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${HOSTED_TOKEN}`,
      'X-Qwen-Harness-Protocol-Version': '1',
      'X-Qwen-Harness-Boot-Id': this.bootId,
      ...(clientId ? { 'X-Qwen-Client-Id': clientId } : {}),
    };
  }

  request(route: string, init: RequestInit = {}) {
    return fetch(this.baseUrl + route, {
      ...init,
      headers: init.headers ?? this.headers(),
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
  }

  async close() {
    if (
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      this.child.kill('SIGTERM');
      const timer = setTimeout(() => this.child?.kill('SIGKILL'), 3_000);
      try {
        await this.exited;
      } finally {
        clearTimeout(timer);
      }
    }
    if (this.root)
      await rm(this.root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  }
}
