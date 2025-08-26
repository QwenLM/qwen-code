# Qwen Code: End-to-End Tutorial

## Getting Started with Qwen Code

This comprehensive tutorial will guide you through setting up, using, and extending Qwen Code for various workflows.

## Table of Contents
1. [Installation and Setup](#installation-and-setup)
2. [First Steps](#first-steps)
3. [Basic Code Operations](#basic-code-operations)
4. [Advanced Workflows](#advanced-workflows)
5. [Custom Tool Development](#custom-tool-development)
6. [Integration with IDEs](#integration-with-ides)
7. [Session Management](#session-management)
8. [Troubleshooting](#troubleshooting)

## Installation and Setup

### Prerequisites
- Node.js 20+ installed
- API access to a compatible LLM provider

### Step 1: Install Qwen Code

```bash
# Install from npm (recommended)
npm install -g @qwen-code/qwen-code@latest

# Or install from source
git clone https://github.com/QwenLM/qwen-code.git
cd qwen-code
npm install
npm install -g .
```

### Step 2: Configure API Access

Qwen Code supports multiple API providers. Choose your preferred option:

#### Option A: Environment Variables
```bash
# For OpenRouter (free tier available)
export OPENAI_API_KEY="your_api_key_here"
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
export OPENAI_MODEL="qwen/qwen3-coder:free"

# For Alibaba Cloud (Qwen models)
export OPENAI_API_KEY="your_api_key_here"
export OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export OPENAI_MODEL="qwen3-coder-plus"
```

#### Option B: Project Configuration
Create `.env` file in your project root:
```env
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=qwen/qwen3-coder:free
```

### Step 3: Verify Installation

```bash
qwen --version
```

## First Steps

### Starting Qwen Code

```bash
# Start in current directory
qwen

# Start with specific configuration
qwen --config /path/to/config.json
```

You'll see the Qwen Code prompt:
```
🔮 Qwen Code v0.0.1-alpha.12
Type your request or /help for commands

>
```

### Basic Commands

Try these essential commands:

```bash
# Get help
> /help

# Check session status
> /status

# Clear conversation history
> /clear

# Compress history to save tokens
> /compress

# Exit
> /exit
```

### Your First Query

```bash
> Explain the structure of this codebase
```

Qwen Code will analyze your project structure and provide insights about:
- Main components and their purposes
- Dependencies and relationships
- Architecture patterns used
- Key entry points

## Basic Code Operations

### Understanding Code

```bash
# Analyze specific files
> Explain what this main.js file does and how it works

# Understand patterns
> What design patterns are used in this codebase?

# Find specific functionality
> Where is the authentication logic implemented?

# Dependency analysis
> What are the main dependencies and how are they used?
```

### Code Reading and Analysis

```bash
# Read and explain a file
> Read the package.json file and explain the project configuration

# Compare files
> Compare the differences between config.dev.js and config.prod.js

# Find patterns across files
> Find all API endpoints defined in this codebase
```

### Code Editing and Refactoring

```bash
# Refactor functions
> Refactor the getUserData function to use async/await instead of promises

# Add error handling
> Add proper error handling to all database operations in this file

# Optimize performance
> Identify and fix performance issues in this React component

# Add type safety
> Add TypeScript types to this JavaScript module
```

## Advanced Workflows

### Project Setup and Scaffolding

```bash
# Create new project structure
> Create a new Express.js API with authentication, database integration, and testing setup

# Add features to existing project
> Add a rate limiting middleware to this Express application

# Set up development tools
> Configure ESLint, Prettier, and Husky for this project
```

### Automated Testing

```bash
# Generate unit tests
> Generate comprehensive unit tests for the UserService class

# Create integration tests
> Create integration tests for the REST API endpoints

# Add test utilities
> Create test utilities and mock factories for this project
```

### Documentation Generation

```bash
# Generate API documentation
> Generate OpenAPI/Swagger documentation for this REST API

# Create README files
> Create a comprehensive README for this project with setup instructions

# Add code comments
> Add JSDoc comments to all public methods in this module
```

### Git and Version Control

```bash
# Analyze git history
> Analyze git commits from the last month and create a changelog

# Create commit messages
> Generate appropriate commit messages for these staged changes

# Find issues
> Find all TODO and FIXME comments and create GitHub issues for them
```

### Code Quality and Security

```bash
# Security audit
> Perform a security audit of this codebase and identify vulnerabilities

# Code review
> Review this pull request and provide feedback on code quality

# Performance analysis
> Analyze the performance of this application and suggest optimizations
```

## Custom Tool Development

### Creating a Custom Tool

Let's create a simple tool that counts lines of code:

```typescript
// tools/line-counter.ts
import { BaseTool, ToolResult } from '@qwen-code/qwen-code-core';
import { Type } from '@sinclair/typebox';
import * as fs from 'fs/promises';
import * as path from 'path';

interface LineCounterParams {
  directory: string;
  extensions?: string[];
}

export class LineCounterTool extends BaseTool<LineCounterParams, ToolResult> {
  constructor() {
    super(
      'line-counter',
      'Line Counter',
      'Counts lines of code in a directory by file extension',
      {
        type: Type.Object({
          directory: Type.String({
            description: 'Directory to analyze'
          }),
          extensions: Type.Optional(Type.Array(Type.String(), {
            description: 'File extensions to include (e.g., [".ts", ".js"])'
          }))
        }),
        required: ['directory']
      }
    );
  }

  async execute(params: LineCounterParams, abortSignal: AbortSignal): Promise<ToolResult> {
    try {
      const { directory, extensions = ['.ts', '.js', '.tsx', '.jsx'] } = params;
      const stats = await this.countLines(directory, extensions);
      
      return {
        success: true,
        result: `Line count analysis:\n${this.formatResults(stats)}`
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to count lines: ${error.message}`
      };
    }
  }

  private async countLines(dir: string, extensions: string[]): Promise<Record<string, number>> {
    const stats: Record<string, number> = {};
    
    const files = await this.getFiles(dir, extensions);
    
    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n').length;
      const ext = path.extname(file);
      stats[ext] = (stats[ext] || 0) + lines;
    }
    
    return stats;
  }

  private async getFiles(dir: string, extensions: string[]): Promise<string[]> {
    const files: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        files.push(...await this.getFiles(fullPath, extensions));
      } else if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
        files.push(fullPath);
      }
    }
    
    return files;
  }

  private formatResults(stats: Record<string, number>): string {
    return Object.entries(stats)
      .map(([ext, count]) => `${ext}: ${count} lines`)
      .join('\n');
  }
}
```

### Registering the Custom Tool

```typescript
// tools/index.ts
import { ToolRegistry } from '@qwen-code/qwen-code-core';
import { LineCounterTool } from './line-counter.js';

