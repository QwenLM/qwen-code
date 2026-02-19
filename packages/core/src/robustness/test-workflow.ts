/**
 * Copyright (c) 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Test result from running tests
 */
export interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration: number; // milliseconds
  failures: TestFailure[];
  coverage?: CoverageData;
}

/**
 * Individual test failure
 */
export interface TestFailure {
  testName: string;
  testFile: string;
  error: string;
  stack?: string;
}

/**
 * Code coverage data
 */
export interface CoverageData {
  lines: {
    total: number;
    covered: number;
    percentage: number;
  };
  branches: {
    total: number;
    covered: number;
    percentage: number;
  };
  functions: {
    total: number;
    covered: number;
    percentage: number;
  };
  statements: {
    total: number;
    covered: number;
    percentage: number;
  };
}

/**
 * Coverage report for specific files
 */
export interface CoverageReport {
  overall: CoverageData;
  byFile: Map<string, CoverageData>;
  uncoveredLines: Map<string, number[]>;
}

/**
 * Test baseline captured before changes
 */
export interface TestBaseline {
  timestamp: Date;
  files: string[];
  testResults: TestResult;
  coverage: CoverageReport;
  relatedTests: string[];
}

/**
 * Generated test suggestion
 */
export interface GeneratedTest {
  fileName: string;
  content: string;
  reasoning: string;
  coverageImprovement: number; // percentage
}

/**
 * Test-driven development workflow
 */
export class TestDrivenWorkflow {
  private projectRoot: string;
  private testCommand: string;
  private coverageCommand: string;

  constructor(
    projectRoot: string,
    testCommand = 'npm test',
    coverageCommand = 'npm run test:coverage',
  ) {
    this.projectRoot = projectRoot;
    this.testCommand = testCommand;
    this.coverageCommand = coverageCommand;
  }

  /**
   * Capture test baseline before code changes
   */
  async beforeCodeChange(files: string[]): Promise<TestBaseline> {
    // Identify related tests
    const relatedTests = await this.findRelatedTests(files);

    // Run tests and capture results
    const testResults = await this.runTests(relatedTests);

    // Capture coverage
    const coverage = await this.getCoverageReport();

    const baseline: TestBaseline = {
      timestamp: new Date(),
      files,
      testResults,
      coverage,
      relatedTests,
    };

    // Save baseline
    await this.saveBaseline(baseline);

    return baseline;
  }

  /**
   * Validate changes after code modification
   */
  async afterCodeChange(
    files: string[],
    baseline: TestBaseline,
  ): Promise<TestResult> {
    // Run tests again
    const newResults = await this.runTests(baseline.relatedTests);

    // Compare with baseline
    const comparison = this.compareResults(baseline.testResults, newResults);

    // Check for regressions
    if (comparison.hasRegressions) {
      // Suggest fixes
      const _fixes = await this.suggestFixes(comparison.regressions);
    }

    return newResults;
  }

  /**
   * Find tests related to specific files
   */
  private async findRelatedTests(files: string[]): Promise<string[]> {
    const relatedTests: Set<string> = new Set();

    for (const file of files) {
      // Strategy 1: Look for test files with same name
      const testFile = this.getTestFileName(file);
      try {
        await fs.access(testFile);
        relatedTests.add(testFile);
      } catch {
        // Test file doesn't exist
      }

      // Strategy 2: Search for imports in test files
      const allTestFiles = await this.findAllTestFiles();

      for (const testFile of allTestFiles) {
        try {
          const content = await fs.readFile(testFile, 'utf-8');
          const relativePath = path.relative(path.dirname(testFile), file);

          if (
            content.includes(relativePath) ||
            content.includes(path.basename(file))
          ) {
            relatedTests.add(testFile);
          }
        } catch {
          // Skip files that can't be read
        }
      }
    }

    return Array.from(relatedTests);
  }

  /**
   * Get test file name for a source file
   */
  private getTestFileName(sourceFile: string): string {
    const ext = path.extname(sourceFile);
    const base = sourceFile.slice(0, -ext.length);

    // Try common test file patterns
    const patterns = [
      `${base}.test${ext}`,
      `${base}.spec${ext}`,
      `${base}Test${ext}`,
      `${base}Spec${ext}`,
    ];

    return patterns[0]; // Default to .test pattern
  }

