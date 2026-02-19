/**
 * Copyright (c) 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Architecture patterns detected in the codebase
 */
export enum ArchitecturePattern {
  MVC = 'MVC',
  MICROSERVICES = 'microservices',
  LAYERED = 'layered',
  MONOLITHIC = 'monolithic',
  MODULAR = 'modular',
  EVENT_DRIVEN = 'event-driven',
  UNKNOWN = 'unknown',
}

/**
 * Technology stack information
 */
export interface TechnologyStack {
  languages: string[];
  frameworks: string[];
  libraries: string[];
  buildTools: string[];
  testingFrameworks: string[];
}

/**
 * Test coverage information
 */
export interface CoverageMap {
  overall: number;
  byFile: Map<string, number>;
  uncoveredFiles: string[];
}

/**
 * Code node representing a file, class, or function
 */
export interface CodeNode {
  id: string;
  type: 'file' | 'class' | 'function' | 'module';
  name: string;
  path: string;
  language: string;
  loc: number; // Lines of code
  complexity?: number;
  exports?: string[];
  imports?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Dependency relationship between code nodes
 */
export interface Dependency {
  from: string; // Node ID
  to: string; // Node ID
  type: 'import' | 'call' | 'inheritance' | 'composition';
  strength: number; // 1-10, higher means stronger coupling
}

/**
 * Impact analysis report
 */
export interface ImpactReport {
  affectedFiles: string[];
  affectedFunctions: string[];
  affectedTests: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  estimatedScope: {
    files: number;
    functions: number;
    linesOfCode: number;
  };
  recommendations: string[];
}

/**
 * Complete codebase graph structure
 */
export interface CodebaseGraph {
  nodes: Map<string, CodeNode>;
  edges: Map<string, Dependency[]>;
  metadata: {
    architecture: ArchitecturePattern;
    techStack: TechnologyStack;
    testCoverage: CoverageMap;
    lastAnalyzed: Date;
    projectRoot: string;
  };
}

/**
 * Analyzes codebase structure and builds knowledge graph
 */
export class CodebaseAnalyzer {
  private graph: CodebaseGraph;

  constructor() {
    this.graph = {
      nodes: new Map(),
      edges: new Map(),
      metadata: {
        architecture: ArchitecturePattern.UNKNOWN,
        techStack: {
          languages: [],
          frameworks: [],
          libraries: [],
          buildTools: [],
          testingFrameworks: [],
        },
        testCoverage: {
          overall: 0,
          byFile: new Map(),
          uncoveredFiles: [],
        },
        lastAnalyzed: new Date(),
        projectRoot: '',
      },
    };
  }

  /**
   * Build complete codebase graph
   */
  async buildGraph(projectPath: string): Promise<CodebaseGraph> {
    this.graph.metadata.projectRoot = projectPath;
    this.graph.metadata.lastAnalyzed = new Date();

    // Detect technology stack
    await this.detectTechStack(projectPath);

    // Analyze file structure
    await this.analyzeFiles(projectPath);

    // Detect architecture pattern
    this.detectArchitecturePattern();

    // Analyze test coverage
    await this.analyzeTestCoverage(projectPath);

    return this.graph;
  }

  /**
   * Detect technology stack from package files and imports
   */
  private async detectTechStack(projectPath: string): Promise<void> {
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    const libraries = new Set<string>();
    const buildTools = new Set<string>();
    const testingFrameworks = new Set<string>();

    // Check for package.json
    const packageJsonPath = path.join(projectPath, 'package.json');
    try {
      const packageJson = JSON.parse(
        await fs.readFile(packageJsonPath, 'utf-8'),
      );

      // Detect languages
      if (packageJson.dependencies || packageJson.devDependencies) {
        languages.add('TypeScript');
        languages.add('JavaScript');
      }

      // Detect frameworks and libraries
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      for (const dep of Object.keys(allDeps)) {
        // Frameworks
        if (dep.includes('react')) frameworks.add('React');
        if (dep.includes('vue')) frameworks.add('Vue');
        if (dep.includes('angular')) frameworks.add('Angular');
        if (dep.includes('express')) frameworks.add('Express');
        if (dep.includes('fastify')) frameworks.add('Fastify');
        if (dep.includes('next')) frameworks.add('Next.js');

        // Testing frameworks
        if (dep.includes('vitest')) testingFrameworks.add('Vitest');
        if (dep.includes('jest')) testingFrameworks.add('Jest');
        if (dep.includes('mocha')) testingFrameworks.add('Mocha');
        if (dep.includes('cypress')) testingFrameworks.add('Cypress');

        // Build tools
        if (dep.includes('webpack')) buildTools.add('Webpack');
        if (dep.includes('vite')) buildTools.add('Vite');
        if (dep.includes('esbuild')) buildTools.add('esbuild');
        if (dep.includes('rollup')) buildTools.add('Rollup');

        // Add as library
        libraries.add(dep);
      }
    } catch (_error) {
      // package.json not found or invalid
    }

    // Check for other language indicators
    const files = await glob('**/*.{py,go,rs,java,rb}', {
      cwd: projectPath,
      ignore: ['node_modules/**', 'dist/**', 'build/**'],
    });

    files.forEach((file) => {
      if (file.endsWith('.py')) languages.add('Python');
      if (file.endsWith('.go')) languages.add('Go');
      if (file.endsWith('.rs')) languages.add('Rust');
      if (file.endsWith('.java')) languages.add('Java');
      if (file.endsWith('.rb')) languages.add('Ruby');
    });

    this.graph.metadata.techStack = {
      languages: Array.from(languages),
      frameworks: Array.from(frameworks),
      libraries: Array.from(libraries).slice(0, 50), // Limit to top 50
      buildTools: Array.from(buildTools),
      testingFrameworks: Array.from(testingFrameworks),
    };
  }

