/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { ToolResult, PlanResultDisplay } from './tools.js';
import type { Config } from '../config/config.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ProjectManagementParams {
  action:
    | 'setup'
    | 'build'
    | 'test'
    | 'update-dependencies'
    | 'init-package'
    | 'check-status';
  projectPath?: string;
  options?: Record<string, unknown>;
}

/**
 * Project Management tool for handling common project lifecycle tasks like setup, build, test, and dependency management.
 */
export class ProjectManagementTool extends BaseDeclarativeTool<
  ProjectManagementParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.PROJECT_MANAGEMENT;

  constructor(private readonly config: Config) {
    const schema = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'setup',
            'build',
            'test',
            'update-dependencies',
            'init-package',
            'check-status',
          ],
          description: 'The project management action to perform',
        },
        projectPath: {
          type: 'string',
          description:
            'The path to the project directory (defaults to current directory)',
        },
        options: {
          type: 'object',
          description: 'Additional options for the action',
          additionalProperties: true,
        },
      },
      required: ['action'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    };

    super(
      ProjectManagementTool.Name,
      ToolDisplayNames.PROJECT_MANAGEMENT,
      'Manage project lifecycle tasks including setup, build, test, and dependency management',
      Kind.Other,
      schema,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected createInvocation(params: ProjectManagementParams) {
    return new ProjectManagementToolInvocation(this.config, params);
  }
}

