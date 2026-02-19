/**
 * Copyright (c) 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Code convention and style preferences
 */
export interface CodeConvention {
  category: 'naming' | 'formatting' | 'structure' | 'testing' | 'documentation';
  rule: string;
  examples: string[];
  confidence: number; // 0-1, how confident we are about this convention
}

/**
 * Architecture Decision Record
 */
export interface TechnicalDecision {
  id: string;
  title: string;
  date: Date;
  status: 'proposed' | 'accepted' | 'deprecated' | 'superseded';
  context: string;
  decision: string;
  consequences: string[];
  alternatives?: string[];
}

/**
 * Known issue in the codebase
 */
export interface KnownIssue {
  id: string;
  type: 'bug' | 'technical-debt' | 'performance' | 'security' | 'maintenance';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  location: string;
  firstSeen: Date;
  lastSeen: Date;
  occurrences: number;
  relatedFiles: string[];
}

/**
 * Performance metrics and baselines
 */
export interface PerformanceMetrics {
  buildTime: number; // milliseconds
  testTime: number; // milliseconds
  bundleSize: number; // bytes
  startupTime: number; // milliseconds
  memoryUsage: number; // bytes
  timestamp: Date;
}

/**
 * User interaction session
 */
export interface UserSession {
  id: string;
  timestamp: Date;
  task: string;
  filesModified: string[];
  commandsExecuted: string[];
  success: boolean;
  duration: number; // milliseconds
  feedback?: string;
}

/**
 * Suggestion for improvement
 */
export interface Suggestion {
  id: string;
  type:
    | 'refactoring'
    | 'optimization'
    | 'security'
    | 'testing'
    | 'documentation';
  priority: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  reasoning: string;
  affectedFiles: string[];
  estimatedImpact: 'small' | 'medium' | 'large';
  confidence: number; // 0-1
}

/**
 * Project memory structure
 */
export interface ProjectMemory {
  architecture: {
    patterns: string[];
    conventions: CodeConvention[];
    criticalPaths: string[];
  };
  decisions: TechnicalDecision[];
  knownIssues: KnownIssue[];
  performanceBaselines: PerformanceMetrics[];
  userSessions: UserSession[];
  suggestions: Suggestion[];
  metadata: {
    projectRoot: string;
    lastUpdated: Date;
    totalSessions: number;
  };
}

/**
 * Manages project memory and learning
 */
export class MemoryManager {
  private memory: ProjectMemory;
  private memoryPath: string;

  constructor(projectRoot: string) {
    this.memoryPath = path.join(projectRoot, '.qwen-code', 'memory.json');
    this.memory = {
      architecture: {
        patterns: [],
        conventions: [],
        criticalPaths: [],
      },
      decisions: [],
      knownIssues: [],
      performanceBaselines: [],
      userSessions: [],
      suggestions: [],
      metadata: {
        projectRoot,
        lastUpdated: new Date(),
        totalSessions: 0,
      },
    };
  }

