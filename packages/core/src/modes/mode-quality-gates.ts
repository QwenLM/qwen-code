/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Mode Quality Gates — enforce quality checks before mode exit.
 *
 * Quality gates are configurable checks that run when a mode session ends.
 * They can block the exit (error severity) or simply notify (warning severity).
 * Built-in gates cover linting, test coverage, type checking, security scans,
 * and build verification.
 */

import { EventEmitter } from 'node:events';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createDebugLogger } from '../utils/debugLogger.js';

const execAsync = promisify(exec);
const debugLogger = createDebugLogger('MODE_QUALITY_GATES');

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A single quality gate check.
 */
export interface QualityGate {
  /** Unique identifier for this gate */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of what this gate checks */
  description: string;

  /** Error blocks exit, warning just notifies */
  severity: 'error' | 'warning';

  /** The check function */
  check: () => Promise<QualityGateResult>;
}

/**
 * Result of a quality gate check.
 */
export interface QualityGateResult {
  /** Whether the gate passed */
  passed: boolean;

  /** Human-readable message */
  message: string;

  /** Optional additional details */
  details?: string;
}

/**
 * Configuration for mode quality gates.
 */
export interface ModeQualityConfig {
  /** Gates to run */
  gates: QualityGate[];

  /** Allow bypassing gates */
  skipGates?: boolean;

  /** Attempt to fix issues automatically */
  autoFix?: boolean;
}

/**
 * Result of running all quality gates for a mode.
 */
export interface QualityGateRunResult {
  /** Whether all gates passed */
  passed: boolean;

  /** Array of gate results with metadata */
  results: Array<QualityGate & QualityGateResult>;

  /** Warning messages from warning-severity gates */
  warnings: string[];

  /** Error messages from error-severity gates */
  errors: string[];
}

/**
 * Threshold configuration for built-in gates.
 */
export interface QualityGateThresholds {
  /** Minimum test coverage percentage (for testCoverage gate) */
  minCoveragePercent?: number;

  /** Coverage report file path (defaults to coverage/coverage-summary.json) */
  coverageReportPath?: string;

  /** Whether to treat lint warnings as errors (for lintCheck gate) */
  lintWarningsAsErrors?: boolean;

  /** Maximum allowed security vulnerabilities (for securityScan gate) */
  maxVulnerabilities?: number;

  /** Build command to run (for buildCheck gate) */
  buildCommand?: string;

  /** Working directory for gate commands */
  cwd?: string;
}

// ─── Mode Quality Gate Manager ───────────────────────────────────────────────

/**
 * Manages and executes quality gates for modes.
 */
export class ModeQualityGateManager extends EventEmitter {
  private gates: Map<string, QualityGate[]> = new Map();
  private thresholds: Map<string, QualityGateThresholds> = new Map();
  private builtInGates: Map<string, () => QualityGate> = new Map();

  constructor() {
    super();
    this.registerBuiltInGateFactories();
  }

  // ─── Gate Registration ─────────────────────────────────────────────────────

  /**
   * Register quality gates for a mode.
   *
   * @param modeName - Mode name
   * @param gates - Array of quality gates
   */
  registerGates(modeName: string, gates: QualityGate[]): void {
    this.gates.set(modeName, gates);
    debugLogger.debug(
      `Registered ${gates.length} quality gates for mode: ${modeName}`,
    );
  }

  /**
   * Set thresholds for a mode's quality gates.
   *
   * @param modeName - Mode name
   * @param thresholds - Threshold configuration
   */
  setThresholds(modeName: string, thresholds: QualityGateThresholds): void {
    this.thresholds.set(modeName, thresholds);
    debugLogger.debug(
      `Set quality gate thresholds for mode: ${modeName}`,
    );
  }

  /**
   * Get registered gates for a mode.
   *
   * @param modeName - Mode name
   * @returns Array of quality gates
   */
  getGates(modeName: string): QualityGate[] {
    return this.gates.get(modeName) ?? [];
  }

  // ─── Built-in Gates ────────────────────────────────────────────────────────