class ProjectManagementToolInvocation extends BaseToolInvocation<
  ProjectManagementParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ProjectManagementParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Project Management: ${this.params.action} ${this.params.projectPath || 'in current directory'}`;
  }

  async execute(): Promise<ToolResult> {
    const projectPath = this.params.projectPath || this.config.getWorkingDir();

    try {
      switch (this.params.action) {
        case 'setup':
          return await this.setupProject(projectPath);
        case 'build':
          return await this.buildProject(projectPath);
        case 'test':
          return await this.testProject(projectPath);
        case 'update-dependencies':
          return await this.updateDependencies(projectPath);
        case 'init-package':
          return await this.initPackage(projectPath);
        case 'check-status':
          return await this.checkStatus(projectPath);
        default:
          throw new Error(`Unknown action: ${this.params.action}`);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const display: PlanResultDisplay = {
        type: 'plan_summary' as const,
        message: errorMessage,
        plan: `Project management failed: ${errorMessage}`,
      };
      return {
        llmContent: `Project management failed: ${errorMessage}`,
        returnDisplay: display,
      };
    }
  }

  private async setupProject(projectPath: string): Promise<ToolResult> {
    // Detect project type and set up accordingly
    const packageJsonPath = path.join(projectPath, 'package.json');
    const pyProjectPath = path.join(projectPath, 'pyproject.toml');
    const requirementsPath = path.join(projectPath, 'requirements.txt');

    let message = `Setting up project in ${projectPath}\n`;

    try {
      // Check if file exists using fs.access
      await fs.access(packageJsonPath);
      // Node.js project
      message += "Detected Node.js project, running 'npm install'...\n";
      const { stdout, stderr } = await execAsync(
        `cd "${projectPath}" && npm install`,
      );
      message += `npm install result: ${stdout || stderr}`;
    } catch {
      try {
        await fs.access(requirementsPath);
        // Python project
        message += "Detected Python project, running 'pip install'...\n";
        const { stdout, stderr } = await execAsync(
          `cd "${projectPath}" && pip install -r requirements.txt`,
        );
        message += `pip install result: ${stdout || stderr}`;
      } catch {
        try {
          await fs.access(pyProjectPath);
          // Python project with pyproject.toml
          message +=
            "Detected Python project with pyproject.toml, running 'pip install'...\n";
          const { stdout, stderr } = await execAsync(
            `cd "${projectPath}" && pip install -e .`,
          );
          message += `pip install result: ${stdout || stderr}`;
        } catch {
          message +=
            'No standard package management file found. Project setup skipped.';
        }
      }
    }

    const display: PlanResultDisplay = {
      type: 'plan_summary' as const,
      message: 'Project Setup Complete',
      plan: message,
    };
    return {
      llmContent: message,
      returnDisplay: display,
    };
  }

  private async buildProject(projectPath: string): Promise<ToolResult> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    let message = `Building project in ${projectPath}\n`;

    try {
      await fs.access(packageJsonPath);
      // Check if there's a build script in package.json
      try {
        const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(packageJsonContent);

        if (packageJson.scripts && packageJson.scripts.build) {
          message +=
            "Detected build script in package.json, running 'npm run build'...\n";
          const { stdout, stderr } = await execAsync(
            `cd "${projectPath}" && npm run build`,
          );
          message += `Build result: ${stdout || stderr}`;
        } else {
          message += 'No build script found in package.json.';
        }
      } catch (error) {
        message += `Error reading package.json: ${error instanceof Error ? error.message : String(error)}`;
      }
    } catch {
      message += 'No package.json found. Cannot determine build command.';
    }

    const display: PlanResultDisplay = {
      type: 'plan_summary' as const,
      message: 'Build Result',
      plan: message,
    };
    return {
      llmContent: message,
      returnDisplay: display,
    };
  }

  private async testProject(projectPath: string): Promise<ToolResult> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    let message = `Running tests in ${projectPath}\n`;

    try {
      await fs.access(packageJsonPath);
      // Check if there's a test script in package.json
      try {
        const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(packageJsonContent);

        if (
          packageJson.scripts &&
          (packageJson.scripts.test || packageJson.scripts['test:unit'])
        ) {
          const testCommand = packageJson.scripts.test
            ? 'npm run test'
            : 'npm run test:unit';
          message += `Detected test script in package.json, running '${testCommand}'...\n`;
          const { stdout, stderr } = await execAsync(
            `cd "${projectPath}" && ${testCommand}`,
          );
          message += `Test result: ${stdout || stderr}`;
        } else {
          message += 'No test script found in package.json.';
        }
      } catch (error) {
        message += `Error reading package.json: ${error instanceof Error ? error.message : String(error)}`;
      }
    } catch {
      message += 'No package.json found. Cannot determine test command.';
    }

    const display: PlanResultDisplay = {
      type: 'plan_summary' as const,
      message: 'Test Result',
      plan: message,
    };
    return {
      llmContent: message,
      returnDisplay: display,
    };
  }

  private async updateDependencies(projectPath: string): Promise<ToolResult> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    let message = `Updating dependencies in ${projectPath}\n`;

    try {
      await fs.access(packageJsonPath);
      message += 'Updating Node.js dependencies...\n';
      const { stdout, stderr } = await execAsync(
        `cd "${projectPath}" && npm update`,
      );
      message += `Update result: ${stdout || stderr}`;
    } catch {
      message += 'No package.json found. Cannot update dependencies.';
    }

    const display: PlanResultDisplay = {
      type: 'plan_summary' as const,
      message: 'Dependency Update Result',
      plan: message,
    };
    return {
      llmContent: message,
      returnDisplay: display,
    };
  }

  private async initPackage(projectPath: string): Promise<ToolResult> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    let message = `Initializing package in ${projectPath}\n`;

    try {
      await fs.access(packageJsonPath);
      message += 'package.json already exists in this directory.';
    } catch {
      message += 'Creating new package.json file...\n';
      const defaultPackageJson = {
        name: path.basename(projectPath),
        version: '1.0.0',
        description: '',
        main: 'index.js',
        scripts: {
          test: 'echo "Error: no test specified" && exit 1',
        },
        keywords: [],
        author: '',
        license: 'ISC',
      };

      await fs.writeFile(
        packageJsonPath,
        JSON.stringify(defaultPackageJson, null, 2),
      );

      message += 'Successfully created package.json with default values.';
    }

    const display: PlanResultDisplay = {
      type: 'plan_summary' as const,
      message: 'Package Initialization Result',
      plan: message,
    };
    return {
      llmContent: message,
      returnDisplay: display,
    };
  }

  private async checkStatus(projectPath: string): Promise<ToolResult> {
    let message = `Checking project status in ${projectPath}\n`;

    // Check for common project files
    const filesToCheck = [
      'package.json',
      'requirements.txt',
      'pyproject.toml',
      'Gemfile',
      'pom.xml',
      'build.gradle',
      '.git',
      'README.md',
      'CHANGELOG.md',
      'LICENSE',
    ];

    for (const file of filesToCheck) {
      const filePath = path.join(projectPath, file);
      try {
        await fs.access(filePath);
        message += `✓ Found: ${file}\n`;
      } catch {
        message += `✗ Missing: ${file}\n`;
      }
    }

    // Check git status if .git exists
    const gitDir = path.join(projectPath, '.git');
    try {
      await fs.access(gitDir);
      try {
        const { stdout } = await execAsync(
          `cd "${projectPath}" && git status --porcelain`,
        );

        if (stdout.trim()) {
          message += `\nGit changes detected:\n${stdout}`;
        } else {
          message += '\nGit: Working directory is clean';
        }
      } catch (error) {
        message += `\nGit: Error checking status - ${error instanceof Error ? error.message : String(error)}`;
      }
    } catch {
      // .git doesn't exist, so we don't need to check git status
    }

    const display: PlanResultDisplay = {
      type: 'plan_summary' as const,
      message: 'Project Status Check',
      plan: message,
    };
    return {
      llmContent: message,
      returnDisplay: display,
    };
  }
}
