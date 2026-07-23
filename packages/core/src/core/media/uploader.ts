/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type { MediaProbe } from '../../utils/media/types.js';

/**
 * P2 · Uploader (Pattern P · provider-coupled hard logic), mirroring the
 * `determineProvider` shape: an interface, one class per backend KIND, a static
 * `isApplicable` predicate, a deterministic `determineUploader` if-chain, and a
 * `DefaultUploader` that always terminates the chain.
 *
 * Adding a new KIND (OSS / S3 / Gemini Files) = new class + one branch — a
 * mandatory core change, the same tier as adding a provider. Deployment params
 * (bucket/region/credentials) come from env/config, never inlined into core.
 *
 * The Default backend is fail-closed: with no upload channel configured it does
 * not silently drop the file — it throws a `UploadNotConfiguredError` carrying a
 * concrete remedy, which the caller renders as a C10 over-budget error.
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

/**
 * Terminal fallback. Always applicable, always fails closed — its presence is
 * what guarantees the chain never returns undefined, and its throw is what
 * guarantees a too-large file is reported rather than silently dropped.
 */
class DefaultUploader implements Uploader {
  readonly id = 'default';
  constructor(_config: Config) {}
  static isApplicable(_config: Config): boolean {
    return true;
  }
  async upload(probe: MediaProbe): Promise<UploadResult> {
    throw new UploadNotConfiguredError(
      `No upload backend is configured, but ${probe.path} (${probe.sizeBytes}B) exceeds the inline media limit.`,
      'Configure a media upload backend (e.g. object storage or a provider Files API) via the `media.upload` setting, or read a smaller range/region of the file so it fits inline.',
    );
  }
}

/**
 * Select the upload backend. New backends slot in as `if
 * (XxxUploader.isApplicable(config)) return new XxxUploader(config);` branches
 * above the Default terminal — exactly like `determineProvider`.
 */
export function determineUploader(config: Config): Uploader {
  // (OSS / S3 / Gemini Files branches go here as they are added.)
  return new DefaultUploader(config);
}