  /**
   * Register factory functions for built-in gates.
   */
  private registerBuiltInGateFactories(): void {
    this.builtInGates.set('lintCheck', () => this.createLintCheckGate());
    this.builtInGates.set('testCoverage', () => this.createTestCoverageGate());
    this.builtInGates.set('typeCheck', () => this.createTypeCheckGate());
    this.builtInGates.set('noConsoleLogs', () => this.createNoConsoleLogsGate());
    this.builtInGates.set('securityScan', () => this.createSecurityScanGate());
    this.builtInGates.set('buildCheck', () => this.createBuildCheckGate());
  }

  /**
   * Add built-in gates for a mode by their IDs.
   *
   * @param modeName - Mode name
   * @param gateIds - Array of built-in gate IDs (e.g., ['lintCheck', 'typeCheck'])
   * @param thresholds - Optional threshold overrides
   */
  addBuiltInGates(
    modeName: string,
    gateIds: string[],
    thresholds?: QualityGateThresholds,
  ): void {
    if (thresholds) {
      this.setThresholds(modeName, thresholds);
    }

    const gates: QualityGate[] = [];
    for (const gateId of gateIds) {
      const factory = this.builtInGates.get(gateId);
      if (factory) {
        gates.push(factory());
        debugLogger.debug(
          `Added built-in gate "${gateId}" for mode: ${modeName}`,
        );
      } else {
        debugLogger.warn(`Unknown built-in gate: "${gateId}"`);
      }
    }

    this.registerGates(modeName, gates);
  }

  /**
   * Get all available built-in gate IDs.
   */
  getAvailableBuiltInGatesIds(): string[] {
    return Array.from(this.builtInGates.keys());
  }

  // ─── Gate Execution ────────────────────────────────────────────────────────

