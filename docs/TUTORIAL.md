# Qwen Code: Complete End-to-End Tutorial

## Table of Contents
1. [Introduction](#introduction)
2. [Installation & Setup](#installation--setup)
3. [Basic Usage](#basic-usage)
4. [Advanced Features](#advanced-features)
5. [Customization](#customization)
6. [Troubleshooting](#troubleshooting)

## Introduction

Qwen Code is an AI-powered CLI tool that transforms how developers interact with codebases. Unlike traditional tools, it understands natural language and can perform complex operations across multiple files while maintaining context.

### What Makes Qwen Code Unique?

- **Context-Aware**: Understands your entire codebase, not just individual files
- **Tool-Integrated**: Can execute commands, edit files, and perform operations
- **Conversation-Based**: Natural language interface for complex tasks
- **Extensible**: Plugin system for custom tools and workflows

## Installation & Setup

### Prerequisites

1. **Node.js 20+**: Required for running the CLI
```bash
# Check your Node.js version
node --version
# Should output v20.x.x or higher
```

2. **API Access**: You'll need access to Qwen models via one of these providers:
   - Alibaba Cloud Bailian (China mainland)
   - ModelScope (Free tier - 2000 calls/day)
   - Alibaba Cloud ModelStudio (International)
   - OpenRouter (Free tier available)

### Step 1: Install Qwen Code

```bash
# Global installation
npm install -g @qwen-code/qwen-code@latest

# Verify installation
qwen --version
```

### Step 2: Configure API Access

Create a configuration directory and file:

```bash
# Create config directory
mkdir -p ~/.qwen

# Create settings file
cat > ~/.qwen/settings.json << 'EOF'
{
  "sessionTokenLimit": 32000,
  "apiKey": "your_api_key_here",
  "baseUrl": "your_api_endpoint",
  "modelName": "your_model_choice"
}
EOF
```

**For different providers, use these configurations:**

**Option A: ModelScope (Free, China mainland)**
```json
{
  "sessionTokenLimit": 32000,
  "apiKey": "your_modelscope_api_key",
  "baseUrl": "https://api-inference.modelscope.cn/v1",
  "modelName": "Qwen/Qwen3-Coder-480B-A35B-Instruct"
}
```

**Option B: OpenRouter (Free tier available, International)**
```json
{
  "sessionTokenLimit": 32000,
  "apiKey": "your_openrouter_api_key",
  "baseUrl": "https://openrouter.ai/api/v1",
  "modelName": "qwen/qwen3-coder:free"
}
```

### Step 3: Environment Variables (Alternative)

Instead of config files, you can use environment variables:

```bash
# Add to your .bashrc, .zshrc, or .profile
export OPENAI_API_KEY="your_api_key_here"
export OPENAI_BASE_URL="your_api_endpoint"
export OPENAI_MODEL="your_model_choice"
```

## Basic Usage

### Starting Qwen Code

Navigate to your project directory and start:

```bash
cd your-project/
qwen
```

You'll see the interactive prompt:
```
┌─────────────────────────────────────────┐
│         Qwen Code - AI Assistant        │
│    Type your question or command        │
│    Use /help for available commands     │
└─────────────────────────────────────────┘

> 
```

### Your First Commands

#### 1. Understand Your Codebase
```
> What is this project about? Analyze the main structure and purpose.
```

Qwen Code will:
- Read your README, package.json, and key files
- Identify the project type and technologies
- Explain the main components and architecture

#### 2. Explore Code Patterns
```
> Show me all the React components in this project and their relationships
```

This will:
- Find all React component files
- Analyze component dependencies
- Create a visual representation of the component tree

#### 3. Code Analysis
```
> Find all potential performance issues in this codebase
```

Qwen Code examines:
- Inefficient algorithms
- Memory leaks
- Unused imports
- Performance anti-patterns

### Interactive Session Management

#### Check Session Status
```
> /status
```
Shows:
- Current token usage
- Remaining capacity
- Active tools
- Session configuration

#### Compress History
```
> /compress
```
When approaching token limits, this command:
- Summarizes conversation history
- Preserves important context
- Resets token counter

#### Clear Session
```
> /clear
```
Completely resets the conversation.

## Advanced Features

### Multi-File Operations

#### 1. Batch File Editing
```
> Update all component files to use TypeScript strict mode and add proper prop types
```

This operation:
- Identifies all component files
- Converts JavaScript to TypeScript
- Adds type definitions
- Updates imports and exports

#### 2. Codebase Refactoring
```
> Refactor this entire module to use the repository pattern for data access
```

The AI will:
- Analyze current data access patterns
- Create repository interfaces
- Implement repository classes
- Update all consuming code
- Ensure tests still pass

#### 3. Documentation Generation
```
> Generate comprehensive JSDoc comments for all public APIs in the src/ directory
```

### Integration with Development Workflow

#### 1. Git Integration
```
> Analyze the last 10 commits and create a changelog
```

```
> Find all TODO comments and create GitHub issues
```

#### 2. Testing Automation
```
> Generate unit tests for all untested functions in the utils/ directory
```

#### 3. Code Quality
```
> Add error handling and logging to all API endpoints
```

### Advanced Tool Usage

#### 1. Custom Scripts
```
> Create a build script that optimizes images and bundles CSS
```

#### 2. Configuration Updates
```
> Update ESLint configuration to use the latest React rules and fix all violations
```

#### 3. Dependency Management
```
> Audit all dependencies, update to latest stable versions, and fix breaking changes
```

## Customization

### Custom Tools

#### 1. Tool Discovery Command

Add to your `~/.qwen/settings.json`:

```json
{
  "toolDiscoveryCommand": "node ./custom-tools/discover.js"
}
```

Create `custom-tools/discover.js`:
```javascript
// Example custom tool discovery
const tools = [
  {
    name: "deploy_to_staging",
    description: "Deploy current branch to staging environment",
    parameters: {
      type: "object",
      properties: {
        branch: {
          type: "string",
          description: "Git branch to deploy"
        }
      },
      required: ["branch"]
    }
  }
];

console.log(JSON.stringify(tools));
```

#### 2. Tool Call Command

Add to settings:
```json
{
  "toolCallCommand": "node ./custom-tools/execute.js"
}
```

### Model Context Protocol (MCP) Servers

For advanced integrations, configure MCP servers:

```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": ["./mcp-servers/database-server.js"],
      "env": {
        "DB_CONNECTION_STRING": "postgres://..."
      }
    },
    "gitlab": {
      "command": "python",
      "args": ["./mcp-servers/gitlab_server.py"],
      "env": {
        "GITLAB_TOKEN": "your_token"
      }
    }
  }
}
```

### Custom Prompts and Behavior

#### 1. User Memory

Set persistent behavior:
```json
{
  "userMemory": "Always prefer TypeScript over JavaScript. Use functional programming patterns. Follow SOLID principles in all code suggestions."
}
```

#### 2. Tool Restrictions

Limit available tools for safety:
```json
{
  "excludeTools": ["ShellTool", "WriteFileTool"],
  "coreTools": ["ReadFileTool", "EditTool", "GrepTool"]
}
```

## Troubleshooting

### Common Issues

#### 1. API Key Issues

**Problem**: "Authentication failed" errors

**Solution**:
```bash
# Check your API key configuration
cat ~/.qwen/settings.json

# Test API access
curl -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     YOUR_BASE_URL/models
```

#### 2. Token Limit Exceeded

**Problem**: "Context length exceeded" errors

**Solutions**:
- Use `/compress` to summarize history
- Reduce `sessionTokenLimit` in settings
- Use `/clear` to start fresh
- Break large tasks into smaller operations

#### 3. Tool Execution Failures

**Problem**: Commands fail or hang

**Solutions**:
```bash
# Check tool availability
qwen --list-tools

# Test shell access
echo "test" > /tmp/qwen-test.txt
rm /tmp/qwen-test.txt
```

#### 4. Performance Issues

**Problem**: Slow responses or timeouts

**Solutions**:
- Check network connectivity
- Reduce concurrent operations
- Use local models if available
- Configure request timeouts

### Debug Mode

Enable detailed logging:
```bash
export DEBUG=1
qwen
```

This provides:
- Detailed API request/response logs
- Tool execution traces
- Performance metrics
- Error stack traces

### Getting Help

#### 1. Built-in Help
```
> /help
```

#### 2. Community Resources
- GitHub Issues: Report bugs and feature requests
- Documentation: Complete API reference
- Examples: Sample configurations and use cases

#### 3. Professional Support
- Enterprise support available
- Custom training and integration
- Priority bug fixes and features

## Best Practices

### 1. Session Management
- Use `/status` regularly to monitor token usage
- Compress history before long operations
- Clear sessions when switching contexts

### 2. Security
- Never commit API keys to version control
- Use environment variables in CI/CD
- Review tool confirmations carefully
- Restrict tool access in shared environments

### 3. Performance
- Break large operations into smaller tasks
- Use specific commands rather than broad requests
- Cache frequently accessed information
- Monitor API usage and costs

### 4. Collaboration
- Share configurations via team settings
- Document custom tools and workflows
- Use consistent naming conventions
- Maintain tool documentation

## Conclusion

Qwen Code transforms the developer experience by bringing AI assistance directly into your workflow. With its powerful tool system, natural language interface, and extensible architecture, it can handle everything from simple code queries to complex codebase transformations.

Start with basic commands, gradually explore advanced features, and customize the tool to match your specific needs. The AI learns from your patterns and preferences, becoming more helpful over time.

Happy coding with Qwen Code! 🚀