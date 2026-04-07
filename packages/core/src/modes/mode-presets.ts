/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Mode Presets — predefined mode configurations for
 * common project types and workflows.
 *
 * Presets bundle multiple modes with recommended settings, hooks,
 * and sub-agent preferences for specific development contexts.
 */

import type { ModeConfig } from './types.js';
import type { ModeHook } from './mode-hooks.js';

/**
 * A mode preset bundles mode configurations with recommended settings
 * for a specific project type or workflow.
 */
export interface ModePreset {
  /** Unique preset identifier */
  name: string;

  /** Display name */
  displayName: string;

  /** Description of when to use this preset */
  description: string;

  /** Icon for visual identification */
  icon: string;

  /** Recommended default mode */
  defaultMode: string;

  /** Recommended mode order for workflow */
  workflow?: string[];

  /** Project type indicators */
  projectType?: {
    /** File patterns that indicate this project type */
    filePatterns?: string[];
    /** Dependencies that indicate this project type */
    dependencies?: string[];
  };

  /** Mode-specific configurations */
  modes?: {
    [modeName: string]: {
      /** Override mode's systemPrompt */
      systemPromptOverride?: string;
      /** Override allowed tools */
      allowedToolsOverride?: string[];
      /** Override denied tools */
      deniedToolsOverride?: string[];
      /** Override temperature */
      temperatureOverride?: number;
      /** Recommended hooks for this mode */
      hooks?: ModeHook[];
    };
  };

  /** Recommended sub-agents to use */
  recommendedSubagents?: string[];

  /** Recommended skills to activate */
  recommendedSkills?: string[];

  /** Environment variables to suggest */
  suggestedEnv?: Array<{
    name: string;
    description: string;
    default?: string;
  }>;

  /** Quick start commands */
  quickStart?: string[];
}

/**
 * Built-in mode presets for common project types.
 */
