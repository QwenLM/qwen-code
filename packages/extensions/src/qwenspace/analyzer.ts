/**
 * VR Code Analyzer for QwenSpace
 * Analyzes code for VR collaboration opportunities
 */

export interface VRAnalysisOptions {
  checkVRCompatibility?: boolean;
  identifyCollaborationPoints?: boolean;
  assessCodeComplexity?: boolean;
  findReviewTargets?: boolean;
}

export interface CollaborationPoint {
  file: string;
  line: number;
  type: 'review' | 'pair-program' | 'discuss' | 'refactor';
  description: string;
  complexity: number;
  priority: 'high' | 'medium' | 'low';
  suggestedUsers: number;
}

export interface VRCodeAnalysis {
  projectPath: string;
  files: string[];
  collaborationPoints: CollaborationPoint[];
  complexFunctions: any[];
  documentationNeeded: any[];
  testGaps: any[];
  vrReadinessScore: number;
  recommendedEnvironment: string;
  maxUsers: number;
  sessionTime: number;
  recommendedFeatures: string[];
}

export class VRCodeAnalyzer {
  async analyze(projectPath: string, options: VRAnalysisOptions = {}): Promise<VRCodeAnalysis> {
    console.log('🥽 Analyzing codebase for VR collaboration...');

    const files = await this.findRelevantFiles(projectPath);
    const collaborationPoints: CollaborationPoint[] = [];
    const complexFunctions: any[] = [];
    const documentationNeeded: any[] = [];
    const testGaps: any[] = [];

    for (const filePath of files) {
      try {
        const content = await this.readFile(filePath);
        const fileAnalysis = await this.analyzeFile(content, filePath, projectPath);
        
        collaborationPoints.push(...fileAnalysis.collaborationPoints);
        complexFunctions.push(...fileAnalysis.complexFunctions);
        documentationNeeded.push(...fileAnalysis.documentationNeeded);
        testGaps.push(...fileAnalysis.testGaps);
      } catch (error) {
        console.warn(`Failed to analyze ${filePath}:`, error);
      }
    }

    const vrReadinessScore = this.calculateVRReadiness(files, collaborationPoints, complexFunctions);
    const recommendedEnvironment = this.recommendEnvironment(collaborationPoints, complexFunctions);
    const maxUsers = this.calculateOptimalUserCount(collaborationPoints);
    const sessionTime = this.estimateSessionTime(collaborationPoints, complexFunctions);
    const recommendedFeatures = this.recommendFeatures(collaborationPoints, complexFunctions);

    return {
      projectPath,
      files,
      collaborationPoints: this.prioritizeCollaborationPoints(collaborationPoints),
      complexFunctions: complexFunctions.slice(0, 10),
      documentationNeeded: documentationNeeded.slice(0, 10),
      testGaps: testGaps.slice(0, 10),
      vrReadinessScore,
      recommendedEnvironment,
      maxUsers,
      sessionTime,
      recommendedFeatures
    };
  }

  private async findRelevantFiles(projectPath: string): Promise<string[]> {
    // Simplified file discovery - in real implementation would use glob
    const fs = await import('fs/promises');
    const path = await import('path');
    
    async function findFiles(dir: string): Promise<string[]> {
      const files: string[] = [];
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            files.push(...await findFiles(fullPath));
          } else if (this.isRelevantFile(entry.name)) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        // Directory not accessible
      }
      
