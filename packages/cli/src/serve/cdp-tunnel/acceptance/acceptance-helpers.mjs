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
  const parenthesized = selected.match(/\(([^()]*)\)\s*\[selected\]\s*$/)?.[1];
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
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || ''}`);
};

const waitForExit = (child) => {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
};

export const stopChild = async (child, { graceMs = 3_000 } = {}) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    waitForExit(child),
    new Promise((resolve) => setTimeout(resolve, graceMs)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
};

export const isCdpSmokePassed = (out) =>
  out.tools >= 20 && Boolean(out.listPages) && !out.error;
