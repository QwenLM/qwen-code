/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Process-level wiring for the session-index sidecar. Mode selection happens
// once at bootstrap (CLI config load, daemon serve startup) via
// configureSessionIndexing() — the same pattern as Storage.setRuntimeBaseDir
// — so the many SessionService/SessionTranscriptReader construction sites
// need no individual plumbing. Every failure mode (mode off, driver missing,
// database corrupted) resolves to `null`, and callers fall back to file
// scanning.

import { createDebugLogger } from '../../utils/debugLogger.js';
import type { SessionIndexMode, SessionIndexStore } from './types.js';

const debugLogger = createDebugLogger('SESSION_INDEX');

interface SqliteDriverModule {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  };
}

let configuredMode: SessionIndexMode = 'file';
let driverProbe:
  | { state: 'unprobed' }
  | { state: 'available'; driver: SqliteDriverModule }
  | { state: 'unavailable' } = { state: 'unprobed' };
let driverOverrideForTest: SqliteDriverModule | null | undefined;

/** projectDir -> in-flight or settled store (null = known-unavailable). */
const stores = new Map<string, Promise<SessionIndexStore | null>>();

export function configureSessionIndexing(options: {
  mode: SessionIndexMode;
}): void {
  configuredMode = options.mode;
}

export function getSessionIndexMode(): SessionIndexMode {
  return configuredMode;
}

/**
 * Test hook: inject a driver, or null to simulate a runtime without
 * node:sqlite. undefined restores real probing.
 */
export function setSessionIndexDriverForTest(
  driver: SqliteDriverModule | null | undefined,
): void {
  driverOverrideForTest = driver;
  driverProbe = { state: 'unprobed' };
}

export function resetSessionIndexingForTest(): void {
  for (const pending of stores.values()) {
    void pending.then(
      (store) => {
        try {
          store?.close();
        } catch {
          // closing a broken store is best-effort in tests
        }
      },
      () => undefined,
    );
  }
  stores.clear();
  configuredMode = 'file';
  driverOverrideForTest = undefined;
  driverProbe = { state: 'unprobed' };
}

async function probeDriver(): Promise<SqliteDriverModule | null> {
  if (driverOverrideForTest !== undefined) {
    return driverOverrideForTest;
  }
  if (driverProbe.state === 'available') return driverProbe.driver;
  if (driverProbe.state === 'unavailable') return null;
  try {
    // Dynamic specifier: packages/core pins @types/node 20.x, which predates
    // node:sqlite type declarations; the structural SqliteDriverModule
    // interface is the compile-time contract instead. A non-literal specifier
    // also keeps bundlers from statically resolving the experimental builtin.
    const specifier = 'node:sqlite';
    const mod = (await import(specifier)) as unknown as SqliteDriverModule;
    driverProbe = { state: 'available', driver: mod };
    return mod;
  } catch (error) {
    debugLogger.debug(`session index driver unavailable: ${String(error)}`);
    driverProbe = { state: 'unavailable' };
    return null;
  }
}

/**
 * Resolve the sidecar store for one project directory, or null when the
 * feature can serve nothing in this process. A corrupted database is deleted
 * and rebuilt; a second failure disables the project for this process rather
 * than crashing the caller. Concurrent first callers share one connection:
 * the memo holds the in-flight open, not just its result.
 */
export function getSessionIndexStore(
  projectDir: string,
): Promise<SessionIndexStore | null> {
  if (configuredMode !== 'sqlite') return Promise.resolve(null);
  const cached = stores.get(projectDir);
  if (cached !== undefined) return cached;
  const opening = openStoreOnce(projectDir);
  stores.set(projectDir, opening);
  return opening;
}

async function openStoreOnce(
  projectDir: string,
): Promise<SessionIndexStore | null> {
  const driver = await probeDriver();
  if (!driver) return null;
  const { openSessionIndexStore } = await import('./sqlite.js');
  try {
    return openSessionIndexStore(driver, projectDir);
  } catch (error) {
    debugLogger.warn(
      `session index open failed, retrying after reset: ${String(error)}`,
    );
    try {
      const { resetSessionIndexDatabase } = await import('./sqlite.js');
      await resetSessionIndexDatabase(projectDir);
      return openSessionIndexStore(driver, projectDir);
    } catch (retryError) {
      debugLogger.warn(
        `session index disabled for ${projectDir}: ${String(retryError)}`,
      );
      return null;
    }
  }
}