// Register the custom tool
ToolRegistry.register(new LineCounterTool());
```

### Using the Custom Tool

```bash
> Count the lines of code in this project by file type
```

The LLM will automatically discover and use your custom tool!

## Integration with IDEs

### VS Code Integration

1. Install the Qwen Code VS Code extension
2. Configure your API settings
3. Use commands:
   - `Ctrl+Shift+P` → "Qwen Code: Explain Selection"
   - `Ctrl+Shift+P` → "Qwen Code: Refactor Code"
   - `Ctrl+Shift+P` → "Qwen Code: Generate Tests"

### Other Editors

Qwen Code can be integrated with any editor that supports external commands:

```bash
# Vim integration
:!qwen "Explain this function" < %

# Emacs integration
(shell-command-on-region (point-min) (point-max) "qwen 'Explain this code'")
```

## Session Management

### Understanding Token Usage

```bash
# Check current session status
> /status

# Output:
# Session: active
# Messages: 15
# Estimated tokens: 2,847 / 32,000
# Model: qwen3-coder-plus
```

### Managing Long Conversations

```bash
# Compress history when approaching limit
> /compress

# Clear history for fresh start
> /clear

# Set custom token limit
```

### Configuration

Create `~/.qwen/settings.json`:
```json
{
  "sessionTokenLimit": 32000,
  "defaultModel": "qwen3-coder-plus",
  "autoCompress": true,
  "theme": "dark"
}
```

## Workflow Examples

### Example 1: Full-Stack Development

```bash
# 1. Project setup
> Create a new React + Node.js project with TypeScript, authentication, and database integration