  /**
   * Run all quality gates for a mode.
   *
   * @param modeName - Mode name
   * @returns Result of running all gates
   */
  async runGates(modeName: string): Promise<QualityGateRunResult> {
    const gates = this.getGates(modeName);
    const thresholds = this.thresholds.get(modeName) ?? {};

    if (gates.length === 0) {
      debugLogger.debug(`No quality gates registered for mode: ${modeName}`);
      return {
        passed: true,
        results: [],
        warnings: [],
        errors: [],
      };
    }

    debugLogger.debug(
      `Running ${gates.length} quality gates for mode: ${modeName}`,
    );

    const results: Array<QualityGate & QualityGateResult> = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    let allPassed = true;

    for (const gate of gates) {
      try {
        const result = await gate.check();

        const combinedResult: QualityGate & QualityGateResult = {
          ...gate,
          ...result,
        };
        results.push(combinedResult);

        if (result.passed) {
          debugLogger.debug(`Gate "${gate.name}" passed`);
        } else {
          if (gate.severity === 'error') {
            errors.push(`${gate.name}: ${result.message}`);
            allPassed = false;
            debugLogger.error(`Gate "${gate.name}" failed (error): ${result.message}`);
          } else {
            warnings.push(`${gate.name}: ${result.message}`);
            debugLogger.warn(`Gate "${gate.name}" failed (warning): ${result.message}`);
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const result: QualityGateResult = {
          passed: false,
          message: `Gate execution failed: ${errorMsg}`,
        };

        const combinedResult: QualityGate & QualityGateResult = {
          ...gate,
          ...result,
        };
        results.push(combinedResult);

        if (gate.severity === 'error') {
          errors.push(`${gate.name}: ${result.message}`);
          allPassed = false;
        } else {
          warnings.push(`${gate.name}: ${result.message}`);
        }

        debugLogger.error(`Gate "${gate.name}" threw an error:`, error);
      }
    }

    return {
      passed: allPassed,
      results,
      warnings,
      errors,
    };
  }

  // ─── Built-in Gate Implementations ─────────────────────────────────────────

  /**
   * Create a lint check gate — runs linter, fails if errors (for developer mode).
   */
  private createLintCheckGate(): QualityGate {
    return {
      id: 'lintCheck',
      name: 'Lint Check',
      description: 'Runs the project linter and fails if there are errors',
      severity: 'error',
      check: async () => {
        try {
          const cwd = process.cwd();
          // Try common lint commands in order
          const commands = [
            'npm run lint -- --max-warnings=0',
            'npm run lint',
            'npx eslint . --max-warnings=0',
            'npx eslint .',
            'yarn lint',
            'pnpm lint',
          ];

          let output = '';
          let usedCommand = '';

          for (const cmd of commands) {
            try {
              const { stdout } = await execAsync(cmd, {
                cwd,
                timeout: 60000,
                maxBuffer: 1024 * 1024 * 5,
              });
              output = stdout;
              usedCommand = cmd;
              break;
            } catch {
              // Try next command
              continue;
            }
          }

          if (!usedCommand) {
            return {
              passed: true,
              message: 'No lint command found — skipping lint check',
              details: 'No lint script or eslint found in project',
            };
          }

          return {
            passed: true,
            message: 'Lint check passed',
            details: output.trim().substring(0, 500) || undefined,
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            passed: false,
            message: 'Lint check failed',
            details: errorMsg.substring(0, 1000),
          };
        }
      },
    };
  }

  /**
   * Create a test coverage gate — checks test coverage threshold (for tester mode).
   */
  private createTestCoverageGate(): QualityGate {
    return {
      id: 'testCoverage',
      name: 'Test Coverage',
      description: 'Checks that test coverage meets the minimum threshold',
      severity: 'error',
      check: async () => {
        try {
          const cwd = process.cwd();
          const thresholds = this.thresholds.get('tester') ?? {};
          const minCoverage = thresholds.minCoveragePercent ?? 80;
          const reportPath = thresholds.coverageReportPath ??
            path.join(cwd, 'coverage', 'coverage-summary.json');

          // Try to find coverage report
          let coverageData: Record<string, unknown> | null = null;

          try {
            const reportContent = await fs.readFile(reportPath, 'utf-8');
            coverageData = JSON.parse(reportContent) as Record<string, unknown>;
          } catch {
            // Report doesn't exist, try running tests with coverage
            const testCommands = [
              'npm test -- --coverage --coverageReporters=json-summary',
              'npm run test:coverage',
              'npx jest --coverage --coverageReporters=json-summary',
              'npx vitest run --coverage --reporter=json',
              'yarn test --coverage',
              'pnpm test --coverage',
            ];

            for (const cmd of testCommands) {
              try {
                await execAsync(cmd, {
                  cwd,
                  timeout: 120000,
                  maxBuffer: 1024 * 1024 * 10,
                });
                // Try reading the report again
                try {
                  const reportContent = await fs.readFile(reportPath, 'utf-8');
                  coverageData = JSON.parse(reportContent) as Record<string, unknown>;
                  break;
                } catch {
                  // Try alternative report paths
                  const altPaths = [
                    path.join(cwd, 'coverage', 'coverage-summary.json'),
                    path.join(cwd, 'coverage', 'coverage-final.json'),
                  ];
                  for (const altPath of altPaths) {
                    try {
                      const altContent = await fs.readFile(altPath, 'utf-8');
                      coverageData = JSON.parse(altContent) as Record<string, unknown>;
                      break;
                    } catch {
                      continue;
                    }
                  }
                  if (coverageData) break;
                }
              } catch {
                continue;
              }
            }
          }

          if (!coverageData) {
            return {
              passed: true,
              message: 'No coverage report found — skipping coverage check',
              details: 'No coverage report generated',
            };
          }

          // Parse coverage summary
          const total = coverageData.total as Record<string, { pct: number }> | undefined;
          if (!total) {
            return {
              passed: true,
              message: 'Could not parse coverage report — skipping',
              details: 'Invalid coverage report format',
            };
          }

          const lineCoverage = total.lines?.pct ?? 0;
          const branchCoverage = total.branches?.pct ?? 0;
          const functionCoverage = total.functions?.pct ?? 0;
          const statementCoverage = total.statements?.pct ?? 0;

          const actualCoverage = Math.max(
            lineCoverage,
            statementCoverage,
          );

          if (actualCoverage >= minCoverage) {
            return {
              passed: true,
              message: `Test coverage ${actualCoverage.toFixed(1)}% meets minimum ${minCoverage}%`,
              details: `Lines: ${lineCoverage.toFixed(1)}%, Branches: ${branchCoverage.toFixed(1)}%, Functions: ${functionCoverage.toFixed(1)}%, Statements: ${statementCoverage.toFixed(1)}%`,
            };
          }

          return {
            passed: false,
            message: `Test coverage ${actualCoverage.toFixed(1)}% is below minimum ${minCoverage}%`,
            details: `Lines: ${lineCoverage.toFixed(1)}%, Branches: ${branchCoverage.toFixed(1)}%, Functions: ${functionCoverage.toFixed(1)}%, Statements: ${statementCoverage.toFixed(1)}%`,
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            passed: true,
            message: 'Coverage check failed to run — skipping',
            details: errorMsg.substring(0, 500),
          };
        }
      },
    };
  }

  /**
   * Create a TypeScript type check gate — runs tsc --noEmit (for developer mode).
   */
  private createTypeCheckGate(): QualityGate {
    return {
      id: 'typeCheck',
      name: 'TypeScript Type Check',
      description: 'Runs TypeScript type checking to ensure no type errors',
      severity: 'error',
      check: async () => {
        try {
          const cwd = process.cwd();
          const commands = [
            'npx tsc --noEmit',
            'npm run type-check',
            'npm run typecheck',
            'yarn type-check',
            'pnpm type-check',
          ];

          for (const cmd of commands) {
            try {
              const { stdout, stderr } = await execAsync(cmd, {
                cwd,
                timeout: 120000,
                maxBuffer: 1024 * 1024 * 5,
              });

              return {
                passed: true,
                message: 'TypeScript type check passed',
                details: stdout.trim().substring(0, 500) || undefined,
              };
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              // If this command ran (not "not found"), return the error
              if (!errorMsg.includes('not found') && !errorMsg.includes('ENOENT')) {
                return {
                  passed: false,
                  message: 'TypeScript type check failed',
                  details: errorMsg.substring(0, 1000),
                };
              }
              // Command not found, try next
            }
          }

          // Check if tsconfig.json exists
          try {
            await fs.access(path.join(cwd, 'tsconfig.json'));
          } catch {
            return {
              passed: true,
              message: 'No tsconfig.json found — skipping type check',
              details: 'Project does not appear to use TypeScript',
            };
          }

          return {
            passed: false,
            message: 'TypeScript type check failed — all commands failed',
            details: 'Could not find a working TypeScript type check command',
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            passed: false,
            message: 'TypeScript type check failed',
            details: errorMsg.substring(0, 1000),
          };
        }
      },
    };
  }

  /**
   * Create a no-console.log gate — checks for console.log statements (for reviewer mode).
   */
  private createNoConsoleLogsGate(): QualityGate {
    return {
      id: 'noConsoleLogs',
      name: 'No Console Logs',
      description: 'Checks for console.log statements in source files',
      severity: 'warning',
      check: async () => {
        try {
          const cwd = process.cwd();
          // Search for console.log in source files
          const commands = [
            `grep -r "console\\.log" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" src/ 2>/dev/null || true`,
            `grep -r "console\\.log" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git 2>/dev/null || true`,
          ];

          let foundFiles: string[] = [];

          for (const cmd of commands) {
            try {
              const { stdout } = await execAsync(cmd, {
                cwd,
                timeout: 30000,
                maxBuffer: 1024 * 1024 * 5,
              });

              if (stdout.trim()) {
                foundFiles = stdout.trim().split('\n').slice(0, 20);
                break;
              }
            } catch {
              continue;
            }
          }

          if (foundFiles.length === 0) {
            return {
              passed: true,
              message: 'No console.log statements found',
            };
          }

          return {
            passed: false,
            message: `Found ${foundFiles.length} file(s) with console.log statements`,
            details: foundFiles.join('\n').substring(0, 1000),
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            passed: true,
            message: 'Console log check failed to run — skipping',
            details: errorMsg.substring(0, 500),
          };
        }
      },
    };
  }

  /**
   * Create a security scan gate — runs npm audit (for security mode).
   */
  private createSecurityScanGate(): QualityGate {
    return {
      id: 'securityScan',
      name: 'Security Scan',
      description: 'Runs security audit (npm audit) to find vulnerabilities',
      severity: 'error',
      check: async () => {
        try {
          const cwd = process.cwd();
          const thresholds = this.thresholds.get('security') ?? {};
          const maxVulns = thresholds.maxVulnerabilities ?? 0;

          const commands = [
            'npm audit --json',
            'yarn audit --json',
            'pnpm audit --json',
          ];

          let auditOutput: string | null = null;
          let vulnCount = 0;
          let criticalCount = 0;
          let highCount = 0;

          for (const cmd of commands) {
            try {
              const { stdout } = await execAsync(cmd, {
                cwd,
                timeout: 60000,
                maxBuffer: 1024 * 1024 * 5,
              });

              auditOutput = stdout;

              // Parse JSON output
              try {
                const auditData = JSON.parse(stdout) as Record<string, unknown>;

                // npm audit format
                if (auditData.vulnerabilities) {
                  const vulns = auditData.vulnerabilities as Record<string, Record<string, string>>;
                  vulnCount = Object.keys(vulns).length;
                  for (const vuln of Object.values(vulns)) {
                    if (vuln.severity === 'critical') criticalCount++;
                    if (vuln.severity === 'high') highCount++;
                  }
                }

                // yarn audit format
                if (auditData.data?.vulnerabilities) {
                  const vulns = auditData.data.vulnerabilities as Array<{ severity: string }>;
                  vulnCount = vulns.length;
                  for (const vuln of vulns) {
                    if (vuln.severity === 'critical') criticalCount++;
                    if (vuln.severity === 'high') highCount++;
                  }
                }
              } catch {
                // Non-JSON output, count by parsing text
                const criticalMatches = stdout.match(/critical/gi);
                const highMatches = stdout.match(/high severity/gi);
                criticalCount = criticalMatches?.length ?? 0;
                highCount = highMatches?.length ?? 0;
                vulnCount = criticalCount + highCount;
              }

              break;
            } catch {
              continue;
            }
          }

          if (auditOutput === null) {
            return {
              passed: true,
              message: 'No package manager audit found — skipping security scan',
              details: 'npm, yarn, and pnpm audit commands all failed',
            };
          }

          const effectiveVulnCount = criticalCount + highCount;
          if (effectiveVulnCount <= maxVulns) {
            return {
              passed: true,
              message: `Security scan passed (${vulnCount} total vulnerabilities, ${criticalCount} critical, ${highCount} high)`,
              details: `Critical: ${criticalCount}, High: ${highCount}, Total: ${vulnCount}`,
            };
          }

          return {
            passed: false,
            message: `Security scan found ${effectiveVulnCount} critical/high vulnerabilities (max allowed: ${maxVulns})`,
            details: `Critical: ${criticalCount}, High: ${highCount}, Total: ${vulnCount}`,
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            passed: true,
            message: 'Security scan failed to run — skipping',
            details: errorMsg.substring(0, 500),
          };
        }
      },
    };
  }

  /**
   * Create a build check gate — verifies project builds (for devops mode).
   */
  private createBuildCheckGate(): QualityGate {
    return {
      id: 'buildCheck',
      name: 'Build Check',
      description: 'Verifies the project builds successfully',
      severity: 'error',
      check: async () => {
        try {
          const cwd = process.cwd();
          const thresholds = this.thresholds.get('devops') ?? {};
          const buildCommand = thresholds.buildCommand;

          const commands = buildCommand
            ? [buildCommand]
            : [
                'npm run build',
                'yarn build',
                'pnpm build',
                'npm run compile',
                'make',
              ];

          for (const cmd of commands) {
            try {
              const { stdout, stderr } = await execAsync(cmd, {
                cwd,
                timeout: 300000, // 5 minutes
                maxBuffer: 1024 * 1024 * 10,
              });

              return {
                passed: true,
                message: 'Build check passed',
                details: stdout.trim().substring(0, 500) || undefined,
              };
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              // If the command ran but failed, this is a real build failure
              if (!errorMsg.includes('not found') && !errorMsg.includes('ENOENT')) {
                return {
                  passed: false,
                  message: 'Build check failed',
                  details: errorMsg.substring(0, 1000),
                };
              }
              // Command not found, try next
            }
          }

          return {
            passed: true,
            message: 'No build command found — skipping build check',
            details: 'No build script found in package.json or Makefile',
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            passed: false,
            message: 'Build check failed',
            details: errorMsg.substring(0, 1000),
          };
        }
      },
    };
  }
}