  /**
   * Load memory from disk
   */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.memoryPath, 'utf-8');
      const data = JSON.parse(content);

      // Convert date strings back to Date objects
      data.metadata.lastUpdated = new Date(data.metadata.lastUpdated);
      data.decisions = data.decisions.map((d: unknown) => ({
        ...d,
        date: new Date(d.date),
      }));
      data.knownIssues = data.knownIssues.map((i: unknown) => ({
        ...i,
        firstSeen: new Date(i.firstSeen),
        lastSeen: new Date(i.lastSeen),
      }));
      data.performanceBaselines = data.performanceBaselines.map(
        (p: unknown) => ({
          ...p,
          timestamp: new Date(p.timestamp),
        }),
      );
      data.userSessions = data.userSessions.map((s: unknown) => ({
        ...s,
        timestamp: new Date(s.timestamp),
      }));

      this.memory = data;
    } catch (_error) {
      // Memory file doesn't exist or is invalid, use defaults
    }
  }

  /**
   * Save memory to disk
   */
  async save(): Promise<void> {
    this.memory.metadata.lastUpdated = new Date();

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.memoryPath), { recursive: true });

      // Write memory
      await fs.writeFile(
        this.memoryPath,
        JSON.stringify(this.memory, null, 2),
        'utf-8',
      );
    } catch (_error) {
      // Silently ignore save errors
    }
  }

  /**
   * Learn from user interaction
   */
  async learnFromInteraction(interaction: UserSession): Promise<void> {
    // Add session to history
    this.memory.userSessions.push(interaction);
    this.memory.metadata.totalSessions++;

    // Keep only last 100 sessions
    if (this.memory.userSessions.length > 100) {
      this.memory.userSessions = this.memory.userSessions.slice(-100);
    }

    // Learn conventions from successful sessions
    if (interaction.success && interaction.filesModified.length > 0) {
      await this.learnConventions(interaction);
    }

    // Detect patterns in commands
    await this.detectCommandPatterns(interaction);

    // Update critical paths
    this.updateCriticalPaths(interaction);

    await this.save();
  }

  /**
   * Learn code conventions from successful interactions
   */
  private async learnConventions(_session: UserSession): Promise<void> {
    // Analyze modified files to learn conventions
    for (const file of session.filesModified) {
      try {
        const content = await fs.readFile(file, 'utf-8');

        // Detect naming conventions
        const classNames = content.match(/class\s+([A-Z][a-zA-Z0-9]*)/g) || [];
        if (classNames.length > 0) {
          const convention: CodeConvention = {
            category: 'naming',
            rule: 'Use PascalCase for class names',
            examples: classNames.slice(0, 3),
            confidence: 0.8,
          };
          this.addOrUpdateConvention(convention);
        }

        // Detect function naming
        const functionNames =
          content.match(/function\s+([a-z][a-zA-Z0-9]*)/g) || [];
        if (functionNames.length > 0) {
          const convention: CodeConvention = {
            category: 'naming',
            rule: 'Use camelCase for function names',
            examples: functionNames.slice(0, 3),
            confidence: 0.8,
          };
          this.addOrUpdateConvention(convention);
        }

        // Detect test patterns
        if (file.includes('.test.') || file.includes('.spec.')) {
          const testPattern = content.match(/describe\(|test\(|it\(/);
          if (testPattern) {
            const convention: CodeConvention = {
              category: 'testing',
              rule: 'Use describe/test/it pattern for tests',
              examples: [testPattern[0]],
              confidence: 0.9,
            };
            this.addOrUpdateConvention(convention);
          }
        }
      } catch (_error) {
        // Skip files that can't be read
      }
    }
  }

  /**
   * Add or update a convention
   */
  private addOrUpdateConvention(newConvention: CodeConvention): void {
    const existing = this.memory.architecture.conventions.find(
      (c) => c.rule === newConvention.rule,
    );

    if (existing) {
      // Update confidence and examples
      existing.confidence = Math.min(
        1,
        (existing.confidence + newConvention.confidence) / 2,
      );
      existing.examples = [
        ...new Set([...existing.examples, ...newConvention.examples]),
      ].slice(0, 5);
    } else {
      this.memory.architecture.conventions.push(newConvention);
    }

    // Keep only top 50 conventions
    if (this.memory.architecture.conventions.length > 50) {
      this.memory.architecture.conventions.sort(
        (a, b) => b.confidence - a.confidence,
      );
      this.memory.architecture.conventions =
        this.memory.architecture.conventions.slice(0, 50);
    }
  }

  /**
   * Detect patterns in command usage
   */
  private async detectCommandPatterns(_session: UserSession): Promise<void> {
    // Analyze command sequences
    const commands = session.commandsExecuted;

    // Detect common sequences
    if (commands.length >= 2) {
      // const sequence = commands.slice(-2).join(' -> ');
      // Could store common sequences for suggestions
    }
  }

  /**
   * Update critical paths based on modification frequency
   */
  private updateCriticalPaths(_session: UserSession): void {
    // Track which files are modified most frequently
    const pathCounts = new Map<string, number>();

    // Count from all sessions
    for (const s of this.memory.userSessions) {
      for (const file of s.filesModified) {
        pathCounts.set(file, (pathCounts.get(file) || 0) + 1);
      }
    }

    // Update critical paths (top 20 most modified files)
    const sorted = Array.from(pathCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    this.memory.architecture.criticalPaths = sorted.map(([path]) => path);
  }

  /**
   * Record a technical decision
   */
  async recordDecision(decision: TechnicalDecision): Promise<void> {
    this.memory.decisions.push(decision);
    await this.save();
  }

  /**
   * Record a known issue
   */
  async recordIssue(issue: KnownIssue): Promise<void> {
    const existing = this.memory.knownIssues.find((i) => i.id === issue.id);

    if (existing) {
      existing.lastSeen = new Date();
      existing.occurrences++;
    } else {
      this.memory.knownIssues.push(issue);
    }

    await this.save();
  }

  /**
   * Record performance baseline
   */
  async recordPerformanceBaseline(metrics: PerformanceMetrics): Promise<void> {
    this.memory.performanceBaselines.push(metrics);

    // Keep only last 30 baselines
    if (this.memory.performanceBaselines.length > 30) {
      this.memory.performanceBaselines =
        this.memory.performanceBaselines.slice(-30);
    }

    await this.save();
  }

  /**
   * Suggest improvements based on memory
   */
  async suggestImprovements(): Promise<Suggestion[]> {
    const suggestions: Suggestion[] = [];

    // Suggest fixing high-severity known issues
    for (const issue of this.memory.knownIssues) {
      if (issue.severity === 'high' || issue.severity === 'critical') {
        suggestions.push({
          id: `fix-${issue.id}`,
          type:
            issue.type === 'security'
              ? 'security'
              : issue.type === 'performance'
                ? 'optimization'
                : 'refactoring',
          priority: issue.severity === 'critical' ? 'high' : 'medium',
          title: `Fix ${issue.type}: ${issue.description}`,
          description: issue.description,
          reasoning: `This issue has been seen ${issue.occurrences} times and affects critical parts of the codebase`,
          affectedFiles: issue.relatedFiles,
          estimatedImpact: issue.severity === 'critical' ? 'large' : 'medium',
          confidence: 0.9,
        });
      }
    }

    // Suggest adding tests for uncovered critical paths
    const criticalPathsWithoutTests =
      this.memory.architecture.criticalPaths.filter(
        (p) => !p.includes('.test.') && !p.includes('.spec.'),
      );

    if (criticalPathsWithoutTests.length > 0) {
      suggestions.push({
        id: 'add-tests-critical',
        type: 'testing',
        priority: 'high',
        title: 'Add tests for frequently modified files',
        description:
          'Several frequently modified files lack test coverage, increasing risk of regressions',
        reasoning:
          'Files that are modified often should have comprehensive test coverage',
        affectedFiles: criticalPathsWithoutTests.slice(0, 5),
        estimatedImpact: 'medium',
        confidence: 0.85,
      });
    }

    // Suggest performance improvements if metrics are degrading
    if (this.memory.performanceBaselines.length >= 5) {
      const recent = this.memory.performanceBaselines.slice(-5);
      const avg = recent.reduce((sum, m) => sum + m.buildTime, 0) / 5;
      const first = recent[0].buildTime;

      if (avg > first * 1.5) {
        suggestions.push({
          id: 'perf-build-time',
          type: 'optimization',
          priority: 'medium',
          title: 'Build time has increased significantly',
          description: `Build time has increased by ${Math.round(((avg - first) / first) * 100)}%`,
          reasoning:
            'Recent changes have significantly impacted build performance',
          affectedFiles: [],
          estimatedImpact: 'large',
          confidence: 0.9,
        });
      }
    }

    // Store suggestions
    this.memory.suggestions = suggestions;
    await this.save();

    return suggestions;
  }

  /**
   * Get project memory
   */
  getMemory(): ProjectMemory {
    return this.memory;
  }

  /**
   * Get conventions for a specific category
   */
  getConventions(category?: CodeConvention['category']): CodeConvention[] {
    if (!category) {
      return this.memory.architecture.conventions;
    }
    return this.memory.architecture.conventions.filter(
      (c) => c.category === category,
    );
  }

  /**
   * Get technical decisions
   */
  getDecisions(status?: TechnicalDecision['status']): TechnicalDecision[] {
    if (!status) {
      return this.memory.decisions;
    }
    return this.memory.decisions.filter((d) => d.status === status);
  }

  /**
   * Get known issues by severity
   */
  getIssues(severity?: KnownIssue['severity']): KnownIssue[] {
    if (!severity) {
      return this.memory.knownIssues;
    }
    return this.memory.knownIssues.filter((i) => i.severity === severity);
  }

  /**
   * Get performance trends
   */
  getPerformanceTrends(): {
    buildTime: { trend: 'improving' | 'stable' | 'degrading'; change: number };
    testTime: { trend: 'improving' | 'stable' | 'degrading'; change: number };
    bundleSize: {
      trend: 'improving' | 'stable' | 'degrading';
      change: number;
    };
  } {
    if (this.memory.performanceBaselines.length < 2) {
      return {
        buildTime: { trend: 'stable', change: 0 },
        testTime: { trend: 'stable', change: 0 },
        bundleSize: { trend: 'stable', change: 0 },
      };
    }

    const recent = this.memory.performanceBaselines.slice(-5);
    const older = this.memory.performanceBaselines.slice(0, 5);

    const recentAvg = {
      buildTime:
        recent.reduce((sum, m) => sum + m.buildTime, 0) / recent.length,
      testTime: recent.reduce((sum, m) => sum + m.testTime, 0) / recent.length,
      bundleSize:
        recent.reduce((sum, m) => sum + m.bundleSize, 0) / recent.length,
    };

    const olderAvg = {
      buildTime: older.reduce((sum, m) => sum + m.buildTime, 0) / older.length,
      testTime: older.reduce((sum, m) => sum + m.testTime, 0) / older.length,
      bundleSize:
        older.reduce((sum, m) => sum + m.bundleSize, 0) / older.length,
    };

    const getTrend = (
      recent: number,
      older: number,
    ): 'improving' | 'stable' | 'degrading' => {
      const change = ((recent - older) / older) * 100;
      if (Math.abs(change) < 5) return 'stable';
      return change < 0 ? 'improving' : 'degrading';
    };

    return {
      buildTime: {
        trend: getTrend(recentAvg.buildTime, olderAvg.buildTime),
        change:
          ((recentAvg.buildTime - olderAvg.buildTime) / olderAvg.buildTime) *
          100,
      },
      testTime: {
        trend: getTrend(recentAvg.testTime, olderAvg.testTime),
        change:
          ((recentAvg.testTime - olderAvg.testTime) / olderAvg.testTime) * 100,
      },
      bundleSize: {
        trend: getTrend(recentAvg.bundleSize, olderAvg.bundleSize),
        change:
          ((recentAvg.bundleSize - olderAvg.bundleSize) / olderAvg.bundleSize) *
          100,
      },
    };
  }
}

/**
 * Create a new memory manager instance
 */
export function createMemoryManager(projectRoot: string): MemoryManager {
  return new MemoryManager(projectRoot);
}
