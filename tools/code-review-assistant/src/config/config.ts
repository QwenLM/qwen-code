import { Config as QwenConfig } from '@qwen-code/qwen-code-core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CodeReviewConfig {
  maxFileSize: number;
  excludedPatterns: string[];
  severityThreshold: 'low' | 'medium' | 'high' | 'critical';
  outputFormats: string[];
  autoFix: boolean;
  reviewCategories: string[];
}

export async function loadConfig(): Promise<QwenConfig> {
  // Load qwen-code configuration
  const config = new QwenConfig();
  
  // Load code review specific configuration
  const reviewConfig = await loadCodeReviewConfig();
  
  // Merge configurations
  config.set('codeReview', reviewConfig);
  
  return config;
}

export async function loadCodeReviewConfig(): Promise<CodeReviewConfig> {
  const configPath = path.join(os.homedir(), '.qwen', 'code-review.json');
  
  const defaultConfig: CodeReviewConfig = {
    maxFileSize: 1024 * 1024, // 1MB
    excludedPatterns: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '*.min.js',
      '*.bundle.js'
    ],
    severityThreshold: 'low',
    outputFormats: ['console', 'json', 'markdown'],
    autoFix: false,
    reviewCategories: [
      'Code Quality',
      'Security',
      'Performance',
      'Maintainability',
      'Best Practices'
    ]
  };
  
  try {
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const userConfig = JSON.parse(configContent);
      return { ...defaultConfig, ...userConfig };
    }
  } catch (error) {
    console.warn('Warning: Could not load code review config, using defaults');
  }
  
  return defaultConfig;
}

export async function saveCodeReviewConfig(config: CodeReviewConfig): Promise<void> {
  const configDir = path.join(os.homedir(), '.qwen');
  const configPath = path.join(configDir, 'code-review.json');
  
  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (error) {
    throw new Error(`Failed to save configuration: ${error}`);
  }
}