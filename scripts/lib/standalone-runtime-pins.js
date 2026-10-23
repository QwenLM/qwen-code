/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The runtimes the standalone regression runs under, and the published
// digests of their archives: the Node SHASUMS256.txt entry and the npm
// `dist.integrity` of @oven/bun-*. Pinning them lets CI verify an archive,
// downloaded or cached, without first fetching checksum metadata from the
// network. A version bump replaces every digest of that runtime.
export const NODE_VERSION = '24.19.0';
export const BUN_VERSION = '1.3.14';

export const RUNTIME_ARCHIVE_DIGESTS = {
  'linux-x64': {
    node: 'f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4',
    bun: 'sha512-7OVTAKvwfPmSbIV1HpdOoVVx5VRc427GuPPne93N6vk4eQBPId9nXmZDh9/zGaKPdbVjVtQSZafWQoUjx38Utw==',
  },
  'linux-arm64': {
    node: 'd28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f',
    bun: 'sha512-X5SsPZHs+iYO8R/efIcRtc7gT2Q2DgPfliCxEkx4cXBumwkw0c/EsHMNwH3EgGpCDaZ7IYVPhpCG/xBOQHEwZw==',
  },
  'darwin-x64': {
    node: 'd1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316',
    bun: 'sha512-FFj3QdU/OhlDyZOJ8CWfN5eWLpRlT4qjZg7lMQi7jA6GuoY5ajlO1zWLP/MuHYRSbXQUvV52RejNi8DVnAp13w==',
  },
  'darwin-arm64': {
    node: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
    bun: 'sha512-Omj20SuiHBOUjUBIyqtkNjSUIjOtEOJwmbix/ZyFH4BaQ6OZTaaRWIR4TjHVz0yadHgli6lLTiAh1uarnvD49A==',
  },
};
