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
) => Promise<string>;

const defaultRunCommand: RunCommand = async (command, args, signal) => {
  const { stdout } = await execFileAsync(command, args, {
    signal,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
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

function substitute(
  token: string,
  file: string,
  dir: string,
  key: string,
): string {
  return token
    .split('{file}')
    .join(file)
    .split('{dir}')
    .join(dir)
    .split('{key}')
    .join(key);
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

function validatePublishedUrl(raw: string): string {
  const candidate = raw.trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(
      'artifact.host upload command did not print a valid deployment URL.',
    );
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(
      'artifact.host upload command must print an HTTPS URL without embedded credentials.',
    );
  }
  return candidate;
}

/** Parses the plain or JSON URL emitted by a static-site deployment CLI. */
export function parsePublishedUrl(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error(
      'artifact.host upload command did not print a deployment URL.',
    );
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of [
        'deploy_ssl_url',
        'deploy_url',
        'ssl_url',
        'url',
        'deployUrl',
      ]) {
        if (typeof record[key] === 'string') {
          try {
            return validatePublishedUrl(record[key]);
          } catch {
            // Prefer the first usable HTTPS field over an insecure alias.
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      return validatePublishedUrl(trimmed);
    }
    throw err;
  }

  throw new Error(
    'artifact.host upload command JSON did not contain a deployment URL.',
  );
}

/**
 * Uploads the artifact via a user-configured command and returns its shareable
 * URL. Template mode uses a deterministic remote object key; command-output
 * mode deploys a temporary static site and trusts the command's returned URL.
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
    const urlFromCommandOutput = this.config.urlFromCommandOutput === true;
    if (!uploadCommand) {
      throw new Error(
        'artifact.host.uploadCommand is not configured (set it to e.g. "aws s3 cp {file} s3://bucket/{key}").',
      );
    }
    if (!urlFromCommandOutput && !urlTemplate) {
      throw new Error(
        'artifact.host.urlTemplate is not configured (set it to e.g. "https://bucket.example.com/{key}").',
      );
    }
    if (urlFromCommandOutput && !uploadCommand.includes('{dir}')) {
      throw new Error(
        'artifact.host.uploadCommand must include the {dir} placeholder when urlFromCommandOutput is enabled.',
      );
    }
    if (!urlFromCommandOutput && !uploadCommand.includes('{file}')) {
      throw new Error(
        'artifact.host.uploadCommand must include the {file} placeholder (the local HTML path to upload).',
      );
    }
    if (!urlFromCommandOutput && !uploadCommand.includes('{key}')) {
      throw new Error(
        'artifact.host.uploadCommand must include the {key} placeholder so the upload destination matches the returned URL.',
      );
    }
    if (!urlFromCommandOutput && !urlTemplate.includes('{key}')) {
      throw new Error(
        'artifact.host.urlTemplate must include the {key} placeholder (the remote object key).',
      );
    }
    if (!urlFromCommandOutput && urlTemplate.includes('{file}')) {
      throw new Error(
        'artifact.host.urlTemplate must not include {file}; only {key} is supported.',
      );
    }

    const key =
      !urlFromCommandOutput || uploadCommand.includes('{key}')
        ? `${normalizeKeyPrefix(this.config.keyPrefix)}/${input.id}/index.html`
        : '';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-art-'));
    const file = path.join(dir, 'index.html');

    let output = '';
    try {
      await fs.writeFile(file, input.html, 'utf8');
      const argv = tokenizeCommand(uploadCommand).map((t) =>
        substitute(t, file, dir, key),
      );
      const [command, ...args] = argv;
      if (!command) {
        throw new Error('artifact.host.uploadCommand is empty.');
      }
      output = await this.run(command, args, signal);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }

    return {
      id: input.id,
      url: urlFromCommandOutput
        ? parsePublishedUrl(output)
        : substituteKey(urlTemplate, key),
    };
  }
}