  /**
   * Analyze all files in the project
   */
  private async analyzeFiles(projectPath: string): Promise<void> {
    const files = await glob('**/*.{ts,tsx,js,jsx}', {
      cwd: projectPath,
      ignore: ['node_modules/**', 'dist/**', 'build/**', '**/*.test.*'],
    });

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      await this.analyzeFile(fullPath, file);
    }
  }

  /**
   * Analyze a single file
   */
  private async analyzeFile(
    fullPath: string,
    relativePath: string,
  ): Promise<void> {
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const loc = lines.filter((line) => line.trim().length > 0).length;

      // Extract imports
      const imports: string[] = [];
      const exports: string[] = [];

      lines.forEach((line) => {
        // Detect imports
        const importMatch = line.match(
          /import\s+(?:.*\s+from\s+)?['"]([^'"]+)['"]/,
        );
        if (importMatch) {
          imports.push(importMatch[1]);
        }

        // Detect exports
        if (line.includes('export')) {
          const exportMatch = line.match(
            /export\s+(?:default\s+)?(?:class|function|const|let|var|interface|type)\s+(\w+)/,
          );
          if (exportMatch) {
            exports.push(exportMatch[1]);
          }
        }
      });

      // Create node
      const node: CodeNode = {
        id: relativePath,
        type: 'file',
        name: path.basename(relativePath),
        path: relativePath,
        language: this.detectLanguage(relativePath),
        loc,
        imports,
        exports,
      };

      this.graph.nodes.set(node.id, node);

      // Create edges for imports
      imports.forEach((importPath) => {
        const dependency: Dependency = {
          from: relativePath,
          to: importPath,
          type: 'import',
          strength: 5,
        };

        if (!this.graph.edges.has(relativePath)) {
          this.graph.edges.set(relativePath, []);
        }
        this.graph.edges.get(relativePath)!.push(dependency);
      });
    } catch (_error) {
      // Skip files that can't be read
    }
  }

  /**
   * Detect language from file extension
   */
  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath);
    const languageMap: Record<string, string> = {
      '.ts': 'TypeScript',
      '.tsx': 'TypeScript',
      '.js': 'JavaScript',
      '.jsx': 'JavaScript',
      '.py': 'Python',
      '.go': 'Go',
      '.rs': 'Rust',
      '.java': 'Java',
      '.rb': 'Ruby',
    };
    return languageMap[ext] || 'Unknown';
  }

  /**
   * Detect architecture pattern from file structure
   */
  private detectArchitecturePattern(): void {
    const nodes = Array.from(this.graph.nodes.values());
    const paths = nodes.map((n) => n.path);

    // Check for MVC pattern
    const hasMVC =
      paths.some((p) => p.includes('models/')) &&
      paths.some((p) => p.includes('views/')) &&
      paths.some((p) => p.includes('controllers/'));

    if (hasMVC) {
      this.graph.metadata.architecture = ArchitecturePattern.MVC;
      return;
    }

    // Check for microservices
    const hasServices = paths.some((p) => p.includes('services/'));
    const hasMultiplePackages = paths.some((p) => p.includes('packages/'));

    if (hasServices || hasMultiplePackages) {
      this.graph.metadata.architecture = ArchitecturePattern.MICROSERVICES;
      return;
    }

    // Check for layered architecture
    const hasLayers =
      paths.some((p) => p.includes('presentation/')) ||
      paths.some((p) => p.includes('business/')) ||
      paths.some((p) => p.includes('data/'));

    if (hasLayers) {
      this.graph.metadata.architecture = ArchitecturePattern.LAYERED;
      return;
    }

    // Check for modular
    if (hasMultiplePackages) {
      this.graph.metadata.architecture = ArchitecturePattern.MODULAR;
      return;
    }

    this.graph.metadata.architecture = ArchitecturePattern.MONOLITHIC;
  }

  /**
   * Analyze test coverage
   */
  private async analyzeTestCoverage(projectPath: string): Promise<void> {
    const testFiles = await glob('**/*.{test,spec}.{ts,tsx,js,jsx}', {
      cwd: projectPath,
      ignore: ['node_modules/**', 'dist/**', 'build/**'],
    });

    const sourceFiles = Array.from(this.graph.nodes.values()).filter(
      (node) => node.type === 'file',
    );

    const coveredFiles = new Set<string>();
    testFiles.forEach((testFile) => {
      // Simple heuristic: assume test file covers source file with same name
      const sourceName = testFile
        .replace(/\.(test|spec)\./, '.')
        .replace(/\.(ts|tsx|js|jsx)$/, '');
      coveredFiles.add(sourceName);
    });

    const totalFiles = sourceFiles.length;
    const covered = testFiles.length;
    const overall = totalFiles > 0 ? (covered / totalFiles) * 100 : 0;

    this.graph.metadata.testCoverage = {
      overall,
      byFile: new Map(),
      uncoveredFiles: sourceFiles
        .filter((node) => !coveredFiles.has(node.path))
        .map((node) => node.path),
    };
  }

  /**
   * Get impact analysis for changing specific files
   */
  async getImpactAnalysis(files: string[]): Promise<ImpactReport> {
    const affectedFiles = new Set<string>(files);
    const affectedFunctions = new Set<string>();
    const affectedTests = new Set<string>();

    // BFS to find all dependent files
    const queue = [...files];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      // Find all files that depend on current file
      for (const [nodeId, dependencies] of this.graph.edges.entries()) {
        for (const dep of dependencies) {
          if (dep.to.includes(current) || current.includes(dep.to)) {
            affectedFiles.add(nodeId);
            queue.push(nodeId);
          }
        }
      }
    }

    // Calculate risk level based on number of affected files
    const affectedCount = affectedFiles.size;
    let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';

    if (affectedCount > 50) riskLevel = 'critical';
    else if (affectedCount > 20) riskLevel = 'high';
    else if (affectedCount > 5) riskLevel = 'medium';

    // Calculate total LOC affected
    let totalLoc = 0;
    affectedFiles.forEach((file) => {
      const node = this.graph.nodes.get(file);
      if (node) totalLoc += node.loc;
    });

    const recommendations: string[] = [];

    if (riskLevel === 'critical' || riskLevel === 'high') {
      recommendations.push(
        'Consider breaking this change into smaller, incremental changes',
      );
      recommendations.push(
        'Ensure comprehensive test coverage before proceeding',
      );
      recommendations.push('Review all affected files for potential issues');
    }

    if (affectedTests.size === 0) {
      recommendations.push('Add tests to cover the changes');
    }

    return {
      affectedFiles: Array.from(affectedFiles),
      affectedFunctions: Array.from(affectedFunctions),
      affectedTests: Array.from(affectedTests),
      riskLevel,
      estimatedScope: {
        files: affectedFiles.size,
        functions: affectedFunctions.size,
        linesOfCode: totalLoc,
      },
      recommendations,
    };
  }

  /**
   * Get the current graph
   */
  getGraph(): CodebaseGraph {
    return this.graph;
  }

  /**
   * Find files by pattern
   */
  findFiles(pattern: string): CodeNode[] {
    const results: CodeNode[] = [];
    for (const node of this.graph.nodes.values()) {
      if (node.path.includes(pattern) || node.name.includes(pattern)) {
        results.push(node);
      }
    }
    return results;
  }

  /**
   * Get dependencies for a file
   */
  getDependencies(filePath: string): Dependency[] {
    return this.graph.edges.get(filePath) || [];
  }

  /**
   * Get reverse dependencies (who depends on this file)
   */
  getReverseDependencies(filePath: string): string[] {
    const results: string[] = [];
    for (const [nodeId, dependencies] of this.graph.edges.entries()) {
      for (const dep of dependencies) {
        if (dep.to.includes(filePath)) {
          results.push(nodeId);
        }
      }
    }
    return results;
  }
}

/**
 * Create a new codebase analyzer instance
 */
export function createCodebaseAnalyzer(): CodebaseAnalyzer {
  return new CodebaseAnalyzer();
}
