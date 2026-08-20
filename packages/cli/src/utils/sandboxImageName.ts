/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Docker does not allow container names to contain ':' or '/', so parse
// registry paths and image tags into a short container-name prefix.
export function parseSandboxImageName(image: string): string {
  const imageWithoutDigest = image.split('@')[0] ?? image;
  const lastSlash = imageWithoutDigest.lastIndexOf('/');
  const lastColon = imageWithoutDigest.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;
  const fullName = hasTag
    ? imageWithoutDigest.slice(0, lastColon)
    : imageWithoutDigest;
  const tag = hasTag ? imageWithoutDigest.slice(lastColon + 1) : undefined;
  const name = fullName.split('/').at(-1) || 'unknown-image';

  return tag ? `${name}-${tag}` : name;
}
