/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const cdpEndpoint = (env = process.env) =>
  env.WS || `ws://127.0.0.1:${env.PORT || 4170}/cdp`;

export const parseSelectedPageUrl = (pages) => {
  const selected =
    pages.split('\n').find((line) => line.includes('[selected]')) || '';
  const parenthesized = selected.match(
    /\(([\w-]+:\S*)\)\s*\[selected\]\s*$/,
  )?.[1];
  const direct = selected.match(/^\s*\d+:\s+(\S+)/)?.[1];
  const candidate = parenthesized || direct;
  if (!candidate) return undefined;
  try {
    return new URL(candidate).href;
  } catch {
    return undefined;
  }
};

export const waitForJson = async (
  url,
  predicate,
  timeoutMs = 30_000,
  fetchImpl = fetch,
) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(remaining),
      });
      if (response.ok) {
        const value = await response.json();
        if (predicate(value)) return value;
      }
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, remaining)),
      );
    }
  }
  throw new Error(
    `Timed out waiting for ${url}: ${lastError?.message || 'predicate never matched'}`,
  );
};

// Wait for 'close' rather than 'exit': a child that fails to spawn never
// emits 'exit', but it always emits 'close' (after the 'error' event).
const waitForExit = (child) => {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => {
    child.once('close', resolve);
  });
};

export const stopChild = async (child, { graceMs = 3_000 } = {}) => {
  // A failed spawn leaves pid undefined with exitCode/signalCode both null,
  // and its 'close' already fired — there is nothing to stop or wait for.
  if (!child || child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let graceTimer;
  await Promise.race([
    waitForExit(child),
    new Promise((resolve) => {
      graceTimer = setTimeout(resolve, graceMs);
    }),
  ]);
  clearTimeout(graceTimer);
  if (child.exitCode === null && child.signalCode === null) {
    // kill() returning false means the process is already gone.
    if (!child.kill('SIGKILL')) return;
    await waitForExit(child);
  }
};

export const isCdpSmokePassed = (out) =>
  out.tools >= 20 && Boolean(out.listPages) && !out.error;
