/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// A responder exported as default. The `?? mod.default` fallback in
// `startMockProvider` survived deletion with every test green, so this file
// exists to make that fallback fail out loud when it goes.
export default function respond() {
  return { text: 'default' };
}