export const BUILTIN_PRESETS: ModePreset[] = [
  {
    name: 'react-app',
    displayName: 'React Application',
    description: 'Full-stack React application development',
    icon: '⚛️',
    defaultMode: 'developer',
    workflow: ['product', 'architect', 'developer', 'tester', 'reviewer'],
    projectType: {
      filePatterns: [
        'package.json',
        '**/*.tsx',
        '**/*.jsx',
        'vite.config.*',
        'next.config.*',
        'tsconfig.json',
      ],
      dependencies: ['react', 'react-dom'],
    },
    modes: {
      developer: {
        temperatureOverride: 0.5,
        hooks: [
          {
            trigger: 'onEnter',
            commandType: 'shell',
            command: 'npm install 2>/dev/null || true',
            description: 'Install dependencies on enter',
          },
          {
            trigger: 'beforeAction',
            commandType: 'shell',
            command: 'npx tsc --noEmit 2>/dev/null || true',
            description: 'Type check before changes',
            continueOnError: true,
          },
        ],
      },
      tester: {
        hooks: [
          {
            trigger: 'onEnter',
            commandType: 'shell',
            command: 'npm test -- --passWithNoTests 2>/dev/null || true',
            description: 'Run existing tests on enter',
            continueOnError: true,
          },
        ],
      },
    },
    recommendedSubagents: ['general-purpose', 'Explore'],
    recommendedSkills: ['test-patterns'],
    quickStart: [
      '/mode product "Define user stories for the feature"',
      '/mode developer "Implement the feature"',
      '/mode tester "Add tests"',
      '/mode reviewer "Review the implementation"',
    ],
  },
  {
    name: 'api-service',
    displayName: 'API Service',
    description: 'Backend API service development',
    icon: '🔌',
    defaultMode: 'developer',
    workflow: ['architect', 'developer', 'security', 'devops'],
    projectType: {
      filePatterns: [
        'package.json',
        'Dockerfile',
        'docker-compose.yml',
        '**/routes/**',
        '**/controllers/**',
        'prisma/**',
        'migrations/**',
      ],
      dependencies: ['express', 'fastify', 'nestjs', 'prisma', 'sequelize'],
    },
    modes: {
      developer: {
        temperatureOverride: 0.4,
        hooks: [
          {
            trigger: 'afterAction',
            commandType: 'shell',
            command: 'npm run lint -- --fix 2>/dev/null || true',
            description: 'Auto-fix lint after changes',
            continueOnError: true,
          },
        ],
      },
      security: {
        hooks: [
          {
            trigger: 'onEnter',
            commandType: 'shell',
            command: 'npm audit 2>/dev/null || true',
            description: 'Run security audit on enter',
            continueOnError: true,
          },
        ],
      },
    },
    recommendedSubagents: ['general-purpose', 'Explore'],
    recommendedSkills: ['secure-coding-guidelines'],
    quickStart: [
      '/mode architect "Design API endpoints"',
      '/mode developer "Implement the service"',
      '/mode security "Security audit"',
      '/mode devops "Setup CI/CD"',
    ],
  },
  {
    name: 'data-pipeline',
    displayName: 'Data Pipeline',
    description: 'Data processing and ETL pipeline development',
    icon: '📊',
    defaultMode: 'developer',
    workflow: ['architect', 'developer', 'optimizer', 'tester'],
    projectType: {
      filePatterns: [
        '**/pipelines/**',
        '**/etl/**',
        '**/dag/**',
        'requirements.txt',
        'pyproject.toml',
        'Dockerfile',
      ],
      dependencies: ['pandas', 'apache-beam', 'airflow', 'spark'],
    },
    modes: {
      developer: {
        temperatureOverride: 0.3,
      },
      optimizer: {
        hooks: [
          {
            trigger: 'onEnter',
            commandType: 'message',
            command: '💡 Focus on data processing efficiency and memory usage',
            description: 'Optimization reminder',
          },
        ],
      },
    },
    recommendedSubagents: ['general-purpose'],
    recommendedSkills: ['profiling-techniques'],
    quickStart: [
      '/mode architect "Design data pipeline architecture"',
      '/mode developer "Implement pipeline"',
      '/mode optimizer "Optimize processing"',
      '/mode tester "Add data validation tests"',
    ],
  },
  {
    name: 'full-stack',
    displayName: 'Full-Stack Development',
    description: 'Simultaneous frontend and backend development',
    icon: '🚀',
    defaultMode: 'developer',
    workflow: ['product', 'architect', 'developer', 'tester', 'reviewer', 'devops'],
    projectType: {
      filePatterns: [
        'package.json',
        'frontend/**',
        'backend/**',
        'docker-compose.yml',
      ],
    },
    modes: {
      developer: {
        temperatureOverride: 0.6,
      },
    },
    recommendedSubagents: ['general-purpose', 'Explore'],
    quickStart: [
      '/parallel split "Implement feature X"',
      '/mode tester "Test both frontend and backend"',
      '/mode reviewer "Review the full implementation"',
    ],
  },
  {
    name: 'mobile-app',
    displayName: 'Mobile Application',
    description: 'React Native / Flutter mobile app development',
    icon: '📱',
    defaultMode: 'developer',
    workflow: ['architect', 'developer', 'tester', 'reviewer'],
    projectType: {
      filePatterns: [
        'pubspec.yaml',
        '**/*.dart',
        'App.tsx',
        'ios/**',
        'android/**',
      ],
      dependencies: ['react-native', 'flutter'],
    },
    modes: {
      developer: {
        temperatureOverride: 0.5,
      },
      tester: {
        hooks: [
          {
            trigger: 'onEnter',
            commandType: 'message',
            command: '💡 Test on both iOS and Android simulators',
            description: 'Mobile testing reminder',
          },
        ],
      },
    },
    recommendedSubagents: ['general-purpose', 'Explore'],
    quickStart: [
      '/mode architect "Design mobile app architecture"',
      '/mode developer "Implement screens and features"',
      '/mode tester "Test on both platforms"',
      '/mode reviewer "Review code quality"',
    ],
  },
  {
    name: 'cli-tool',
    displayName: 'CLI Tool',
    description: 'Command-line interface tool development',
    icon: '💻',
    defaultMode: 'developer',
    workflow: ['architect', 'developer', 'tester', 'reviewer'],
    projectType: {
      filePatterns: [
        'package.json',
        'bin/**',
        'src/cli/**',
        'src/commands/**',
      ],
    },
    modes: {
      developer: {
        temperatureOverride: 0.4,
        hooks: [
          {
            trigger: 'afterAction',
            commandType: 'shell',
            command: 'npm run build 2>/dev/null || true',
            description: 'Rebuild after changes',
            continueOnError: true,
          },
        ],
      },
    },
    recommendedSubagents: ['general-purpose', 'Explore'],
    quickStart: [
      '/mode architect "Design CLI command structure"',
      '/mode developer "Implement commands"',
      '/mode tester "Add unit and integration tests"',
    ],
  },
];

/**
 * Registry and manager for mode presets.
 */
export class ModePresetRegistry {
  private presets: Map<string, ModePreset> = new Map();

  constructor() {
    // Register built-in presets
    for (const preset of BUILTIN_PRESETS) {
      this.presets.set(preset.name, preset);
    }
  }

  /**
   * Get a preset by name.
   */
  getPreset(name: string): ModePreset | undefined {
    return this.presets.get(name);
  }

  /**
   * Get all registered presets.
   */
  getAllPresets(): ModePreset[] {
    return Array.from(this.presets.values());
  }

  /**
   * Register a custom preset.
   */
  registerPreset(preset: ModePreset): void {
    this.presets.set(preset.name, preset);
  }

  /**
   * Detect which preset matches a project based on file patterns.
   */
  async detectPreset(
    projectDir: string,
    files: string[],
    dependencies: string[],
  ): Promise<ModePreset | null> {
    for (const preset of this.presets.values()) {
      if (!preset.projectType) continue;

      const { filePatterns, dependencies: presetDeps } = preset.projectType;
      let score = 0;

      // Check file patterns
      if (filePatterns) {
        for (const pattern of filePatterns) {
          if (files.some((f) => f.includes(pattern.replace(/\*\*\/?/g, '')))) {
            score += 1;
          }
        }
      }

      // Check dependencies
      if (presetDeps) {
        for (const dep of presetDeps) {
          if (dependencies.includes(dep)) {
            score += 2;
          }
        }
      }

      // If enough matches, return this preset
      if (score >= 3) {
        return preset;
      }
    }

    return null;
  }
}