  /**
   * Find all test files in project
   */
  private async findAllTestFiles(): Promise<string[]> {
    const { stdout } = await execAsync(
      `find ${this.projectRoot} -type f \\( -name "*.test.*" -o -name "*.spec.*" \\) -not -path "*/node_modules/*"`,
    );

    return stdout.split('\n').filter((line) => line.trim().length > 0);
  }

  /**
   * Run tests
   */
  private async runTests(testFiles?: string[]): Promise<TestResult> {
    try {
      let command = this.testCommand;

      if (testFiles && testFiles.length > 0) {
        command += ` ${testFiles.join(' ')}`;
      }

      const { stdout, stderr } = await execAsync(command, {
        cwd: this.projectRoot,
      });

      return this.parseTestOutput(stdout + stderr);
    } catch (_error) {
      // Tests failed
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const output =
          (error as unknown & { stdout: string; stderr: string }).stdout +
          (error as unknown & { stdout: string; stderr: string }).stderr;
        return this.parseTestOutput(output);
      }

      return {
        passed: 0,
        failed: 1,
        skipped: 0,
        total: 1,
        duration: 0,
        failures: [
          {
            testName: 'Test execution',
            testFile: '',
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  /**
   * Parse test output to extract results
   */
  private parseTestOutput(output: string): TestResult {
    // This is a simplified parser - real implementation would handle
    // different test frameworks (Jest, Vitest, Mocha, etc.)

    const result: TestResult = {
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      duration: 0,
      failures: [],
    };

    // Extract test counts
    const passedMatch = output.match(/(\d+)\s+passed/i);
    const failedMatch = output.match(/(\d+)\s+failed/i);
    const skippedMatch = output.match(/(\d+)\s+skipped/i);

    if (passedMatch) result.passed = parseInt(passedMatch[1], 10);
    if (failedMatch) result.failed = parseInt(failedMatch[1], 10);
    if (skippedMatch) result.skipped = parseInt(skippedMatch[1], 10);

    result.total = result.passed + result.failed + result.skipped;

    // Extract duration
    const durationMatch = output.match(/Time:\s+(\d+\.?\d*)\s*m?s/i);
    if (durationMatch) {
      result.duration = parseFloat(durationMatch[1]);
      if (output.includes('ms')) {
        // Already in milliseconds
      } else {
        result.duration *= 1000; // Convert seconds to milliseconds
      }
    }

    // Extract failures
    const failureBlocks = output.split(/FAIL|✕/).slice(1);
    for (const block of failureBlocks) {
      const lines = block.split('\n');
      const testName = lines[0]?.trim() || 'Unknown test';
      const error = lines.slice(1).join('\n').trim();

      result.failures.push({
        testName,
        testFile: '',
        error,
      });
    }

    return result;
  }

  /**
   * Get coverage report
   */
  private async getCoverageReport(): Promise<CoverageReport> {
    try {
      const { stdout } = await execAsync(this.coverageCommand, {
        cwd: this.projectRoot,
      });

      return this.parseCoverageOutput(stdout);
    } catch (_error) {
      // Coverage not available
      return {
        overall: {
          lines: { total: 0, covered: 0, percentage: 0 },
          branches: { total: 0, covered: 0, percentage: 0 },
          functions: { total: 0, covered: 0, percentage: 0 },
          statements: { total: 0, covered: 0, percentage: 0 },
        },
        byFile: new Map(),
        uncoveredLines: new Map(),
      };
    }
  }

  /**
   * Parse coverage output
   */
  private parseCoverageOutput(output: string): CoverageReport {
    // Simplified parser - would need to handle different coverage formats
    const report: CoverageReport = {
      overall: {
        lines: { total: 0, covered: 0, percentage: 0 },
        branches: { total: 0, covered: 0, percentage: 0 },
        functions: { total: 0, covered: 0, percentage: 0 },
        statements: { total: 0, covered: 0, percentage: 0 },
      },
      byFile: new Map(),
      uncoveredLines: new Map(),
    };

    // Extract overall coverage percentage
    const coverageMatch = output.match(/All files\s+\|\s+([\d.]+)/);
    if (coverageMatch) {
      report.overall.lines.percentage = parseFloat(coverageMatch[1]);
    }

    return report;
  }

  /**
   * Compare test results
   */
  private compareResults(
    baseline: TestResult,
    current: TestResult,
  ): {
    hasRegressions: boolean;
    regressions: TestFailure[];
    improvements: number;
  } {
    const regressions: TestFailure[] = [];

    // Check for new failures
    if (current.failed > baseline.failed) {
      regressions.push(...current.failures);
    }

    // Check for previously passing tests that now fail
    for (const failure of current.failures) {
      const wasPassingBefore = !baseline.failures.some(
        (f) => f.testName === failure.testName,
      );

      if (wasPassingBefore) {
        regressions.push(failure);
      }
    }

    const improvements = current.passed - baseline.passed;

    return {
      hasRegressions: regressions.length > 0,
      regressions,
      improvements,
    };
  }

  /**
   * Suggest fixes for test failures
   */
  private async suggestFixes(failures: TestFailure[]): Promise<string[]> {
    const suggestions: string[] = [];

    for (const failure of failures) {
      // Analyze error message
      if (failure.error.includes('TypeError')) {
        suggestions.push(
          `Fix type error in ${failure.testName}: Check type definitions and interfaces`,
        );
      } else if (failure.error.includes('undefined')) {
        suggestions.push(
          `Fix undefined error in ${failure.testName}: Ensure all variables are properly initialized`,
        );
      } else if (failure.error.includes('expected')) {
        suggestions.push(
          `Fix assertion in ${failure.testName}: Update expected values or fix implementation`,
        );
      } else {
        suggestions.push(
          `Review ${failure.testName}: ${failure.error.slice(0, 100)}...`,
        );
      }
    }

    return suggestions;
  }

  /**
   * Generate missing tests for uncovered code
   */
  async generateMissingTests(
    code: string,
    coverage: CoverageReport,
  ): Promise<GeneratedTest[]> {
    const tests: GeneratedTest[] = [];

    // Find uncovered files
    const uncoveredFiles = Array.from(coverage.uncoveredLines.keys());

    for (const file of uncoveredFiles.slice(0, 5)) {
      // Limit to 5 files
      try {
        const content = await fs.readFile(file, 'utf-8');

        // Extract functions that need testing
        const functions = this.extractFunctions(content);

        for (const func of functions) {
          const testContent = this.generateTestTemplate(file, func);

          tests.push({
            fileName: this.getTestFileName(file),
            content: testContent,
            reasoning: `Function '${func.name}' is not covered by tests`,
            coverageImprovement: 10, // Estimated
          });
        }
      } catch {
        // Skip files that can't be read
      }
    }

    return tests;
  }

  /**
   * Extract functions from code
   */
  private extractFunctions(
    code: string,
  ): Array<{ name: string; params: string[] }> {
    const functions: Array<{ name: string; params: string[] }> = [];

    // Simple regex-based extraction
    const functionPattern =
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
    let match;

    while ((match = functionPattern.exec(code)) !== null) {
      functions.push({
        name: match[1],
        params: match[2]
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0),
      });
    }

    return functions;
  }

  /**
   * Generate test template for a function
   */
  private generateTestTemplate(
    file: string,
    func: { name: string; params: string[] },
  ): string {
    const imports = `import { ${func.name} } from './${path.basename(file, path.extname(file))}';`;

    return `${imports}

describe('${func.name}', () => {
  test('should work correctly', () => {
    // TODO: Implement test
    const result = ${func.name}(${func.params.map(() => 'undefined').join(', ')});
    expect(result).toBeDefined();
  });

  test('should handle edge cases', () => {
    // TODO: Implement edge case tests
  });
});
`;
  }

  /**
   * Save baseline to file
   */
  private async saveBaseline(baseline: TestBaseline): Promise<void> {
    const baselinePath = path.join(
      this.projectRoot,
      '.qwen-code',
      'test-baseline.json',
    );

    try {
      await fs.mkdir(path.dirname(baselinePath), { recursive: true });
      await fs.writeFile(
        baselinePath,
        JSON.stringify(baseline, null, 2),
        'utf-8',
      );
    } catch (_error) {
      // Silently ignore write errors
    }
  }

  /**
   * Load baseline from file
   */
  async loadBaseline(): Promise<TestBaseline | null> {
    const baselinePath = path.join(
      this.projectRoot,
      '.qwen-code',
      'test-baseline.json',
    );

    try {
      const content = await fs.readFile(baselinePath, 'utf-8');
      const data = JSON.parse(content);

      // Convert date string back to Date
      data.timestamp = new Date(data.timestamp);

      return data;
    } catch {
      return null;
    }
  }
}

/**
 * Create a new test-driven workflow instance
 */
export function createTestDrivenWorkflow(
  projectRoot: string,
  testCommand?: string,
  coverageCommand?: string,
): TestDrivenWorkflow {
  return new TestDrivenWorkflow(projectRoot, testCommand, coverageCommand);
}