      return files;
    }
    
    return findFiles.call(this, projectPath);
  }

  private isRelevantFile(filename: string): boolean {
    const relevantExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.cs', '.go', '.rs'];
    return relevantExtensions.some(ext => filename.endsWith(ext));
  }

  private async readFile(filePath: string): Promise<string> {
    const fs = await import('fs/promises');
    return fs.readFile(filePath, 'utf8');
  }

  private async analyzeFile(content: string, filePath: string, projectPath: string): Promise<{
    collaborationPoints: CollaborationPoint[];
    complexFunctions: any[];
    documentationNeeded: any[];
    testGaps: any[];
  }> {
    const path = await import('path');
    const relativePath = path.relative(projectPath, filePath);
    const lines = content.split('\n');

    const collaborationPoints: CollaborationPoint[] = [];
    const complexFunctions: any[] = [];
    const documentationNeeded: any[] = [];
    const testGaps: any[] = [];

    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      
      // Identify collaboration opportunities
      if (this.isComplexLine(line)) {
        collaborationPoints.push({
          file: relativePath,
          line: lineNumber,
          type: 'pair-program',
          description: 'Complex logic that benefits from pair programming',
          complexity: this.calculateLineComplexity(line),
          priority: 'high',
          suggestedUsers: 2
        });
      }

      // Find functions that need review
      if (this.isFunctionDefinition(line)) {
        const functionName = this.extractFunctionName(line);
        const complexity = this.calculateFunctionComplexity(content, lineNumber);
        
        if (complexity > 7) {
          collaborationPoints.push({
            file: relativePath,
            line: lineNumber,
            type: 'review',
            description: `Function ${functionName} has high complexity and needs review`,
            complexity,
            priority: 'high',
            suggestedUsers: 3
          });
          
          complexFunctions.push({
            name: functionName,
            file: relativePath,
            line: lineNumber,
            complexity
          });
        }
      }

      // Identify TODO comments
      if (line.includes('TODO') || line.includes('FIXME')) {
        collaborationPoints.push({
          file: relativePath,
          line: lineNumber,
          type: 'discuss',
          description: 'TODO/FIXME that needs team discussion',
          complexity: 3,
          priority: 'medium',
          suggestedUsers: 2
        });
      }

      // Find areas needing documentation
      if (this.needsDocumentation(line, lines, index)) {
        documentationNeeded.push({
          file: relativePath,
          line: lineNumber,
          reason: 'Complex function without proper documentation'
        });
        
        collaborationPoints.push({
          file: relativePath,
          line: lineNumber,
          type: 'discuss',
          description: 'Needs documentation and explanation',
          complexity: 4,
          priority: 'medium',
          suggestedUsers: 2
        });
      }
    });

    // Identify test gaps
    if (!this.hasCorrespondingTest(relativePath)) {
      testGaps.push({
        file: relativePath,
        reason: 'No corresponding test file found'
      });
    }

    return {
      collaborationPoints,
      complexFunctions,
      documentationNeeded,
      testGaps
    };
  }

  private isComplexLine(line: string): boolean {
    // Check for complexity indicators
    const complexityIndicators = [
      /\?\s*:.*\?\s*:/, // Nested ternary
      /&&.*\|\|.*&&/, // Complex boolean logic
      /\w+\.\w+\.\w+\.\w+/, // Deep property access
      /for\s*\(.*for\s*\(/, // Nested loops
      /if\s*\(.*if\s*\(/ // Nested conditions
    ];
    
    return complexityIndicators.some(pattern => pattern.test(line));
  }

  private isFunctionDefinition(line: string): boolean {
    return /(?:function\s+\w+|def\s+\w+|const\s+\w+\s*=\s*\(|class\s+\w+)/.test(line);
  }

  private extractFunctionName(line: string): string {
    const match = line.match(/(?:function\s+(\w+)|def\s+(\w+)|const\s+(\w+)|class\s+(\w+))/);
    return match ? (match[1] || match[2] || match[3] || match[4]) : 'anonymous';
  }

  private calculateLineComplexity(line: string): number {
    let complexity = 1;
    
    // Count complexity contributors
    if (/if|else|while|for|switch|try|catch/.test(line)) complexity += 2;
    if (/&&|\|\|/.test(line)) complexity += 1;
    if (/\?.*:/.test(line)) complexity += 1;
    if (/\{|\}|\[|\]|\(|\)/.test(line)) {
      const brackets = line.match(/[\{\}\[\]\(\)]/g);
      complexity += brackets ? brackets.length * 0.5 : 0;
    }
    
    return Math.round(complexity);
  }

  private calculateFunctionComplexity(content: string, startLine: number): number {
    // Simplified cyclomatic complexity calculation
    const lines = content.split('\n');
    let complexity = 1;
    let braceCount = 0;
    let inFunction = false;
    
    for (let i = startLine - 1; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.includes('{')) {
        braceCount += (line.match(/\{/g) || []).length;
        inFunction = true;
      }
      if (line.includes('}')) {
        braceCount -= (line.match(/\}/g) || []).length;
        if (braceCount <= 0 && inFunction) break;
      }
      
      if (inFunction) {
        // Count decision points
        if (/\bif\b|\belse\b|\bwhile\b|\bfor\b|\bswitch\b|\bcase\b/.test(line)) {
          complexity += 1;
        }
        if (/&&|\|\|/.test(line)) {
          complexity += (line.match(/&&|\|\|/g) || []).length;
        }
        if (/\?.*:/.test(line)) {
          complexity += 1;
        }
      }
    }
    
    return complexity;
  }

  private needsDocumentation(line: string, lines: string[], index: number): boolean {
    if (!this.isFunctionDefinition(line)) return false;
    
    // Check if previous lines contain documentation
    for (let i = Math.max(0, index - 3); i < index; i++) {
      const prevLine = lines[i].trim();
      if (prevLine.startsWith('//') || prevLine.startsWith('/*') || prevLine.startsWith('*')) {
        return false;
      }
    }
    
    return true;
  }

  private hasCorrespondingTest(filePath: string): boolean {
    // Simplified check - in real implementation would check filesystem
    return filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('/test/');
  }

  private prioritizeCollaborationPoints(points: CollaborationPoint[]): CollaborationPoint[] {
    return points.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return b.complexity - a.complexity;
    });
  }

  private calculateVRReadiness(files: string[], collaborationPoints: CollaborationPoint[], complexFunctions: any[]): number {
    let score = 50; // Base score
    
    // More files = better for collaboration
    score += Math.min(files.length / 10, 20);
    
    // More collaboration points = higher readiness
    score += Math.min(collaborationPoints.length / 5, 15);
    
    // Complex functions are good for VR collaboration
    score += Math.min(complexFunctions.length / 3, 10);
    
    // Bonus for having various file types
    const extensions = new Set(files.map(f => f.split('.').pop()));
    score += Math.min(extensions.size * 2, 10);
    
    return Math.min(Math.round(score), 100);
  }

  private recommendEnvironment(collaborationPoints: CollaborationPoint[], complexFunctions: any[]): string {
    if (complexFunctions.length > 10) return 'cyber';
    if (collaborationPoints.length > 15) return 'office';
    if (collaborationPoints.filter(p => p.type === 'pair-program').length > 5) return 'space';
    return 'office';
  }

  private calculateOptimalUserCount(collaborationPoints: CollaborationPoint[]): number {
    const suggestedUsers = collaborationPoints.reduce((sum, point) => sum + point.suggestedUsers, 0);
    const avgUsers = collaborationPoints.length > 0 ? suggestedUsers / collaborationPoints.length : 2;
    return Math.min(Math.max(Math.round(avgUsers * 2), 2), 8);
  }

  private estimateSessionTime(collaborationPoints: CollaborationPoint[], complexFunctions: any[]): number {
    let time = 15; // Base time
    
    time += collaborationPoints.length * 3; // 3 minutes per collaboration point
    time += complexFunctions.length * 5; // 5 minutes per complex function
    
    return Math.min(Math.round(time), 120); // Max 2 hours
  }

  private recommendFeatures(collaborationPoints: CollaborationPoint[], complexFunctions: any[]): string[] {
    const features = ['code-editing', 'voice-chat'];
    
    if (collaborationPoints.length > 10) features.push('screen-share');
    if (complexFunctions.length > 5) features.push('whiteboard');
    if (collaborationPoints.filter(p => p.type === 'discuss').length > 3) features.push('annotation');
    if (collaborationPoints.filter(p => p.type === 'review').length > 5) features.push('code-review');
    
    return features;
  }
}