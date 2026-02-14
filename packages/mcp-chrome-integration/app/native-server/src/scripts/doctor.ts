#!/usr/bin/env node

/**
 * doctor.ts
 *
 * Diagnoses common installation and runtime issues for the Chrome Native Messaging host.
 * Provides checks for manifest files, Node.js path, permissions, and connectivity.
 *
 * This module is organized as follows:
 * - doctor-types.ts: Type definitions
 * - doctor-utils.ts: Utility functions and constants
 * - doctor-node-resolver.ts: Node.js resolution logic
 * - doctor-browser.ts: Browser resolution utilities
 * - doctor-registry.ts: Windows registry utilities
 * - doctor-fix.ts: Fix attempt utilities
 * - doctor-connectivity.ts: Connectivity check utilities
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { EXTENSION_ID, HOST_NAME, COMMAND_NAME } from './constant';
import { colorText, getLogDir } from './utils';
import { getBrowserConfig } from './browser-config';
const NATIVE_SERVER_PORT = 12306;

// Re-export types and utilities from submodules for external consumers
export type {
  DoctorOptions,
  DoctorStatus,
  DoctorFixAttempt,
  DoctorCheckResult,
  DoctorReport,
  NodeResolutionResult,
} from './doctor-types';

export {
  EXPECTED_PORT,
  SCHEMA_VERSION,
  MIN_NODE_MAJOR_VERSION,
  readPackageJson,
  getCommandInfo,
  resolveDistDir,
  stringifyError,
  canExecute,
  normalizeComparablePath,
  stripOuterQuotes,
  expandTilde,
  expandWindowsEnvVars,
  parseVersionFromDirName,
  parseNodeMajorVersion,
  compareVersions,
  readJsonFile,
  computeSummary,
  statusBadge,
} from './doctor-utils';

export { resolveNodeCandidate } from './doctor-node-resolver';

export {
  resolveTargetBrowsers,
  resolveBrowsersToCheck,
} from './doctor-browser';

export { queryWindowsRegistryDefaultValue } from './doctor-registry';

export { attemptFixes } from './doctor-fix';

export { resolveFetch, checkConnectivity } from './doctor-connectivity';

// Import for internal use
import {
  EXPECTED_PORT,
  MIN_NODE_MAJOR_VERSION,
  readPackageJson,
  getCommandInfo,
  resolveDistDir,
  stringifyError,
  canExecute,
  normalizeComparablePath,
  stripOuterQuotes,
  expandWindowsEnvVars,
  readJsonFile,
  computeSummary,
  statusBadge,
  parseNodeMajorVersion,
} from './doctor-utils';
import { resolveNodeCandidate } from './doctor-node-resolver';
import {
  resolveTargetBrowsers,
  resolveBrowsersToCheck,
} from './doctor-browser';
import { queryWindowsRegistryDefaultValue } from './doctor-registry';
import { attemptFixes } from './doctor-fix';
import { checkConnectivity } from './doctor-connectivity';
import { DoctorCheckResult, DoctorOptions, DoctorReport } from './doctor-types';

// ============================================================================
// Main Doctor Function
// ============================================================================

/**
 * Collect doctor report without outputting to console.
 * Used by both runDoctor and report command.
 */
