/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../../config/config.js';
import type { MediaProbe } from '../../utils/media/types.js';
import { resolveMediaConfig } from '../../utils/media/media-config.js';
import type { MediaUploadConfig } from '../../utils/media/media-config.js';

/**
 * P2 · Uploader (Pattern P · provider-coupled hard logic), mirroring the
 * `determineProvider` shape: an interface, one class per backend KIND, a static
 * `isApplicable` predicate, a deterministic `determineUploader` if-chain, and a
 * `DefaultUploader` that always terminates the chain.
 *
 * Adding a new KIND (OSS / S3 / Gemini Files) = new class + one branch — a
 * mandatory core change, the same tier as adding a provider. Deployment params
 * (bucket/region/endpoint/command) come from config/env, never inlined into core;
 * secrets stay in env.
 *
 * Two real backends ship: `command` (run any upload CLI that prints the public
 * URL — aliyun/aws/rclone/gsutil, dependency-free) and `http` (PUT the bytes to
 * a presigned/endpoint URL, reference by a public URL). The Default backend is
 * fail-closed: with no upload channel configured it does not silently drop the
 * file — it throws `UploadNotConfiguredError` carrying a concrete remedy, which
 * the caller renders as a C10 over-budget error.
 */

export interface UploadResult {
  /** A URI the active provider can fetch (public URL or provider Files API id). */
  fileUri: string;
  mimeType: string;
}

export interface Uploader {
  readonly id: string;
  upload(probe: MediaProbe): Promise<UploadResult>;
}

export class UploadNotConfiguredError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'UploadNotConfiguredError';
    this.remedy = remedy;
  }
}

/** Read the resolved `media.upload` config defensively (tolerates a bare Config). */
function uploadConfigOf(config: Config): MediaUploadConfig | undefined {
  if (typeof config?.getMediaConfig !== 'function') return undefined;
  return resolveMediaConfig(config).upload;
}

const UPLOAD_TIMEOUT_MS = 300_000;

/**
 * `backend: 'command'` — run a configured upload CLI. The command template is
 * substituted with `{path}` / `{name}` / `{bucket}`; its stdout's last non-empty
 * line is taken as the fetchable URL. This is the dependency-free "real backend"
 * (aliyun oss cp, aws s3 cp + presign, rclone, gsutil, …). Secrets live in the
 * CLI's own env/credential store, never in config.
 */
class CommandUploader implements Uploader {
  readonly id = 'command';
  constructor(private readonly upload_: MediaUploadConfig) {}

  static isApplicable(upload: MediaUploadConfig | undefined): boolean {
    return upload?.backend === 'command' && !!upload.command?.trim();
  }

  async upload(probe: MediaProbe): Promise<UploadResult> {
    const template = this.upload_.command!.trim();
    const argv = template
      .split(/\s+/)
      .map((tok) =>
        tok
          .replaceAll('{path}', probe.path)
          .replaceAll('{name}', path.basename(probe.path))
          .replaceAll('{bucket}', this.upload_.bucket ?? ''),
      )
      .filter((tok) => tok.length > 0);
    const [cmd, ...args] = argv;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        cmd,
        args,
        { timeout: UPLOAD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, out, stderr) => {
          if (err) {
            reject(new Error(stderr?.toString().trim() || err.message));
            return;
          }
          resolve(out.toString());
        },
      );
    });
    const url = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    if (!url || !/^(https?|oss|gs|s3):\/\//i.test(url)) {
      throw new UploadNotConfiguredError(
        `Upload command for ${probe.path} did not print a fetchable URL (got: ${url ?? '<empty>'}).`,
        'The upload command must print the resulting public URL as its last stdout line, e.g. `... && echo https://bucket.example.com/{name}`.',
      );
    }
    return { fileUri: url, mimeType: probe.mimeType };
  }
}

/**
 * `backend: 'http'` — PUT the raw bytes to a presigned/endpoint URL and
 * reference the object by a public URL. `endpoint` and `publicUrlBase` may use
 * `{name}`; `endpoint` defaults to `publicUrlBase/{name}` when omitted. Extra
 * headers (e.g. an auth token from env) can be supplied via `headersEnv`.
 */
class HttpPutUploader implements Uploader {
  readonly id = 'http';
  constructor(private readonly upload_: MediaUploadConfig) {}

  static isApplicable(upload: MediaUploadConfig | undefined): boolean {
    return (
      upload?.backend === 'http' &&
      (!!upload.endpoint?.trim() || !!upload.publicUrlBase?.trim())
    );
  }

  async upload(probe: MediaProbe): Promise<UploadResult> {
    const name = path.basename(probe.path);
    const base = this.upload_.publicUrlBase?.replace(/\/+$/, '');
    const endpoint = (
      this.upload_.endpoint?.trim() || `${base}/${name}`
    ).replaceAll('{name}', encodeURIComponent(name));
    const publicUrl = (base ? `${base}/${name}` : endpoint).replaceAll(
      '{name}',
      encodeURIComponent(name),
    );

    const headers: Record<string, string> = {
      'content-type': probe.mimeType,
    };
    if (this.upload_.headersEnv) {
      for (const [header, envKey] of Object.entries(this.upload_.headersEnv)) {
        const val = process.env[envKey];
        if (val) headers[header] = val;
      }
    }

    const bytes = await fs.readFile(probe.path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: this.upload_.method ?? 'PUT',
        headers,
        body: bytes,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new UploadNotConfiguredError(
          `Upload of ${probe.path} to ${endpoint} failed: HTTP ${res.status}.`,
          'Check the upload endpoint URL, credentials (headersEnv), and that the object store accepts a PUT of this size.',
        );
      }
    } finally {
      clearTimeout(timer);
    }
    return { fileUri: publicUrl, mimeType: probe.mimeType };
  }
}

/**
 * Terminal fallback. Always applicable, always fails closed — its presence is
 * what guarantees the chain never returns undefined, and its throw is what
 * guarantees a too-large file is reported rather than silently dropped.
 */
class DefaultUploader implements Uploader {
  readonly id = 'default';
  static isApplicable(): boolean {
    return true;
  }
  async upload(probe: MediaProbe): Promise<UploadResult> {
    throw new UploadNotConfiguredError(
      `No upload backend is configured, but ${probe.path} (${probe.sizeBytes}B) exceeds the inline media limit.`,
      'Configure a media upload backend (`media.upload.backend` = "command" with an upload CLI, or "http" with an endpoint/publicUrlBase) so large files can be referenced by URL, or read a smaller range/region of the file so it fits inline.',
    );
  }
}

/**
 * Select the upload backend. New backends slot in as
 * `if (XxxUploader.isApplicable(upload)) return new XxxUploader(upload);`
 * branches above the Default terminal — exactly like `determineProvider`.
 */
export function determineUploader(config: Config): Uploader {
  const upload = uploadConfigOf(config);
  if (CommandUploader.isApplicable(upload)) return new CommandUploader(upload!);
  if (HttpPutUploader.isApplicable(upload)) return new HttpPutUploader(upload!);
  return new DefaultUploader();
}
