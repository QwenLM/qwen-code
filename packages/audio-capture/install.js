/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Build (or locate a prebuild for) the native microphone addon. A failed or
// impossible build is intentionally NON-FATAL: voice input falls back to the
// SoX/arecord recorder, so installing the CLI must never break for this optional
// capability — not on a platform without a prebuild or a C/C++ toolchain, and
// not for the many users who never use voice. This keeps a voice-only compile
// failure from turning every `npm ci` (including unrelated CI jobs) red.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const result = spawnSync('node-gyp-build', [], {
  stdio: 'inherit',
  shell: true,
});

if (result.status !== 0) {
  process.stderr.write(
    '[audio-capture] native microphone backend unavailable; ' +
      'voice input will fall back to SoX/arecord.\n',
  );
}

// Always exit 0 so a missing native backend never fails the install.
process.exit(0);