export async function collectDoctorReport(
  options: DoctorOptions,
): Promise<DoctorReport> {
  const pkg = readPackageJson();
  const distDir = resolveDistDir();
  const rootDir = path.resolve(distDir, '..');
  const packageName =
    typeof pkg.name === 'string' ? pkg.name : 'mcp-chrome-bridge';
  const packageVersion =
    typeof pkg.version === 'string' ? pkg.version : 'unknown';
  const commandInfo = getCommandInfo(pkg);

  const targetBrowsers = resolveTargetBrowsers(options.browser);
  const browsersToCheck = resolveBrowsersToCheck(targetBrowsers);

  const wrapperScriptName =
    process.platform === 'win32' ? 'run_host.bat' : 'run_host.sh';
  const wrapperPath = path.resolve(distDir, wrapperScriptName);
  const nodeScriptPath = path.resolve(distDir, 'index.js');
  const logDir = getLogDir();
  const stdioConfigPath = path.resolve(distDir, 'mcp', 'stdio-config.json');

  // Run fixes if requested
  const fixes = await attemptFixes(
    Boolean(options.fix),
    Boolean(options.json),
    distDir,
    targetBrowsers,
  );

  const checks: DoctorCheckResult[] = [];
  const nextSteps: string[] = [];

  // Check 1: Installation info
  checks.push({
    id: 'installation',
    title: 'Installation',
    status: 'ok',
    message: `${packageName}@${packageVersion}, ${process.platform}-${process.arch}, node ${process.version}`,
    details: {
      packageRoot: rootDir,
      distDir,
      execPath: process.execPath,
      aliases: commandInfo.aliases,
    },
  });

  // Check 2: Host files
  const missingHostFiles: string[] = [];
  if (!fs.existsSync(wrapperPath)) missingHostFiles.push(wrapperPath);
  if (!fs.existsSync(nodeScriptPath)) missingHostFiles.push(nodeScriptPath);
  if (!fs.existsSync(stdioConfigPath)) missingHostFiles.push(stdioConfigPath);

  if (missingHostFiles.length > 0) {
    checks.push({
      id: 'host.files',
      title: 'Host files',
      status: 'error',
      message: `Missing required files (${missingHostFiles.length})`,
      details: { missing: missingHostFiles },
    });
    nextSteps.push(`Reinstall: npm install -g ${COMMAND_NAME}`);
  } else {
    checks.push({
      id: 'host.files',
      title: 'Host files',
      status: 'ok',
      message: `Wrapper: ${wrapperPath}`,
      details: { wrapperPath, nodeScriptPath, stdioConfigPath },
    });
  }

  // Check 3: Permissions (Unix only)
  if (process.platform !== 'win32' && fs.existsSync(wrapperPath)) {
    const executable = canExecute(wrapperPath);
    checks.push({
      id: 'host.permissions',
      title: 'Host permissions',
      status: executable ? 'ok' : 'error',
      message: executable
        ? 'run_host.sh is executable'
        : 'run_host.sh is not executable',
      details: {
        path: wrapperPath,
        fix: executable
          ? undefined
          : [`${COMMAND_NAME} fix-permissions`, `chmod +x "${wrapperPath}"`],
      },
    });
    if (!executable) nextSteps.push(`${COMMAND_NAME} fix-permissions`);
  } else {
    checks.push({
      id: 'host.permissions',
      title: 'Host permissions',
      status: 'ok',
      message:
        process.platform === 'win32' ? 'Not applicable on Windows' : 'N/A',
    });
  }

  // Check 4: Node resolution
  const nodeResolution = resolveNodeCandidate(distDir);
  if (nodeResolution.nodePath) {
    try {
      nodeResolution.version = execFileSync(nodeResolution.nodePath, ['-v'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 2500,
        windowsHide: true,
      }).trim();
    } catch (e) {
      nodeResolution.versionError = stringifyError(e);
    }
  }

  // Parse Node version and check if it meets minimum requirement
  const nodeMajorVersion = parseNodeMajorVersion(nodeResolution.version || '');
  const nodeVersionTooOld =
    nodeMajorVersion !== null && nodeMajorVersion < MIN_NODE_MAJOR_VERSION;

  const nodePathWarn =
    Boolean(nodeResolution.nodePath) &&
    (!nodeResolution.nodePathFile.exists ||
      nodeResolution.nodePathFile.valid === false) &&
    !process.env.CHROME_MCP_NODE_PATH;

  // Determine node check status: error if not found or version too old, warn if path issue
  let nodeStatus: 'ok' | 'warn' | 'error' = 'ok';
  let nodeMessage: string;
  let nodeFix: string[] | undefined;

  if (!nodeResolution.nodePath) {
    nodeStatus = 'error';
    nodeMessage = 'Node.js executable not found by wrapper search order';
    nodeFix = [
      `${COMMAND_NAME} doctor --fix`,
      `Or set CHROME_MCP_NODE_PATH to an absolute node path`,
    ];
    nextSteps.push(`${COMMAND_NAME} doctor --fix`);
  } else if (nodeResolution.versionError) {
    nodeStatus = 'error';
    nodeMessage = `Found ${nodeResolution.source}: ${nodeResolution.nodePath} but failed to run "node -v" (${nodeResolution.versionError})`;
    nodeFix = [
      `Verify the executable: "${nodeResolution.nodePath}" -v`,
      `Reinstall/repair Node.js`,
    ];
    nextSteps.push(`Verify Node.js: "${nodeResolution.nodePath}" -v`);
  } else if (nodeVersionTooOld) {
    nodeStatus = 'error';
    nodeMessage = `Node.js ${nodeResolution.version} is too old (requires >= ${MIN_NODE_MAJOR_VERSION}.0.0)`;
    nodeFix = [
      `Upgrade Node.js to version ${MIN_NODE_MAJOR_VERSION} or higher`,
    ];
    nextSteps.push(`Upgrade Node.js to version ${MIN_NODE_MAJOR_VERSION}+`);
  } else if (nodePathWarn) {
    nodeStatus = 'warn';
    nodeMessage = `Using ${nodeResolution.source}: ${nodeResolution.nodePath}${nodeResolution.version ? ` (${nodeResolution.version})` : ''}`;
    nodeFix = [
      `${COMMAND_NAME} doctor --fix`,
      `Or set CHROME_MCP_NODE_PATH to an absolute node path`,
    ];
  } else {
    nodeStatus = 'ok';
    nodeMessage = `Using ${nodeResolution.source}: ${nodeResolution.nodePath}${nodeResolution.version ? ` (${nodeResolution.version})` : ''}`;
  }

  checks.push({
    id: 'node',
    title: 'Node executable',
    status: nodeStatus,
    message: nodeMessage,
    details: {
      resolved: nodeResolution.nodePath
        ? {
            source: nodeResolution.source,
            path: nodeResolution.nodePath,
            version: nodeResolution.version,
            versionError: nodeResolution.versionError,
            majorVersion: nodeMajorVersion,
          }
        : undefined,
      nodePathFile: nodeResolution.nodePathFile,
      minRequired: `>=${MIN_NODE_MAJOR_VERSION}.0.0`,
      fix: nodeFix,
    },
  });

  // Check 5: Manifest checks per browser
  const expectedOrigin = `chrome-extension://${EXTENSION_ID}/`;
  for (const browser of browsersToCheck) {
    const config = getBrowserConfig(browser);
    const candidates = [config.userManifestPath, config.systemManifestPath];
    const found = candidates.find((p) => fs.existsSync(p));

    if (!found) {
      checks.push({
        id: `manifest.${browser}`,
        title: `${config.displayName} manifest`,
        status: 'error',
        message: 'Manifest not found',
        details: {
          expected: candidates,
          fix: [
            `${COMMAND_NAME} register --browser ${browser}`,
            `${COMMAND_NAME} register --detect`,
          ],
        },
      });
      nextSteps.push(`${COMMAND_NAME} register --detect`);
      continue;
    }

    const parsed = readJsonFile(found);
    if (!parsed.ok) {
      const parseError = (parsed as { error: string }).error;
      checks.push({
        id: `manifest.${browser}`,
        title: `${config.displayName} manifest`,
        status: 'error',
        message: `Failed to parse manifest: ${parseError}`,
        details: {
          path: found,
          fix: [`${COMMAND_NAME} register --browser ${browser}`],
        },
      });
      nextSteps.push(`${COMMAND_NAME} register --browser ${browser}`);
      continue;
    }

    const manifest = parsed.value as Record<string, unknown>;
    const issues: string[] = [];
    if (manifest.name !== HOST_NAME) issues.push(`name != ${HOST_NAME}`);
    if (manifest.type !== 'stdio') issues.push(`type != stdio`);
    if (typeof manifest.path !== 'string') issues.push('path is missing');
    if (typeof manifest.path === 'string') {
      const actual = normalizeComparablePath(manifest.path);
      const expected = normalizeComparablePath(wrapperPath);
      if (actual !== expected)
        issues.push('path does not match installed wrapper');
      if (!fs.existsSync(manifest.path))
        issues.push('path target does not exist');
    }
    const allowedOrigins = manifest.allowed_origins;
    if (
      !Array.isArray(allowedOrigins) ||
      !allowedOrigins.includes(expectedOrigin)
    ) {
      issues.push(`allowed_origins missing ${expectedOrigin}`);
    }

    checks.push({
      id: `manifest.${browser}`,
      title: `${config.displayName} manifest`,
      status: issues.length === 0 ? 'ok' : 'error',
      message:
        issues.length === 0 ? found : `Invalid manifest (${issues.join('; ')})`,
      details: {
        path: found,
        expectedWrapperPath: wrapperPath,
        expectedOrigin,
        fix:
          issues.length === 0
            ? undefined
            : [`${COMMAND_NAME} register --browser ${browser}`],
      },
    });
    if (issues.length > 0)
      nextSteps.push(`${COMMAND_NAME} register --browser ${browser}`);
  }

  // Check 6: Windows registry (Windows only)
  if (process.platform === 'win32') {
    for (const browser of browsersToCheck) {
      const config = getBrowserConfig(browser);
      const keySpecs = [
        config.registryKey
          ? { key: config.registryKey, expected: config.userManifestPath }
          : null,
        config.systemRegistryKey
          ? {
              key: config.systemRegistryKey,
              expected: config.systemManifestPath,
            }
          : null,
      ].filter(Boolean) as Array<{ key: string; expected: string }>;
      if (keySpecs.length === 0) continue;

      let anyValue = false;
      let anyExistingTarget = false;
      let anyMissingTarget = false;
      let anyMismatch = false;

      const results: Array<{
        key: string;
        expected: string;
        value?: string;
        valueType?: string;
        expandedValue?: string;
        exists?: boolean;
        matchesExpected?: boolean;
        error?: string;
      }> = [];

      for (const spec of keySpecs) {
        const res = queryWindowsRegistryDefaultValue(spec.key);
        if (!res.value) {
          results.push({
            key: spec.key,
            expected: spec.expected,
            error: res.error,
          });
          continue;
        }

        anyValue = true;
        // Expand environment variables for REG_EXPAND_SZ values
        const expandedValue = expandWindowsEnvVars(stripOuterQuotes(res.value));
        const exists = fs.existsSync(expandedValue);
        const matchesExpected =
          normalizeComparablePath(expandedValue) ===
          normalizeComparablePath(spec.expected);

        if (exists) {
          anyExistingTarget = true;
          if (!matchesExpected) anyMismatch = true;
        } else {
          anyMissingTarget = true;
        }

        results.push({
          key: spec.key,
          expected: spec.expected,
          value: res.value,
          valueType: res.valueType,
          expandedValue:
            expandedValue !== res.value ? expandedValue : undefined,
          exists,
          matchesExpected,
        });
      }

      let status: 'ok' | 'warn' | 'error' = 'error';
      let message = 'Registry entry not found';
      if (!anyValue) {
        status = 'error';
        message = 'Registry entry not found';
      } else if (!anyExistingTarget) {
        status = 'error';
        message = 'Registry entry points to missing manifest';
      } else if (anyMissingTarget || anyMismatch) {
        status = 'warn';
        message = 'Registry entry found but inconsistent';
      } else {
        status = 'ok';
        message = 'Registry entry points to manifest';
      }

      checks.push({
        id: `registry.${browser}`,
        title: `${config.displayName} registry`,
        status,
        message,
        details: {
          keys: keySpecs.map((s) => s.key),
          results,
          fix:
            status === 'ok'
              ? undefined
              : [`${COMMAND_NAME} register --browser ${browser}`],
        },
      });
      if (status !== 'ok')
        nextSteps.push(`${COMMAND_NAME} register --browser ${browser}`);
    }
  }

  // Check 7: Port configuration
  if (fs.existsSync(stdioConfigPath)) {
    const cfg = readJsonFile(stdioConfigPath);
    if (!cfg.ok) {
      const cfgError = (cfg as { error: string }).error;
      checks.push({
        id: 'port.config',
        title: 'Port config',
        status: 'error',
        message: `Failed to parse stdio-config.json: ${cfgError}`,
      });
    } else {
      try {
        const configValue = cfg.value as Record<string, unknown>;
        const url = new URL(configValue.url as string);
        const port = Number(url.port);
        const portOk = port === EXPECTED_PORT;
        checks.push({
          id: 'port.config',
          title: 'Port config',
          status: portOk ? 'ok' : 'error',
          message: configValue.url as string,
          details: {
            expectedPort: EXPECTED_PORT,
            actualPort: port,
            fix: portOk
              ? undefined
              : [`${COMMAND_NAME} update-port ${EXPECTED_PORT}`],
          },
        });
        if (!portOk)
          nextSteps.push(`${COMMAND_NAME} update-port ${EXPECTED_PORT}`);

        // Check constant consistency
        const nativePortOk = NATIVE_SERVER_PORT === EXPECTED_PORT;
        checks.push({
          id: 'port.constant',
          title: 'Port constant',
          status: nativePortOk ? 'ok' : 'warn',
          message: `NATIVE_SERVER_PORT=${NATIVE_SERVER_PORT}`,
          details: { expectedPort: EXPECTED_PORT },
        });

        // Connectivity check
        const pingUrl = new URL('/ping', url);
        const ping = await checkConnectivity(pingUrl.toString(), 1500);
        checks.push({
          id: 'connectivity',
          title: 'Connectivity',
          status: ping.ok ? 'ok' : 'warn',
          message: ping.ok
            ? `GET ${pingUrl} -> ${ping.status}`
            : `GET ${pingUrl} failed (${ping.error || 'unknown error'})`,
          details: {
            hint: 'If the server is not running, click "Connect" in the extension and retry.',
          },
        });
        if (!ping.ok)
          nextSteps.push(
            'Click "Connect" in the extension, then re-run doctor',
          );
      } catch (e) {
        checks.push({
          id: 'port.config',
          title: 'Port config',
          status: 'error',
          message: `Invalid URL in stdio-config.json: ${stringifyError(e)}`,
        });
      }
    }
  }

  // Check 8: Logs directory
  checks.push({
    id: 'logs',
    title: 'Logs',
    status: fs.existsSync(logDir) ? 'ok' : 'warn',
    message: logDir,
    details: {
      hint: 'Wrapper logs are created when Chrome launches the native host.',
    },
  });

  // Compute summary
  const summary = computeSummary(checks);
  const ok = summary.error === 0;

  const report: DoctorReport = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    ok,
    summary,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: { version: process.version, execPath: process.execPath },
      package: { name: packageName, version: packageVersion, rootDir, distDir },
      command: {
        canonical: commandInfo.canonical,
        aliases: commandInfo.aliases,
      },
      nativeHost: { hostName: HOST_NAME, expectedPort: EXPECTED_PORT },
    },
    fixes,
    checks,
    nextSteps: Array.from(new Set(nextSteps)).slice(0, 10),
  };

  return report;
}

/**
 * Run doctor command with console output.
 */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const report = await collectDoctorReport(options);
  const packageVersion = report.environment.package.version;

  // Output
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log(`${COMMAND_NAME} doctor v${packageVersion}\n`);
    for (const check of report.checks) {
      console.log(
        `${statusBadge(check.status)}    ${check.title}: ${check.message}`,
      );
      const fix = (check.details as Record<string, unknown> | undefined)
        ?.fix as string[] | undefined;
      if (check.status !== 'ok' && fix && fix.length > 0) {
        console.log(`        Fix: ${fix[0]}`);
      }
    }
    if (report.fixes.length > 0) {
      console.log('\nFix attempts:');
      for (const f of report.fixes) {
        const badge = f.success
          ? colorText('[OK]', 'green')
          : colorText('[ERROR]', 'red');
        console.log(
          `${badge} ${f.description}${f.success ? '' : ` (${f.error})`}`,
        );
      }
    }
    if (report.nextSteps.length > 0) {
      console.log('\nNext steps:');
      report.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    }
  }

  return report.ok ? 0 : 1;
}
