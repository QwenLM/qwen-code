/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProjectContext, FileNode, CodeConventions } from './types.js';

/**
 * Default values for context
 */
const DEFAULT_CONTEXT: ProjectContext = {
  projectName: 'Unknown Project',
  projectType: 'unknown',
  language: 'unknown',
  dependencies: {},
  scripts: {},
  fileStructure: [],
  conventions: {
    namingConvention: 'mixed',
    testingFramework: 'unknown',
    documentationStyle: 'none',
    codeStyle: 'mixed',
  },
};

/**
 * Mapping of testing frameworks to their indicators
 */
const TESTING_FRAMEWORKS: Record<string, string[]> = {
  vitest: ['vitest', 'vite'],
  jest: ['jest', '@types/jest'],
  mocha: ['mocha'],
  jasmine: ['jasmine'],
  'jest + testing-library': ['@testing-library'],
  ava: ['ava'],
};

/**
 * Gathers context from the project
 */
export class ContextGatherer {
  private projectRoot: string;
  private cache: Map<string, ProjectContext>;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.cache = new Map();
  }

  /**
   * Gather context from the project
   */
  gather(): ProjectContext {
    // Check cache first
    const cached = this.cache.get(this.projectRoot);
    if (cached) {
      return cached;
    }

    const context: ProjectContext = {
      ...DEFAULT_CONTEXT,
    };

    try {
      // Gather package.json info
      const packageJson = this.readPackageJson();
      if (packageJson) {
        context.projectName = packageJson.name || 'Unknown Project';
        const deps = {
          ...(packageJson.dependencies || {}),
          ...(packageJson.devDependencies || {}),
        };
        context.dependencies = deps;
        context.scripts = packageJson.scripts || {};
        context.framework = this.detectFramework(packageJson);
        context.projectType = this.detectProjectType(packageJson);
        context.language = this.detectLanguage(packageJson);
      }

      // Gather file structure
      context.fileStructure = this.scanDirectory(this.projectRoot, 2);

      // Detect conventions
      context.conventions = this.detectConventions();

      // Cache the result
      this.cache.set(this.projectRoot, context);
    } catch {
      // Return default context if gathering fails
    }

    return context;
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Read package.json
   */
  private readPackageJson(): {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  } | null {
    try {
      const packageJsonPath = path.join(this.projectRoot, 'package.json');
      const content = fs.readFileSync(packageJsonPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Detect the framework being used
   */
  private detectFramework(pkgJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }): string | undefined {
    const deps: Record<string, string> = {
      ...(pkgJson.dependencies || {}),
      ...(pkgJson.devDependencies || {}),
    };
    const depKeys = Object.keys(deps);

    const frameworks: Record<string, string[]> = {
      'Next.js': ['next', 'nextjs'],
      React: ['react'],
      Vue: ['vue', 'nuxt'],
      Angular: ['@angular/core'],
      Express: ['express'],
      'Nest.js': ['@nestjs/core'],
      Svelte: ['svelte', 'sveltekit'],
      Astro: ['astro'],
      Remix: ['@remix-run'],
    };

    for (const [framework, indicators] of Object.entries(frameworks)) {
      if (
        indicators.some((ind) =>
          depKeys.some((d) => d.toLowerCase().includes(ind.toLowerCase())),
        )
      ) {
        return framework;
      }
    }

    return undefined;
  }

  /**
   * Detect project type
   */
  private detectProjectType(pkgJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }): string {
    const deps: Record<string, string> = {
      ...(pkgJson.dependencies || {}),
      ...(pkgJson.devDependencies || {}),
    };
    const depKeys = Object.keys(deps);

    if (depKeys.some((d) => d.includes('react'))) {
      return 'react-app';
    }
    if (depKeys.some((d) => d.includes('vue'))) {
      return 'vue-app';
    }
    if (depKeys.some((d) => d.includes('express'))) {
      return 'node-api';
    }
    if (depKeys.some((d) => d.includes('next'))) {
      return 'nextjs-app';
    }

    return 'typescript';
  }

  /**
   * Detect primary language
   */
  private detectLanguage(pkgJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }): string {
    const deps: Record<string, string> = {
      ...(pkgJson.dependencies || {}),
      ...(pkgJson.devDependencies || {}),
    };
    const depKeys = Object.keys(deps);

    if (
      depKeys.some((d) => d.includes('typescript') || d.startsWith('@types/'))
    ) {
      return 'typescript';
    }

    return 'javascript';
  }

  /**
   * Scan directory structure
   */
  private scanDirectory(
    dirPath: string,
    maxDepth: number,
    currentDepth: number = 0,
  ): FileNode[] {
    const result: FileNode[] = [];

    if (currentDepth >= maxDepth) {
      return result;
    }

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        // Skip common ignored directories
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'dist' ||
          entry.name === 'build' ||
          entry.name.startsWith('.')
        ) {
          continue;
        }

        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(this.projectRoot, fullPath);

        if (entry.isDirectory()) {
          const node: FileNode = {
            name: entry.name,
            type: 'directory',
            path: relativePath,
            children: this.scanDirectory(fullPath, maxDepth, currentDepth + 1),
          };
          result.push(node);
        } else if (entry.isFile()) {
          // Only include relevant files
          if (this.isRelevantFile(entry.name)) {
            const node: FileNode = {
              name: entry.name,
              type: 'file',
              path: relativePath,
            };
            result.push(node);
          }
        }
      }
    } catch {
      // Ignore errors when scanning
    }

    return result;
  }

  /**
   * Check if file is relevant for context
   */
  private isRelevantFile(filename: string): boolean {
    const relevantExtensions = [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.json',
      '.md',
      '.yaml',
      '.yml',
      '.toml',
      '.config.js',
      '.config.ts',
    ];

    return relevantExtensions.some((ext) => filename.endsWith(ext));
  }

  /**
   * Detect code conventions
   */
  private detectConventions(): CodeConventions {
    const conventions: CodeConventions = {
      namingConvention: 'mixed',
      testingFramework: 'unknown',
      documentationStyle: 'none',
      codeStyle: 'mixed',
    };

    // Detect testing framework
    conventions.testingFramework = this.detectTestingFramework();

    // Detect documentation style
    conventions.documentationStyle = this.detectDocumentationStyle();

    // Detect naming convention
    conventions.namingConvention = this.detectNamingConvention();

    return conventions;
  }

  /**
   * Detect testing framework from dependencies
   */
  private detectTestingFramework(): string {
    try {
      const packageJson = this.readPackageJson();
      if (!packageJson) {
        return 'unknown';
      }

      const deps: Record<string, string> = {
        ...(packageJson.dependencies || {}),
        ...(packageJson.devDependencies || {}),
      };
      const depKeys = Object.keys(deps);

      for (const [framework, indicators] of Object.entries(
        TESTING_FRAMEWORKS,
      )) {
        if (
          indicators.some((ind) =>
            depKeys.some((d) => d.toLowerCase().includes(ind.toLowerCase())),
          )
        ) {
          return framework;
        }
      }
    } catch {
      // Ignore errors
    }

    return 'unknown';
  }

  /**
   * Detect documentation style from source files
   */
  private detectDocumentationStyle(): 'jsdoc' | 'tsdoc' | 'mixed' | 'none' {
    try {
      // Look for TypeScript config as TSDoc indicator
      const tsConfigPath = path.join(this.projectRoot, 'tsconfig.json');
      const hasTsConfig = fs.existsSync(tsConfigPath);

      // Check a few source files for doc style
      const srcDir = path.join(this.projectRoot, 'src');
      if (fs.existsSync(srcDir)) {
        const files = fs
          .readdirSync(srcDir)
          .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
        if (files.length > 0) {
          const sampleFile = path.join(srcDir, files[0]);
          const content = fs.readFileSync(sampleFile, 'utf-8');

          const hasTsdoc =
            content.includes('@param') || content.includes('@returns');
          const hasJsdoc = content.includes('/**');

          if (hasTsdoc && hasJsdoc) {
            return 'mixed';
          }
          if (hasTsdoc) {
            return 'tsdoc';
          }
          if (hasJsdoc) {
            return 'jsdoc';
          }
        }
      }

      return hasTsConfig ? 'tsdoc' : 'jsdoc';
    } catch {
      return 'none';
    }
  }

  /**
   * Detect naming convention from source files
   */
  private detectNamingConvention():
    | 'camelCase'
    | 'snake_case'
    | 'PascalCase'
    | 'mixed' {
    try {
      const srcDir = path.join(this.projectRoot, 'src');
      if (!fs.existsSync(srcDir)) {
        return 'mixed';
      }

      const files = fs
        .readdirSync(srcDir)
        .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
      if (files.length === 0) {
        return 'mixed';
      }

      // Analyze filenames
      let camelCaseCount = 0;
      let snakeCaseCount = 0;
      let pascalCaseCount = 0;

      for (const file of files.slice(0, 10)) {
        // Sample first 10 files
        const name = file.replace(/\.(ts|tsx)$/, '');
        if (/^[a-z][a-zA-Z0-9]*$/.test(name)) {
          camelCaseCount++;
        } else if (/^[a-z]+_[a-z0-9_]*$/.test(name)) {
          snakeCaseCount++;
        } else if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) {
          pascalCaseCount++;
        }
      }

      const maxCount = Math.max(
        camelCaseCount,
        snakeCaseCount,
        pascalCaseCount,
      );
      if (maxCount === 0) {
        return 'mixed';
      }

      if (camelCaseCount === maxCount) {
        return 'camelCase';
      }
      if (snakeCaseCount === maxCount) {
        return 'snake_case';
      }
      if (pascalCaseCount === maxCount) {
        return 'PascalCase';
      }

      return 'mixed';
    } catch {
      return 'mixed';
    }
  }

  /**
   * Get specific file content from project
   */
  getFileContent(filePath: string): string | null {
    try {
      const fullPath = path.join(this.projectRoot, filePath);
      return fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Check if file exists
   */
  fileExists(filePath: string): boolean {
    try {
      const fullPath = path.join(this.projectRoot, filePath);
      return fs.existsSync(fullPath);
    } catch {
      return false;
    }
  }
}

/**
 * Create context gatherer for a project
 */
export function createContextGatherer(projectRoot: string): ContextGatherer {
  return new ContextGatherer(projectRoot);
}
