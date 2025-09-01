/**
 * Codebase Analyzer for QwenViz
 * Analyzes project structure, dependencies, and complexity metrics
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';

export interface AnalysisOptions {
  depth: number;
  includeTests: boolean;
  includeDocs: boolean;
  excludePatterns?: string[];
}

export interface FileInfo {
  path: string;
  name: string;
  extension: string;
  size: number;
  lines: number;
  complexity?: number;
  dependencies: string[];
  exports?: string[];
  imports?: string[];
}

export interface DirectoryInfo {
  path: string;
  name: string;
  fileCount: number;
  subDirectories: string[];
}

export interface DependencyInfo {
  from: string;
  to: string;
  type: 'import' | 'require' | 'include';
  line?: number;
}

export interface CodebaseAnalysis {
  projectPath: string;
  timestamp: string;
  files: FileInfo[];
  directories: DirectoryInfo[];
  dependencies: DependencyInfo[];
  fileTypes: Record<string, number>;
  totalLines: number;
  complexity: {
    cyclomatic: number;
    coupling: number;
    cohesion: number;
  };
  gitInfo?: {
    branch: string;
    commits: number;
    contributors: string[];
  };
}

export class CodebaseAnalyzer {
  private readonly DEFAULT_EXCLUDE_PATTERNS = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
    '**/*.log'
  ];

  async analyze(projectPath: string, options: AnalysisOptions): Promise<CodebaseAnalysis> {
    const startTime = Date.now();
    console.log(`🔍 Starting codebase analysis for: ${projectPath}`);

    const excludePatterns = [
      ...this.DEFAULT_EXCLUDE_PATTERNS,
      ...(options.excludePatterns || [])
    ];

    if (!options.includeTests) {
      excludePatterns.push('**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**');
    }

    if (!options.includeDocs) {
      excludePatterns.push('**/*.md', '**/docs/**', '**/documentation/**');
    }

    // Find all files
    const allFiles = await this.findFiles(projectPath, excludePatterns, options.depth);
    console.log(`📁 Found ${allFiles.length} files`);

    // Analyze files
    const files: FileInfo[] = [];
    const dependencies: DependencyInfo[] = [];
    const fileTypes: Record<string, number> = {};

    for (const filePath of allFiles) {
      try {
        const fileInfo = await this.analyzeFile(filePath, projectPath);
        files.push(fileInfo);
        
        // Track file types
        const ext = fileInfo.extension || 'no-extension';
        fileTypes[ext] = (fileTypes[ext] || 0) + 1;

        // Extract dependencies
        fileInfo.dependencies.forEach(dep => {
          dependencies.push({
            from: fileInfo.path,
            to: dep,
            type: 'import'
          });
        });
      } catch (error) {
        console.warn(`⚠️  Failed to analyze file ${filePath}:`, error);
      }
    }

    // Analyze directories
    const directories = await this.analyzeDirectories(projectPath, excludePatterns);

    // Calculate complexity metrics
    const complexity = this.calculateComplexity(files, dependencies);

    // Get git information
    const gitInfo = await this.getGitInfo(projectPath);

    const analysis: CodebaseAnalysis = {
      projectPath,
      timestamp: new Date().toISOString(),
      files,
      directories,
      dependencies,
      fileTypes,
      totalLines: files.reduce((sum, file) => sum + file.lines, 0),
      complexity,
      gitInfo
    };

    const endTime = Date.now();
    console.log(`✅ Analysis completed in ${endTime - startTime}ms`);

    return analysis;
  }

  private async findFiles(
    projectPath: string,
    excludePatterns: string[],
    maxDepth: number
  ): Promise<string[]> {
    const pattern = '**/*';
    const options = {
      cwd: projectPath,
      ignore: excludePatterns,
      nodir: true,
      absolute: true
    };

    const files = await glob(pattern, options);
    
    // Filter by depth
    return files.filter(file => {
      const relativePath = path.relative(projectPath, file);
      const depth = relativePath.split(path.sep).length;
      return depth <= maxDepth;
    });
  }

  private async analyzeFile(filePath: string, projectPath: string): Promise<FileInfo> {
    const stats = await fs.stat(filePath);
    const content = await fs.readFile(filePath, 'utf8');
    const relativePath = path.relative(projectPath, filePath);
    
    const fileInfo: FileInfo = {
      path: relativePath,
      name: path.basename(filePath),
      extension: path.extname(filePath),
      size: stats.size,
      lines: content.split('\n').length,
      dependencies: [],
      imports: [],
      exports: []
    };

    // Extract imports/dependencies based on file type
    if (this.isSourceFile(fileInfo.extension)) {
      fileInfo.dependencies = this.extractDependencies(content, fileInfo.extension);
      fileInfo.imports = this.extractImports(content, fileInfo.extension);
      fileInfo.exports = this.extractExports(content, fileInfo.extension);
      fileInfo.complexity = this.calculateFileComplexity(content, fileInfo.extension);
    }

    return fileInfo;
  }

  private async analyzeDirectories(
    projectPath: string,
    excludePatterns: string[]
  ): Promise<DirectoryInfo[]> {
    const directories: DirectoryInfo[] = [];
    
    const findDirectories = async (currentPath: string): Promise<void> => {
      try {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const dirPath = path.join(currentPath, entry.name);
            const relativePath = path.relative(projectPath, dirPath);
            
            // Check if directory should be excluded
            const shouldExclude = excludePatterns.some(pattern =>
              pattern.replace(/\*\*/g, '').replace(/\*/g, '').includes(entry.name)
            );
            
            if (!shouldExclude) {
              const subEntries = await fs.readdir(dirPath, { withFileTypes: true });
              const fileCount = subEntries.filter(e => e.isFile()).length;
              const subDirectories = subEntries
                .filter(e => e.isDirectory())
                .map(e => e.name);

              directories.push({
                path: relativePath,
                name: entry.name,
                fileCount,
                subDirectories
              });

              await findDirectories(dirPath);
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to read directory ${currentPath}:`, error);
      }
    };

    await findDirectories(projectPath);
    return directories;
  }

  private isSourceFile(extension: string): boolean {
    const sourceExtensions = [
      '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h',
      '.cs', '.php', '.rb', '.go', '.rs', '.kt', '.swift', '.dart',
      '.scala', '.clj', '.hs', '.ml', '.f90', '.R', '.jl'
    ];
    return sourceExtensions.includes(extension);
  }

  private extractDependencies(content: string, extension: string): string[] {
    const dependencies: string[] = [];
    
    switch (extension) {
      case '.js':
      case '.ts':
      case '.jsx':
      case '.tsx':
        // Extract ES6 imports and CommonJS requires
        const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
        const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
        
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          dependencies.push(match[1]);
        }
        while ((match = requireRegex.exec(content)) !== null) {
          dependencies.push(match[1]);
        }
        break;
        
      case '.py':
        // Extract Python imports
        const pythonImportRegex = /(?:from\s+(\S+)\s+import|import\s+(\S+))/g;
        while ((match = pythonImportRegex.exec(content)) !== null) {
          dependencies.push(match[1] || match[2]);
        }
        break;
        
      case '.java':
        // Extract Java imports
        const javaImportRegex = /import\s+([^;]+);/g;
        while ((match = javaImportRegex.exec(content)) !== null) {
          dependencies.push(match[1]);
        }
        break;
    }
    
    return [...new Set(dependencies)]; // Remove duplicates
  }

  private extractImports(content: string, extension: string): string[] {
    // Similar to extractDependencies but more detailed
    return this.extractDependencies(content, extension);
  }

  private extractExports(content: string, extension: string): string[] {
    const exports: string[] = [];
    
    switch (extension) {
      case '.js':
      case '.ts':
      case '.jsx':
      case '.tsx':
        // Extract named exports and default exports
        const namedExportRegex = /export\s+(?:const|let|var|function|class)\s+(\w+)/g;
        const defaultExportRegex = /export\s+default\s+(\w+)/g;
        
        let match;
        while ((match = namedExportRegex.exec(content)) !== null) {
          exports.push(match[1]);
        }
        while ((match = defaultExportRegex.exec(content)) !== null) {
          exports.push(`default:${match[1]}`);
        }
        break;
    }
    
    return exports;
  }

  private calculateFileComplexity(content: string, extension: string): number {
    // Simplified cyclomatic complexity calculation
    let complexity = 1; // Base complexity
    
    const complexityKeywords = [
      'if', 'else', 'while', 'for', 'switch', 'case', 'catch', 'finally',
      '&&', '||', '?', ':', 'elif', 'except'
    ];
    
    for (const keyword of complexityKeywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'g');
      const matches = content.match(regex);
      if (matches) {
        complexity += matches.length;
      }
    }
    
    return complexity;
  }

  private calculateComplexity(files: FileInfo[], dependencies: DependencyInfo[]): {
    cyclomatic: number;
    coupling: number;
    cohesion: number;
  } {
    // Calculate average cyclomatic complexity
    const totalComplexity = files.reduce((sum, file) => sum + (file.complexity || 0), 0);
    const cyclomatic = files.length > 0 ? totalComplexity / files.length : 0;

    // Calculate coupling (number of dependencies per file)
    const coupling = files.length > 0 ? dependencies.length / files.length : 0;

    // Calculate cohesion (simplified metric based on file organization)
    const cohesion = this.calculateCohesion(files);

    return {
      cyclomatic: Math.round(cyclomatic * 100) / 100,
      coupling: Math.round(coupling * 100) / 100,
      cohesion: Math.round(cohesion * 100) / 100
    };
  }

  private calculateCohesion(files: FileInfo[]): number {
    // Simplified cohesion metric based on directory structure
    const directoryFiles: Record<string, number> = {};
    
    files.forEach(file => {
      const directory = path.dirname(file.path);
      directoryFiles[directory] = (directoryFiles[directory] || 0) + 1;
    });
    
    const averageFilesPerDirectory = Object.values(directoryFiles).reduce((a, b) => a + b, 0) / Object.keys(directoryFiles).length;
    
    // Higher cohesion when files are well-organized in directories
    return Math.min(10, averageFilesPerDirectory) / 10;
  }

  private async getGitInfo(projectPath: string): Promise<{
    branch: string;
    commits: number;
    contributors: string[];
  } | undefined> {
    try {
      const { execSync } = await import('child_process');
      
      const branch = execSync('git branch --show-current', { 
        cwd: projectPath, 
        encoding: 'utf8' 
      }).trim();
      
      const commitCount = parseInt(
        execSync('git rev-list --count HEAD', { 
          cwd: projectPath, 
          encoding: 'utf8' 
        }).trim()
      );
      
      const contributors = execSync('git log --format="%an" | sort | uniq', { 
        cwd: projectPath, 
        encoding: 'utf8' 
      })
        .trim()
        .split('\n')
        .filter(name => name.length > 0);
      
      return {
        branch,
        commits: commitCount,
        contributors
      };
    } catch (error) {
      console.warn('Could not extract Git information:', error);
      return undefined;
    }
  }
}