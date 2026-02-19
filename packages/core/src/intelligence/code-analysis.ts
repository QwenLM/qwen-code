/**
 * Copyright (c) 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';

/**
 * Code smell detected in the code
 */
export interface CodeSmell {
  type:
    | 'long-method'
    | 'large-class'
    | 'duplicate-code'
    | 'dead-code'
    | 'complex-conditional'
    | 'god-object'
    | 'feature-envy';
  severity: 'low' | 'medium' | 'high';
  location: {
    file: string;
    line: number;
    column?: number;
  };
  description: string;
  suggestion: string;
}

/**
 * Quality metrics for code
 */
export interface QualityMetrics {
  complexity: number; // Cyclomatic complexity
  maintainability: number; // 0-100, higher is better
  duplication: number; // Percentage of duplicated code
  linesOfCode: number;
  codeSmells: CodeSmell[];
}

/**
 * Complete quality report
 */
export interface QualityReport {
  overall: QualityMetrics;
  byFile: Map<string, QualityMetrics>;
  summary: {
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
    recommendations: string[];
  };
}

/**
 * Security vulnerability
 */
export interface SecurityVulnerability {
  type:
    | 'sql-injection'
    | 'xss'
    | 'csrf'
    | 'secret-exposure'
    | 'dependency-vulnerability'
    | 'insecure-crypto'
    | 'path-traversal'
    | 'command-injection'
    | 'insecure-deserialization';
  severity: 'low' | 'medium' | 'high' | 'critical';
  location: {
    file: string;
    line: number;
    snippet?: string;
  };
  description: string;
  remediation: string;
  cwe?: string; // Common Weakness Enumeration ID
  cvss?: number; // Common Vulnerability Scoring System
}

/**
 * Security analysis report
 */
export interface SecurityReport {
  vulnerabilities: SecurityVulnerability[];
  score: number; // 0-100, higher is better
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  summary: {
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    recommendations: string[];
  };
}

/**
 * Performance bottleneck
 */
export interface PerformanceBottleneck {
  type:
    | 'n-plus-one'
    | 'inefficient-loop'
    | 'blocking-io'
    | 'memory-leak'
    | 'unnecessary-render'
    | 'large-bundle'
    | 'unoptimized-query';
  severity: 'low' | 'medium' | 'high';
  location: {
    file: string;
    line: number;
    function?: string;
  };
  description: string;
  impact: string;
  optimization: string;
}

/**
 * Performance analysis report
 */
export interface PerformanceReport {
  bottlenecks: PerformanceBottleneck[];
  metrics: {
    estimatedComplexity: string; // O(n), O(n²), etc.
    memoryUsage: 'low' | 'medium' | 'high';
    ioOperations: number;
  };
  recommendations: string[];
}

/**
 * Code intelligence for quality, security, and performance analysis
 */
