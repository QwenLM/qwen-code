/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Backend-agnostic contract for publishing an artifact. The local backend
 * writes to disk and returns a file:// URL; the host/oss backends upload to a
 * configured destination and return an https://
 * link. The {@link ArtifactTool} depends only on this interface so backends are
 * swappable without touching the tool.
 */
export type ArtifactPublisherKind = 'local' | 'host' | 'oss';

export interface ArtifactPublisher {
  /** Backend identifier, e.g. 'local'. */
  readonly kind: ArtifactPublisherKind;
  /**
   * Publishes (or redeploys) the document. Implementations MUST be idempotent
   * for a given {@link PublishArtifactInput.id}: the same id redeploys to the
   * same destination/URL.
   */
  publish(
    input: PublishArtifactInput,
    signal?: AbortSignal,
  ): Promise<PublishedArtifact>;
}

export interface PublishArtifactInput {
  /** Stable identity for this artifact (see {@link artifactIdFromPath}). */
  id: string;
  /** Human-readable title (already sanitized). */
  title: string;
  /** The full, wrapped, self-contained HTML document to publish. */
  html: string;
}

export interface PublishedArtifact {
  /** Stable artifact id (echoes the input id). */
  id: string;
  /** Address to open or share the artifact. */
  url: string;
  /** Absolute path of the published document, when the backend writes to disk. */
  filePath?: string;
}

/**
 * Config for the host publisher. The artifact is uploaded by running
 * a user-supplied command; `{file}` (the local HTML path) and `{key}` (the
 * remote object key) are substituted, and `urlTemplate`'s `{key}` yields the
 * shareable URL. Credentials live in the user's command/environment — qwen
 * never stores them.
 */
export interface ArtifactHostConfig {
  /** Upload command, e.g. `aws s3 cp {file} s3://bkt/{key} --content-type text/html`. */
  uploadCommand: string;
  /** Shareable URL template, e.g. `https://bkt.s3.amazonaws.com/{key}`. */
  urlTemplate: string;
  /** Remote key prefix (default `artifacts`). Key = `{prefix}/{id}/index.html`. */
  keyPrefix?: string;
}

/**
 * Config for the native Aliyun OSS publisher (zero-dependency). The
 * artifact is uploaded with a self-signed PUT Object request. Credentials come
 * from the environment (OSS_* / ALIBABA_CLOUD_*), never from settings.
 */
export interface ArtifactOssConfig {
  /** Bucket name. */
  bucket: string;
  /** OSS endpoint host, e.g. `oss-cn-hangzhou.aliyuncs.com`. */
  endpoint: string;
  /** Remote key prefix (default `artifacts`). Key = `{prefix}/{id}/index.html`. */
  keyPrefix?: string;
  /** Object ACL (default `public-read` so the link is shareable). */
  acl?: string;
  /** Optional CDN / custom domain base for the returned URL (upload still uses endpoint). */
  publicBaseUrl?: string;
}

/**
 * Derives a stable artifact id from the source fragment's file path. Identity
 * is keyed by path so re-publishing an edited file redeploys to the same URL;
 * a different path mints a new artifact.
 */
export function artifactIdFromPath(filePath: string): string {
  const normalized = path.resolve(filePath);
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}