# 2. Database design
> Design a database schema for a task management application

# 3. API development
> Create REST API endpoints for task CRUD operations with proper validation

# 4. Frontend development
> Create React components for the task management interface

# 5. Testing
> Generate unit and integration tests for the entire application

# 6. Documentation
> Create API documentation and user guides
```

### Example 2: Code Migration

```bash
# 1. Analysis
> Analyze this jQuery codebase and identify components that need modernization

# 2. Planning
> Create a migration plan from jQuery to React

# 3. Implementation
> Convert this jQuery component to a React functional component with hooks

# 4. Testing
> Create tests for the migrated components

# 5. Optimization
> Optimize the migrated code for performance and best practices
```

### Example 3: Bug Investigation

```bash
# 1. Initial analysis
> This application is crashing with "Cannot read property 'id' of undefined". Help me debug this.

# 2. Code review
> Review the error logs and identify the root cause

# 3. Fix implementation
> Fix the bug and add proper error handling

# 4. Prevention
> Add type checking and validation to prevent similar issues

# 5. Testing
> Create regression tests for this bug fix
```

## Best Practices

### Effective Prompting

1. **Be Specific**: Instead of "fix this code", say "fix the memory leak in the event listener cleanup"
2. **Provide Context**: Include relevant file names, error messages, and requirements
3. **Break Down Complex Tasks**: Split large requests into smaller, manageable steps
4. **Use Domain Language**: Use proper technical terminology for better understanding

### Session Management

1. **Monitor Token Usage**: Use `/status` regularly to check token consumption
2. **Compress Proactively**: Use `/compress` before reaching token limits
3. **Clear When Switching Contexts**: Use `/clear` when changing to unrelated tasks
4. **Save Important Conversations**: Copy important outputs before clearing

### Tool Usage

1. **Understand Tool Capabilities**: Know what each tool can and cannot do
2. **Verify Tool Results**: Always review and test generated code
3. **Combine Tools Effectively**: Use multiple tools in sequence for complex tasks
4. **Respect Safety Measures**: Understand why certain operations require confirmation

## Troubleshooting

### Common Issues

#### API Connection Problems
```bash
# Check API configuration
echo $OPENAI_API_KEY
echo $OPENAI_BASE_URL

# Test connectivity
curl -H "Authorization: Bearer $OPENAI_API_KEY" $OPENAI_BASE_URL/models
```

#### Token Limit Exceeded
```bash
# Check session status
> /status

# Compress history
> /compress

# Or clear and start fresh
> /clear
```

#### Tool Execution Failures
```bash
# Check file permissions
ls -la

# Verify tool configuration
> /help tools

# Check logs
tail -f ~/.qwen/logs/qwen.log
```

### Getting Help

1. **Built-in Help**: Use `/help` for command reference
2. **Documentation**: Check the docs directory for detailed guides
3. **GitHub Issues**: Report bugs and request features
4. **Community**: Join discussions and share experiences

## Advanced Configuration

### Custom Model Configuration

```json
{
  "models": {
    "qwen-coder": {
      "apiKey": "your_key",
      "baseURL": "https://api.provider.com/v1",
      "model": "qwen3-coder-plus",
      "maxTokens": 4096,
      "temperature": 0.1
    }
  },
  "defaultModel": "qwen-coder"
}
```

### Tool Configuration

```json
{
  "tools": {
    "shell": {
      "enabled": true,
      "requireConfirmation": true,
      "allowedCommands": ["npm", "git", "ls", "cat"]
    },
    "web-fetch": {
      "enabled": true,
      "timeout": 30000,
      "maxSize": "10MB"
    }
  }
}
```

## What's Next?

Now that you understand the basics, explore:

1. **Advanced Workflows**: Complex multi-step automation
2. **Custom Tools**: Building domain-specific extensions
3. **Integration**: Connecting with your existing development tools
4. **Optimization**: Fine-tuning for your specific use cases

Qwen Code is designed to grow with your needs. Start simple and gradually incorporate more advanced features as you become comfortable with the tool.

Happy coding! 🚀