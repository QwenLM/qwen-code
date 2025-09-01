/**
 * Code Analyzer for QwenMusic
 * Extracts musical patterns from code structure
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';

export interface MusicAnalysisOptions {
  includeComments?: boolean;
  extractRhythms?: boolean;
  extractMelodies?: boolean;
  extractHarmonies?: boolean;
}

export interface MusicalPattern {
  type: 'rhythm' | 'melody' | 'harmony';
  pattern: string;
  frequency: number;
  complexity: number;
  file: string;
  line: number;
}

export interface CodeMusicAnalysis {
  projectPath: string;
  files: any[];
  musicalPatterns: MusicalPattern[];
  rhythmPatterns: any[];
  melodicElements: any[];
  harmonicElements: any[];
  complexity: {
    cyclomatic: number;
    rhythmic: number;
    melodic: number;
  };
  functionCount: number;
  variableCount: number;
  controlStructures: number;
  commentLines: number;
  commentDensity: number;
  functionalPatterns: number;
  objectOrientedPatterns: number;
  asyncPatterns: number;
  syncPatterns: number;
}

export class CodeAnalyzer {
  async analyze(projectPath: string, options: MusicAnalysisOptions = {}): Promise<CodeMusicAnalysis> {
    console.log('🎵 Analyzing code for musical patterns...');

    const files = await this.findSourceFiles(projectPath);
    const musicalPatterns: MusicalPattern[] = [];
    const rhythmPatterns: any[] = [];
    const melodicElements: any[] = [];
    const harmonicElements: any[] = [];
    
    let functionCount = 0;
    let variableCount = 0;
    let controlStructures = 0;
    let commentLines = 0;
    let totalLines = 0;
    let functionalPatterns = 0;
    let objectOrientedPatterns = 0;
    let asyncPatterns = 0;
    let syncPatterns = 0;

    for (const filePath of files) {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const relativePath = path.relative(projectPath, filePath);
        const lines = content.split('\n');
        totalLines += lines.length;

        // Extract musical patterns from code
        const filePatterns = this.extractMusicalPatterns(content, relativePath);
        musicalPatterns.push(...filePatterns);

        // Count different code elements for musical mapping
        functionCount += this.countPatterns(content, /function\s+\w+|def\s+\w+|const\s+\w+\s*=\s*\(/g);
        variableCount += this.countPatterns(content, /(?:let|const|var)\s+\w+|int\s+\w+|string\s+\w+/g);
        controlStructures += this.countPatterns(content, /\b(?:if|for|while|switch|try)\b/g);
        
        if (options.includeComments !== false) {
          commentLines += this.countCommentLines(content);
        }

        // Pattern analysis for style detection
        functionalPatterns += this.countPatterns(content, /\.map\(|\.filter\(|\.reduce\(|lambda\s/g);
        objectOrientedPatterns += this.countPatterns(content, /class\s+\w+|new\s+\w+\(|this\./g);
        asyncPatterns += this.countPatterns(content, /async\s+|await\s+|Promise|\.then\(/g);
        syncPatterns += this.countPatterns(content, /synchronized\s+|lock\s*\(/g);

        // Extract rhythmic patterns
        if (options.extractRhythms !== false) {
          rhythmPatterns.push(...this.extractRhythmPatterns(content, relativePath));
        }

        // Extract melodic elements
        if (options.extractMelodies !== false) {
          melodicElements.push(...this.extractMelodicElements(content, relativePath));
        }

        // Extract harmonic elements
        if (options.extractHarmonies !== false) {
          harmonicElements.push(...this.extractHarmonicElements(content, relativePath));
        }

      } catch (error) {
        console.warn(`Failed to analyze ${filePath}:`, error);
      }
    }

    const commentDensity = totalLines > 0 ? commentLines / totalLines : 0;

    return {
      projectPath,
      files,
      musicalPatterns,
      rhythmPatterns,
      melodicElements,
      harmonicElements,
      complexity: {
        cyclomatic: this.calculateCyclomaticComplexity(musicalPatterns),
        rhythmic: this.calculateRhythmicComplexity(rhythmPatterns),
        melodic: this.calculateMelodicComplexity(melodicElements)
      },
      functionCount,
      variableCount,
      controlStructures,
      commentLines,
      commentDensity,
      functionalPatterns,
      objectOrientedPatterns,
      asyncPatterns,
      syncPatterns
    };
  }

  private async findSourceFiles(projectPath: string): Promise<string[]> {
    const pattern = '**/*.{js,ts,jsx,tsx,py,java,cpp,c,cs,php,rb,go,rs,kt,swift}';
    const options = {
      cwd: projectPath,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      nodir: true,
      absolute: true
    };

    return await glob(pattern, options);
  }

  private extractMusicalPatterns(content: string, filePath: string): MusicalPattern[] {
    const patterns: MusicalPattern[] = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      // Detect rhythmic patterns (repetitive structures)
      if (this.isRhythmicPattern(line)) {
        patterns.push({
          type: 'rhythm',
          pattern: line.trim(),
          frequency: this.calculatePatternFrequency(line, content),
          complexity: this.calculateLineComplexity(line),
          file: filePath,
          line: index + 1
        });
      }

      // Detect melodic patterns (function calls, variable names)
      if (this.isMelodicPattern(line)) {
        patterns.push({
          type: 'melody',
          pattern: line.trim(),
          frequency: this.calculatePatternFrequency(line, content),
          complexity: this.calculateLineComplexity(line),
          file: filePath,
          line: index + 1
        });
      }

      // Detect harmonic patterns (nested structures, object properties)
      if (this.isHarmonicPattern(line)) {
        patterns.push({
          type: 'harmony',
          pattern: line.trim(),
          frequency: this.calculatePatternFrequency(line, content),
          complexity: this.calculateLineComplexity(line),
          file: filePath,
          line: index + 1
        });
      }
    });

    return patterns;
  }

  private isRhythmicPattern(line: string): boolean {
    // Patterns that create rhythmic elements
    return /\b(?:for|while|forEach|map|filter|reduce)\b/.test(line) ||
           /\{|\}|\[|\]/.test(line) ||
           /[;,]{2,}/.test(line);
  }

  private isMelodicPattern(line: string): boolean {
    // Patterns that create melodic elements
    return /function\s+\w+|def\s+\w+|\w+\(.*\)/.test(line) ||
           /return\s+|yield\s+/.test(line) ||
           /\w+\.\w+/.test(line);
  }

  private isHarmonicPattern(line: string): boolean {
    // Patterns that create harmonic elements
    return /^\s+/.test(line) || // Indentation creates harmonic layers
           /class\s+\w+|interface\s+\w+/.test(line) ||
           /import\s+.*from|#include/.test(line);
  }

  private extractRhythmPatterns(content: string, filePath: string): any[] {
    const patterns = [];
    
    // Loop patterns create rhythmic foundations
    const loopMatches = content.match(/\b(?:for|while|forEach)\b[^{]*\{/g);
    if (loopMatches) {
      patterns.push({
        name: 'Loop Rhythms',
        patterns: loopMatches,
        frequency: loopMatches.length,
        complexity: this.calculateRhythmicComplexity(loopMatches),
        file: filePath
      });
    }

    // Punctuation patterns create rhythmic accents
    const punctuationPattern = content.match(/[;,\.\?!]/g);
    if (punctuationPattern) {
      patterns.push({
        name: 'Punctuation Rhythm',
        patterns: punctuationPattern,
        frequency: punctuationPattern.length,
        complexity: 1,
        file: filePath
      });
    }

    return patterns;
  }

  private extractMelodicElements(content: string, filePath: string): any[] {
    const elements = [];

    // Function calls create melodic phrases
    const functionCalls = content.match(/\w+\([^)]*\)/g);
    if (functionCalls) {
      elements.push({
        type: 'Function Calls',
        pattern: functionCalls.slice(0, 10).join(', '),
        count: functionCalls.length,
        file: filePath
      });
    }

    // Variable names create melodic themes
    const variableNames = content.match(/(?:let|const|var)\s+(\w+)/g);
    if (variableNames) {
      elements.push({
        type: 'Variable Themes',
        pattern: variableNames.slice(0, 10).join(', '),
        count: variableNames.length,
        file: filePath
      });
    }

    return elements;
  }

  private extractHarmonicElements(content: string, filePath: string): any[] {
    const elements = [];

    // Nested structures create harmonic depth
    const nestingLevel = this.calculateMaxNestingLevel(content);
    if (nestingLevel > 0) {
      elements.push({
        type: 'Nesting Harmony',
        depth: nestingLevel,
        file: filePath
      });
    }

    // Object properties create chord-like structures
    const objectProperties = content.match(/\w+:\s*[^,}]+/g);
    if (objectProperties) {
      elements.push({
        type: 'Object Chords',
        properties: objectProperties.slice(0, 5),
        count: objectProperties.length,
        file: filePath
      });
    }

    return elements;
  }

  private countPatterns(content: string, regex: RegExp): number {
    const matches = content.match(regex);
    return matches ? matches.length : 0;
  }

  private countCommentLines(content: string): number {
    const lines = content.split('\n');
    return lines.filter(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('//') || 
             trimmed.startsWith('#') || 
             trimmed.startsWith('/*') || 
             trimmed.startsWith('*');
    }).length;
  }

  private calculatePatternFrequency(pattern: string, content: string): number {
    const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = content.match(new RegExp(escapedPattern, 'g'));
    return matches ? matches.length : 1;
  }

  private calculateLineComplexity(line: string): number {
    let complexity = 1;
    
    // Increase complexity for control structures
    if (/\b(?:if|for|while|switch|try)\b/.test(line)) complexity += 2;
    
    // Increase complexity for operators
    const operators = line.match(/[+\-*\/=<>!&|]/g);
    if (operators) complexity += operators.length * 0.5;
    
    // Increase complexity for nesting
    const nesting = (line.match(/\{|\(|\[/g) || []).length;
    complexity += nesting;
    
    return Math.round(complexity * 10) / 10;
  }

  private calculateMaxNestingLevel(content: string): number {
    let maxLevel = 0;
    let currentLevel = 0;
    
    for (const char of content) {
      if (char === '{' || char === '(' || char === '[') {
        currentLevel++;
        maxLevel = Math.max(maxLevel, currentLevel);
      } else if (char === '}' || char === ')' || char === ']') {
        currentLevel--;
      }
    }
    
    return maxLevel;
  }

  private calculateCyclomaticComplexity(patterns: MusicalPattern[]): number {
    const totalComplexity = patterns.reduce((sum, pattern) => sum + pattern.complexity, 0);
    return patterns.length > 0 ? totalComplexity / patterns.length : 0;
  }

  private calculateRhythmicComplexity(rhythmPatterns: any[]): number {
    if (rhythmPatterns.length === 0) return 0;
    
    const avgFrequency = rhythmPatterns.reduce((sum, pattern) => sum + pattern.frequency, 0) / rhythmPatterns.length;
    const avgComplexity = rhythmPatterns.reduce((sum, pattern) => sum + (pattern.complexity || 1), 0) / rhythmPatterns.length;
    
    return (avgFrequency * avgComplexity) / 10;
  }

  private calculateMelodicComplexity(melodicElements: any[]): number {
    if (melodicElements.length === 0) return 0;
    
    const totalElements = melodicElements.reduce((sum, element) => sum + (element.count || 1), 0);
    return Math.min(10, totalElements / 10);
  }
}