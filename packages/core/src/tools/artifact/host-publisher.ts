/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ArtifactHostConfig,
  ArtifactPublisher,
  PublishArtifactInput,
  PublishedArtifact,
} from './publisher.js';

const execFileAsync = promisify(execFile);

/** Runs the upload command. Injectable so tests don't spawn processes. */
export type RunCommand = (
  command: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<void>;

const defaultRunCommand: RunCommand = async (command, args, signal) => {
  await execFileAsync(command, args, { signal, maxBuffer: 10 * 1024 * 1024 });
};

/**
 * Splits a command string into argv, honoring single/double quotes. The result
 * is executed with `execFile` (no shell), so placeholder values cannot inject
 * extra commands. Throws on an unterminated quote.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;

  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) throw new Error('Unterminated quote in uploadCommand.');
  if (started) tokens.push(current);
  return tokens;
}

function substitute(token: string, file: string, key: string): string {
  return token.split('{file}').join(file).split('{key}').join(key);
}

function substituteKey(token: string, key: string): string {
  return token.split('{key}').join(key);
}

function normalizeKeyPrefix(raw: string | undefined): string {
  const prefix = (raw || 'artifacts').replace(/^\/+|\/+$/g, '');
  if (!prefix) {
    throw new Error(
      'artifact.host.keyPrefix must not be empty or "/" after stripping slashes.',
    );
  }
  if (/[#?%\s]/.test(prefix)) {
    throw new Error(
      'artifact.host.keyPrefix must not contain #, ?, %, or whitespace.',
    );
  }
  return prefix;
}

/**
 * Option C: uploads the artifact via a user-configured command and returns the
 * shareable URL. The remote key is `{prefix}/{id}/index.html` (id = source path
 * hash), so it is deterministic — re-publishing overwrites the same key and the
 * URL stays stable.
 */
export class HostPublisher implements ArtifactPublisher {
  readonly kind = 'host';

  constructor(
    private readonly config: ArtifactHostConfig,
    private readonly run: RunCommand = defaultRunCommand,
  ) {}

  async publish(
    input: PublishArtifactInput,
    signal?: AbortSignal,
  ): Promise<PublishedArtifact> {
    const uploadCommand = this.config.uploadCommand?.trim();
    const urlTemplate = this.config.urlTemplate?.trim();
    if (!uploadCommand) {
      throw new Error(
        'artifact.host.uploadCommand is not configured (set it to e.g. "aws s3 cp {file} s3://bucket/{key}").',
      );
    }
    if (!urlTemplate) {
      throw new Error(
        'artifact.host.urlTemplate is not configured (set it to e.g. "https://bucket.example.com/{key}").',
      );
    }
    if (!uploadCommand.includes('{file}')) {
      throw new Error(
        'artifact.host.uploadCommand must include the {file} placeholder (the local HTML path to upload).',
      );
    }
    if (!uploadCommand.includes('{key}')) {
      throw new Error(
        'artifact.host.uploadCommand must include the {key} placeholder so the upload destination matches the returned URL.',
      );
    }
    if (!urlTemplate.includes('{key}')) {
      throw new Error(
        'artifact.host.urlTemplate must include the {key} placeholder (the remote object key).',
      );
    }
    if (urlTemplate.includes('{file}')) {
      throw new Error(
        'artifact.host.urlTemplate must not include {file}; only {key} is supported.',
      );
    }

    const prefix = normalizeKeyPrefix(this.config.keyPrefix);
    const key = `${prefix}/${input.id}/index.html`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-art-'));
    const file = path.join(dir, 'index.html');
    await fs.writeFile(file, input.html, 'utf8');

    try {
      const argv = tokenizeCommand(uploadCommand).map((t) =>
        substitute(t, file, key),
      );
      const [command, ...args] = argv;
      if (!command) {
        throw new Error('artifact.host.uploadCommand is empty.');
      }
      await this.run(command, args, signal);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }

    return { id: input.id, url: substituteKey(urlTemplate, key) };
  }
}