export class CodeIntelligence {
  /**
   * Analyze code quality
   */
  async analyzeQuality(files: string[]): Promise<QualityReport> {
    const fileMetrics = new Map<string, QualityMetrics>();
    let totalComplexity = 0;
    let totalLoc = 0;
    const allCodeSmells: CodeSmell[] = [];

    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const metrics = await this.analyzeFileQuality(file, content);

        fileMetrics.set(file, metrics);
        totalComplexity += metrics.complexity;
        totalLoc += metrics.linesOfCode;
        allCodeSmells.push(...metrics.codeSmells);
      } catch (_error) {
        // Skip files that can't be read
      }
    }

    const avgComplexity = files.length > 0 ? totalComplexity / files.length : 0;
    const maintainability = this.calculateMaintainability(
      avgComplexity,
      totalLoc,
      allCodeSmells.length,
    );

    const overall: QualityMetrics = {
      complexity: avgComplexity,
      maintainability,
      duplication: 0, // Would need duplicate code detection
      linesOfCode: totalLoc,
      codeSmells: allCodeSmells,
    };

    const grade = this.calculateGrade(maintainability);
    const recommendations = this.generateQualityRecommendations(overall);

    return {
      overall,
      byFile: fileMetrics,
      summary: {
        grade,
        recommendations,
      },
    };
  }

  /**
   * Analyze quality of a single file
   */
  private async analyzeFileQuality(
    filePath: string,
    content: string,
  ): Promise<QualityMetrics> {
    const lines = content.split('\n');
    const linesOfCode = lines.filter(
      (line) => line.trim().length > 0 && !line.trim().startsWith('//'),
    ).length;

    // Calculate cyclomatic complexity
    const complexity = this.calculateComplexity(content);

    // Detect code smells
    const codeSmells = this.detectCodeSmells(filePath, content, lines);

    const maintainability = this.calculateMaintainability(
      complexity,
      linesOfCode,
      codeSmells.length,
    );

    return {
      complexity,
      maintainability,
      duplication: 0,
      linesOfCode,
      codeSmells,
    };
  }

  /**
   * Calculate cyclomatic complexity
   */
  private calculateComplexity(content: string): number {
    let complexity = 1; // Base complexity

    // Count decision points
    const decisionKeywords = [
      /\bif\s*\(/g,
      /\belse\s+if\s*\(/g,
      /\bfor\s*\(/g,
      /\bwhile\s*\(/g,
      /\bcase\s+/g,
      /\bcatch\s*\(/g,
      /&&/g,
      /\|\|/g,
      /\?/g,
    ];

    for (const keyword of decisionKeywords) {
      const matches = content.match(keyword);
      if (matches) {
        complexity += matches.length;
      }
    }

    return complexity;
  }

  /**
   * Detect code smells
   */
  private detectCodeSmells(
    filePath: string,
    content: string,
    lines: string[],
  ): CodeSmell[] {
    const smells: CodeSmell[] = [];

    // Detect long methods
    const functions = this.extractFunctions(content);
    for (const func of functions) {
      if (func.lineCount > 50) {
        smells.push({
          type: 'long-method',
          severity: func.lineCount > 100 ? 'high' : 'medium',
          location: {
            file: filePath,
            line: func.startLine,
          },
          description: `Function '${func.name}' has ${func.lineCount} lines`,
          suggestion:
            'Consider breaking this function into smaller, focused functions',
        });
      }
    }

    // Detect large classes
    const classes = this.extractClasses(content);
    for (const cls of classes) {
      if (cls.methodCount > 20) {
        smells.push({
          type: 'large-class',
          severity: cls.methodCount > 30 ? 'high' : 'medium',
          location: {
            file: filePath,
            line: cls.startLine,
          },
          description: `Class '${cls.name}' has ${cls.methodCount} methods`,
          suggestion:
            'Consider splitting this class into smaller, focused classes',
        });
      }
    }

    // Detect complex conditionals
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const conditions = (line.match(/&&|\|\|/g) || []).length;

      if (conditions >= 3) {
        smells.push({
          type: 'complex-conditional',
          severity: conditions >= 5 ? 'high' : 'medium',
          location: {
            file: filePath,
            line: i + 1,
          },
          description: 'Complex conditional with multiple logical operators',
          suggestion: 'Extract conditions into well-named boolean variables',
        });
      }
    }

    // Detect dead code (simplified)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        line.trim().startsWith('//') &&
        (line.includes('TODO') || line.includes('FIXME'))
      ) {
        smells.push({
          type: 'dead-code',
          severity: 'low',
          location: {
            file: filePath,
            line: i + 1,
          },
          description: 'TODO/FIXME comment indicates incomplete code',
          suggestion: 'Complete or remove this code',
        });
      }
    }

    return smells;
  }

  /**
   * Extract functions from code
   */
  private extractFunctions(
    content: string,
  ): Array<{ name: string; startLine: number; lineCount: number }> {
    const functions: Array<{
      name: string;
      startLine: number;
      lineCount: number;
    }> = [];

    const lines = content.split('\n');
    const functionPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/;

    let currentFunction: { name: string; startLine: number } | null = null;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (functionPattern.test(line) && !currentFunction) {
        const match = line.match(functionPattern);
        if (match) {
          currentFunction = {
            name: match[1],
            startLine: i + 1,
          };
        }
      }

      if (currentFunction) {
        braceDepth += (line.match(/{/g) || []).length;
        braceDepth -= (line.match(/}/g) || []).length;

        if (braceDepth === 0 && line.includes('}')) {
          functions.push({
            name: currentFunction.name,
            startLine: currentFunction.startLine,
            lineCount: i - currentFunction.startLine + 1,
          });
          currentFunction = null;
        }
      }
    }

    return functions;
  }

  /**
   * Extract classes from code
   */
  private extractClasses(
    content: string,
  ): Array<{ name: string; startLine: number; methodCount: number }> {
    const classes: Array<{
      name: string;
      startLine: number;
      methodCount: number;
    }> = [];

    const lines = content.split('\n');
    const classPattern = /class\s+(\w+)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (classPattern.test(line)) {
        const match = line.match(classPattern);
        if (match) {
          // Count methods in class (simplified)
          let braceDepth = 0;
          let methodCount = 0;
          let j = i;

          while (j < lines.length) {
            braceDepth += (lines[j].match(/{/g) || []).length;
            braceDepth -= (lines[j].match(/}/g) || []).length;

            if (lines[j].match(/\w+\s*\([^)]*\)\s*{/)) {
              methodCount++;
            }

            if (braceDepth === 0 && lines[j].includes('}')) {
              break;
            }
            j++;
          }

          classes.push({
            name: match[1],
            startLine: i + 1,
            methodCount,
          });
        }
      }
    }

    return classes;
  }

  /**
   * Calculate maintainability index
   */
  private calculateMaintainability(
    complexity: number,
    loc: number,
    codeSmellCount: number,
  ): number {
    // Simplified maintainability calculation
    let score = 100;

    // Penalize complexity
    score -= Math.min(complexity * 2, 40);

    // Penalize large codebases
    score -= Math.min((loc / 1000) * 5, 20);

    // Penalize code smells
    score -= Math.min(codeSmellCount * 3, 30);

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Calculate grade from maintainability
   */
  private calculateGrade(maintainability: number): 'A' | 'B' | 'C' | 'D' | 'F' {
    if (maintainability >= 85) return 'A';
    if (maintainability >= 70) return 'B';
    if (maintainability >= 50) return 'C';
    if (maintainability >= 25) return 'D';
    return 'F';
  }

  /**
   * Generate quality recommendations
   */
  private generateQualityRecommendations(metrics: QualityMetrics): string[] {
    const recommendations: string[] = [];

    if (metrics.complexity > 20) {
      recommendations.push(
        'Reduce cyclomatic complexity by breaking down complex functions',
      );
    }

    if (metrics.maintainability < 50) {
      recommendations.push(
        'Improve code maintainability by addressing code smells and reducing complexity',
      );
    }

    const longMethods = metrics.codeSmells.filter(
      (s) => s.type === 'long-method',
    );
    if (longMethods.length > 0) {
      recommendations.push(
        `Refactor ${longMethods.length} long method(s) into smaller functions`,
      );
    }

    const largeClasses = metrics.codeSmells.filter(
      (s) => s.type === 'large-class',
    );
    if (largeClasses.length > 0) {
      recommendations.push(
        `Split ${largeClasses.length} large class(es) into smaller, focused classes`,
      );
    }

    return recommendations;
  }

  /**
   * Scan for security vulnerabilities
   */
  async scanSecurity(files: string[]): Promise<SecurityReport> {
    const vulnerabilities: SecurityVulnerability[] = [];

    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const fileVulns = await this.scanFileForVulnerabilities(file, content);
        vulnerabilities.push(...fileVulns);
      } catch (_error) {
        // Skip files that can't be read
      }
    }

    const criticalCount = vulnerabilities.filter(
      (v) => v.severity === 'critical',
    ).length;
    const highCount = vulnerabilities.filter(
      (v) => v.severity === 'high',
    ).length;
    const mediumCount = vulnerabilities.filter(
      (v) => v.severity === 'medium',
    ).length;
    const lowCount = vulnerabilities.filter((v) => v.severity === 'low').length;

    // Calculate security score
    const score = Math.max(
      0,
      100 -
        criticalCount * 25 -
        highCount * 10 -
        mediumCount * 5 -
        lowCount * 2,
    );

    let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
    if (criticalCount > 0) riskLevel = 'critical';
    else if (highCount > 0) riskLevel = 'high';
    else if (mediumCount > 0) riskLevel = 'medium';

    const recommendations =
      this.generateSecurityRecommendations(vulnerabilities);

    return {
      vulnerabilities,
      score,
      riskLevel,
      summary: {
        criticalCount,
        highCount,
        mediumCount,
        lowCount,
        recommendations,
      },
    };
  }

  /**
   * Scan a file for security vulnerabilities
   */
  private async scanFileForVulnerabilities(
    filePath: string,
    content: string,
  ): Promise<SecurityVulnerability[]> {
    const vulnerabilities: SecurityVulnerability[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // SQL Injection detection
      if (line.match(/execute\s*\([^)]*\+|query\s*\([^)]*\+/i)) {
        vulnerabilities.push({
          type: 'sql-injection',
          severity: 'critical',
          location: { file: filePath, line: lineNum, snippet: line.trim() },
          description: 'Potential SQL injection vulnerability',
          remediation:
            'Use parameterized queries instead of string concatenation',
          cwe: 'CWE-89',
          cvss: 9.8,
        });
      }

      // XSS detection
      if (line.match(/innerHTML\s*=|dangerouslySetInnerHTML/)) {
        vulnerabilities.push({
          type: 'xss',
          severity: 'high',
          location: { file: filePath, line: lineNum, snippet: line.trim() },
          description: 'Potential XSS vulnerability',
          remediation: 'Sanitize user input before rendering',
          cwe: 'CWE-79',
          cvss: 7.3,
        });
      }

      // Secret exposure
      if (
        line.match(
          /password\s*=\s*["'][^"']+["']|api[_-]?key\s*=\s*["'][^"']+["']/i,
        )
      ) {
        vulnerabilities.push({
          type: 'secret-exposure',
          severity: 'critical',
          location: { file: filePath, line: lineNum },
          description: 'Hardcoded secret detected',
          remediation: 'Use environment variables for secrets',
          cwe: 'CWE-798',
          cvss: 9.1,
        });
      }

      // Command injection
      if (line.match(/exec\s*\(|system\s*\(|eval\s*\(/)) {
        vulnerabilities.push({
          type: 'command-injection',
          severity: 'high',
          location: { file: filePath, line: lineNum, snippet: line.trim() },
          description: 'Potential command injection',
          remediation: 'Avoid exec/eval or sanitize inputs',
          cwe: 'CWE-78',
          cvss: 8.8,
        });
      }

      // Insecure crypto
      if (line.match(/MD5|SHA1/i) && !line.includes('//')) {
        vulnerabilities.push({
          type: 'insecure-crypto',
          severity: 'medium',
          location: { file: filePath, line: lineNum, snippet: line.trim() },
          description: 'Use of weak cryptographic algorithm',
          remediation: 'Use SHA-256 or stronger algorithms',
          cwe: 'CWE-327',
        });
      }
    }

    return vulnerabilities;
  }

  /**
   * Generate security recommendations
   */
  private generateSecurityRecommendations(
    vulnerabilities: SecurityVulnerability[],
  ): string[] {
    const recommendations: string[] = [];

    const criticalVulns = vulnerabilities.filter(
      (v) => v.severity === 'critical',
    );
    if (criticalVulns.length > 0) {
      recommendations.push(
        `Fix ${criticalVulns.length} critical vulnerabilities immediately`,
      );
    }

    const sqlInjections = vulnerabilities.filter(
      (v) => v.type === 'sql-injection',
    );
    if (sqlInjections.length > 0) {
      recommendations.push(
        'Implement parameterized queries for database access',
      );
    }

    const secrets = vulnerabilities.filter((v) => v.type === 'secret-exposure');
    if (secrets.length > 0) {
      recommendations.push('Move all secrets to environment variables');
    }

    return recommendations;
  }

  /**
   * Profile code for performance issues
   */
  async profilePerformance(files: string[]): Promise<PerformanceReport> {
    const bottlenecks: PerformanceBottleneck[] = [];
    let totalIoOps = 0;

    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const fileBottlenecks = await this.analyzePerformance(file, content);
        bottlenecks.push(...fileBottlenecks);

        // Count I/O operations
        const ioOps = (content.match(/await\s+fs\.|readFile|writeFile/g) || [])
          .length;
        totalIoOps += ioOps;
      } catch (_error) {
        // Skip files that can't be read
      }
    }

    const recommendations =
      this.generatePerformanceRecommendations(bottlenecks);

    return {
      bottlenecks,
      metrics: {
        estimatedComplexity: 'O(n)', // Simplified
        memoryUsage: totalIoOps > 10 ? 'high' : 'medium',
        ioOperations: totalIoOps,
      },
      recommendations,
    };
  }

  /**
   * Analyze performance of a single file
   */
  private async analyzePerformance(
    filePath: string,
    content: string,
  ): Promise<PerformanceBottleneck[]> {
    const bottlenecks: PerformanceBottleneck[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Nested loops
      if (line.includes('for') || line.includes('while')) {
        const nextLines = lines.slice(i, i + 10).join('\n');
        const nestedLoops = (nextLines.match(/for\s*\(|while\s*\(/g) || [])
          .length;

        if (nestedLoops >= 2) {
          bottlenecks.push({
            type: 'inefficient-loop',
            severity: nestedLoops >= 3 ? 'high' : 'medium',
            location: { file: filePath, line: lineNum },
            description: 'Nested loops detected',
            impact: `O(n^${nestedLoops}) complexity`,
            optimization: 'Consider using hash maps or optimized algorithms',
          });
        }
      }

      // Blocking I/O
      if (line.match(/readFileSync|writeFileSync/) && !line.includes('//')) {
        bottlenecks.push({
          type: 'blocking-io',
          severity: 'medium',
          location: { file: filePath, line: lineNum },
          description: 'Synchronous I/O operation',
          impact: 'Blocks event loop',
          optimization: 'Use async/await instead',
        });
      }

      // Unnecessary re-renders (React)
      if (line.includes('useState') || line.includes('useEffect')) {
        // Simplified check
        const nextLines = lines.slice(i, i + 5).join('\n');
        const matches = nextLines.match(/set\w+\([^)]*\)/g);
        if (matches && matches.length > 2) {
          bottlenecks.push({
            type: 'unnecessary-render',
            severity: 'low',
            location: { file: filePath, line: lineNum },
            description: 'Potential unnecessary re-renders',
            impact: 'Performance degradation in React components',
            optimization: 'Use useMemo or useCallback',
          });
        }
      }
    }

    return bottlenecks;
  }

  /**
   * Generate performance recommendations
   */
  private generatePerformanceRecommendations(
    bottlenecks: PerformanceBottleneck[],
  ): string[] {
    const recommendations: string[] = [];

    const inefficientLoops = bottlenecks.filter(
      (b) => b.type === 'inefficient-loop',
    );
    if (inefficientLoops.length > 0) {
      recommendations.push(
        'Optimize nested loops using hash maps or better algorithms',
      );
    }

    const blockingIo = bottlenecks.filter((b) => b.type === 'blocking-io');
    if (blockingIo.length > 0) {
      recommendations.push('Replace synchronous I/O with async operations');
    }

    return recommendations;
  }
}

/**
 * Create a new code intelligence instance
 */
export function createCodeIntelligence(): CodeIntelligence {
  return new CodeIntelligence();
}
