/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The SDK's getEndpoint() console.log()s the resolved config (clientSecret)
// and the gateway response, ungated by its own debug flag. Silence rather
// than redact: a key allowlist stays open to future SDK logs. Shared by the
// Legacy channel and the managed adapter so this credential guard has a
// single copy — a fix to one must not leave the other leaking.

/* eslint-disable no-console -- swapping console.log out is the whole job here */
let connectLogDepth = 0;
let unsuppressedConsoleLog: typeof console.log | undefined;

// Connects can overlap — a manager replacement starts while another is still
// in flight, and either may settle first — so only the depth 1→0 transition
// restores, to what the 0→1 transition saved. An inner scope restoring its own
// capture would put the no-op back and leave logging off process-wide.
export async function withConnectLoggingSuppressed<T>(
  connect: () => Promise<T>,
): Promise<T> {
  if (connectLogDepth++ === 0) {
    unsuppressedConsoleLog = console.log;
    console.log = () => {};
  }
  try {
    return await connect();
  } finally {
    if (--connectLogDepth === 0 && unsuppressedConsoleLog) {
      console.log = unsuppressedConsoleLog;
      unsuppressedConsoleLog = undefined;
    }
  }
}
/* eslint-enable no-console */
