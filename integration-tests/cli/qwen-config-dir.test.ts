/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E integration tests for the QWEN_HOME environment variable.
 *
 * These tests verify that when QWEN_HOME is set, all global config files
 * (installation_id, settings.json, memory.md, etc.) are routed to the
 * custom directory instead of ~/.qwen/.
 *
 * Based on the test plan at:
 *   .claude/docs/PLAN-qwen-config-dir-e2e-tests.md
 *
 * NOTE: Most tests require a full prompt run (config.initialize() must run to
 * write installation_id). Only scenario 2b can use --help because settings
 * migration runs before arg parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestRig } from '../test-helper.js';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// Helper: list files under a directory recursively, returning relative paths
function listFilesRecursive(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full, base));
    } else {
      results.push(full.slice(base.length + 1));
    }
  }
  return results;
}

describe('QWEN_HOME environment variable', () => {
  let rig: TestRig;
  let customConfigDir: string;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => {
    // Always clean up env vars regardless of test outcome
    delete process.env['QWEN_HOME'];
    delete process.env['QWEN_RUNTIME_DIR'];
    await rig.cleanup();
  });

  // -------------------------------------------------------------------------
  // Group 1: Basic environment variable behaviour
  // -------------------------------------------------------------------------

  describe('Group 1: Basic env var behaviour', () => {
    /**
     * 1a. CLI uses custom config dir for settings and initialization.
     *
     * A full prompt run is required because installation_id is only written
     * during config.initialize() → logStartSession() → getInstallationId().
     * --help exits before that point.
     */
    it('1a: installation_id is written inside QWEN_HOME, not ~/.qwen', async () => {
      rig.setup('qwen-home-1a-installation-id');

      customConfigDir = join(rig.testDir!, 'custom-config');
      mkdirSync(customConfigDir, { recursive: true });
      process.env['QWEN_HOME'] = customConfigDir;

      // A full prompt run is needed to trigger config.initialize()
      try {
        await rig.run('say hello');
      } catch {
        // May fail without a valid API key; that is acceptable — we only
        // need config.initialize() to run far enough to create installation_id
      }

      const installationIdPath = join(customConfigDir, 'installation_id');
      expect(
        existsSync(installationIdPath),
        `Expected installation_id at ${installationIdPath}`,
      ).toBe(true);
    });

    /**
     * 1b. CLI creates the config dir structure when the path does not yet exist.
     */
    it('1b: config dir is created when it does not exist', async () => {
      rig.setup('qwen-home-1b-dir-creation');

      // Point to a path that does NOT exist yet
      customConfigDir = join(rig.testDir!, 'nonexistent-config');
      expect(existsSync(customConfigDir)).toBe(false);

      process.env['QWEN_HOME'] = customConfigDir;

      try {
        await rig.run('say hello');
      } catch {
        // May fail without a valid API key — tolerate the error
      }

      // The directory must have been created
      expect(
        existsSync(customConfigDir),
        `Expected ${customConfigDir} to be created`,
      ).toBe(true);

      // installation_id signals that config.initialize() ran inside it
      const installationIdPath = join(customConfigDir, 'installation_id');
      expect(
        existsSync(installationIdPath),
        `Expected installation_id inside newly created dir`,
      ).toBe(true);
    });

    /**
     * 1c. Relative path is resolved correctly.
     *
     * TestRig sets cwd to testDir when spawning the child process, so a
     * relative path like "./custom-qwen" resolves to
     * <testDir>/custom-qwen inside the subprocess.
     */
    it('1c: relative QWEN_HOME path is resolved against subprocess cwd', async () => {
      rig.setup('qwen-home-1c-relative-path');

      const relativePath = './custom-qwen';
      process.env['QWEN_HOME'] = relativePath;

      try {
        await rig.run('say hello');
      } catch {
        // May fail without a valid API key — tolerate the error
      }

      // Resolve the expected absolute path the same way the subprocess does
      const expectedAbsPath = resolve(rig.testDir!, 'custom-qwen');
      const installationIdPath = join(expectedAbsPath, 'installation_id');
      expect(
        existsSync(installationIdPath),
        `Expected installation_id at resolved path ${installationIdPath}`,
      ).toBe(true);
    });

    /**
     * 1d. Default behaviour is preserved when QWEN_HOME is unset.
     */
    it('1d: CLI functions normally when QWEN_HOME is not set', async () => {
      rig.setup('qwen-home-1d-default-behaviour');

      // Explicitly ensure QWEN_HOME is absent for this test
      delete process.env['QWEN_HOME'];

      // A simple prompt run should succeed without errors
      const result = await rig.run('say hello');
      expect(result).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Group 2: Feature-specific config dir routing
  // -------------------------------------------------------------------------

  describe('Group 2: Feature-specific routing', () => {
    /**
     * 2b. Settings migration runs against the custom config dir.
     *
     * `extensions list` is sufficient here because it is a yargs subcommand
     * that runs through `main()` and reaches `loadSettings()` (which triggers
     * migration), without needing an API key or interactive session.
     * (Note: `--help` cannot be used — yargs intercepts it and exits the
     * process before `loadSettings()` runs.)
     */
    it('2b: settings migration runs in QWEN_HOME dir', async () => {
      rig.setup('qwen-home-2b-settings-migration');

      customConfigDir = join(rig.testDir!, 'migration-config');
      mkdirSync(customConfigDir, { recursive: true });
      process.env['QWEN_HOME'] = customConfigDir;

      // Write a V1-format settings file into the custom config dir
      const v1Settings = {
        $version: 1,
        theme: 'dark',
        autoAccept: true,
      };
      writeFileSync(
        join(customConfigDir, 'settings.json'),
        JSON.stringify(v1Settings, null, 2),
      );

      // `extensions list` triggers loadSettings() (migration) without needing
      // an API key.
      try {
        await rig.runCommand(['extensions', 'list']);
      } catch {
        // Tolerate non-zero exit; migration runs regardless.
      }

      // Read migrated settings
      const migratedRaw = readFileSync(
        join(customConfigDir, 'settings.json'),
        'utf-8',
      );
      const migrated = JSON.parse(migratedRaw) as Record<string, unknown>;

      // Migration should have bumped the version to the current SETTINGS_VERSION
      // (packages/cli/src/config/settings.ts). Update this when the schema bumps.
      expect(migrated['$version']).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // Group 3: Isolation — project-level .qwen/ is NOT affected
  // -------------------------------------------------------------------------

  describe('Group 3: Project-level isolation', () => {
    /**
     * 3a. Project-level workspace settings work independently of QWEN_HOME.
     *
     * We put already-current settings in QWEN_HOME and V1 settings in the
     * workspace .qwen/settings.json. Running `extensions list` triggers
     * loadSettings() (migration). If the CLI is correctly reading workspace
     * settings from <testDir>/.qwen/, the workspace settings.json will be
     * migrated. If it mistakenly read from QWEN_HOME, the workspace file
     * would be untouched.
     *
     * `extensions list` runs through `main()` and reaches `loadSettings()`
     * (which triggers migration) without needing an API key.
     */
    it('3a: workspace settings are read from project .qwen/, not from QWEN_HOME', async () => {
      rig.setup('qwen-home-3a-isolation');

      customConfigDir = join(rig.testDir!, 'global-config');
      mkdirSync(customConfigDir, { recursive: true });
      process.env['QWEN_HOME'] = customConfigDir;

      // Seed QWEN_HOME with the current schema version so it shouldn't migrate.
      // Bump alongside SETTINGS_VERSION in packages/cli/src/config/settings.ts.
      writeFileSync(
        join(customConfigDir, 'settings.json'),
        JSON.stringify({ $version: 4, customKey: 'in-global-dir' }, null, 2),
      );

      // Overwrite the workspace settings.json with V1 format so migration is observable
      const workspaceSettingsPath = join(
        rig.testDir!,
        '.qwen',
        'settings.json',
      );
      writeFileSync(
        workspaceSettingsPath,
        JSON.stringify(
          {
            $version: 1,
            theme: 'dark',
            autoAccept: false,
            customWorkspaceKey: 'workspace-value',
          },
          null,
          2,
        ),
      );

      // `extensions list` triggers loadSettings() (including migration)
      // without needing an API key.
      try {
        await rig.runCommand(['extensions', 'list']);
      } catch {
        // Tolerate non-zero exit; migration runs regardless.
      }

      // The workspace settings.json must have been migrated to the current
      // SETTINGS_VERSION — proving the CLI read it from the workspace dir, not
      // from QWEN_HOME. Update the version when the schema bumps.
      const workspaceRaw = readFileSync(workspaceSettingsPath, 'utf-8');
      const workspaceSettings = JSON.parse(workspaceRaw) as Record<
        string,
        unknown
      >;
      expect(workspaceSettings['$version']).toBe(4);
      expect(workspaceSettings['customWorkspaceKey']).toBe('workspace-value');

      // The QWEN_HOME settings.json must be unchanged (still at the version we wrote)
      const globalRaw = readFileSync(
        join(customConfigDir, 'settings.json'),
        'utf-8',
      );
      const globalSettings = JSON.parse(globalRaw) as Record<string, unknown>;
      expect(globalSettings['customKey']).toBe('in-global-dir');
    });
  });

  // -------------------------------------------------------------------------
  // Group 4: Interaction with QWEN_RUNTIME_DIR
  // -------------------------------------------------------------------------

  describe('Group 4: Interaction with QWEN_RUNTIME_DIR', () => {
    /**
     * 4a. QWEN_HOME and QWEN_RUNTIME_DIR can be set independently.
     *
     * Config files (installation_id) go to QWEN_HOME.
     * Runtime files (debug logs) go to QWEN_RUNTIME_DIR.
     */
    it('4a: config files land in QWEN_HOME and runtime files land in QWEN_RUNTIME_DIR', async () => {
      rig.setup('qwen-home-4a-independence');

      customConfigDir = join(rig.testDir!, 'config-dir');
      const runtimeDir = join(rig.testDir!, 'runtime-dir');
      mkdirSync(customConfigDir, { recursive: true });
      mkdirSync(runtimeDir, { recursive: true });

      process.env['QWEN_HOME'] = customConfigDir;
      process.env['QWEN_RUNTIME_DIR'] = runtimeDir;

      try {
        await rig.run('say hello');
      } catch {
        // May fail without a valid API key — tolerate the error
      }

      // Config file must be inside QWEN_HOME
      const installationIdPath = join(customConfigDir, 'installation_id');
      expect(
        existsSync(installationIdPath),
        `Expected installation_id in QWEN_HOME at ${installationIdPath}`,
      ).toBe(true);

      // Debug logs must be inside QWEN_RUNTIME_DIR (under debug/)
      const debugDir = join(runtimeDir, 'debug');
      const debugFiles = listFilesRecursive(debugDir);
      expect(
        debugFiles.length,
        `Expected debug log files in ${debugDir}`,
      ).toBeGreaterThan(0);

      // installation_id must NOT appear in the runtime dir
      const runtimeInstallationId = join(runtimeDir, 'installation_id');
      expect(
        existsSync(runtimeInstallationId),
        `Did NOT expect installation_id inside QWEN_RUNTIME_DIR`,
      ).toBe(false);
    });
  });
});
