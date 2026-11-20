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
export const BUN_VERSION = '1.4.4';

export const RUNTIME_ARCHIVE_DIGESTS = {
  'linux-x64': {
    node: 'f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4',
    bun: 'sha512-CHbbkmHVM28T1GFq+6GL4Ao4ujwwYwj1CxFFwEFzLanPfNsId9AhbIP0Q4reWuWBkGimUkoQygrK7Rgjtj3vog==',
  },
  'linux-arm64': {
    node: 'd28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f',
    bun: 'sha512-ZTVtpf9zmHSBVPX1sBwe5agGb/rN34yPGg/Hby8e2Ax2uCUA2URZKlZH7qLntK7qaFJCMXh9v0GWNYN2zINz1w==',
  },
  'darwin-x64': {
    node: 'd1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316',
    bun: 'sha512-oKGcxLsvh4oHjAo28nPm8c/xN0o/OmGyj1IHYc94vprkWsW2hNg2keEZt5f40cI5Hvu4jDlSRTR0UNpv1UIAxw==',
  },
  'darwin-arm64': {
    node: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
    bun: 'sha512-zW/hxwc8sJAILGwB5eTC4i48ouGXf0V4lrxmEOk3JIE6JkYVW1TZh1E2pIempqsezgW1sckTIIDudFON8bJ2Mw==',
  },
};
