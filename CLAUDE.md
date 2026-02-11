# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qwen Code - Open Source AI Agent for the Terminal

Qwen Code is an open-source AI agent for the terminal, optimized for Qwen3-Coder models. It helps developers understand large codebases, automate tedious work, and ship faster.

## Architecture Overview

The project follows a monorepo architecture with multiple packages:

- `packages/cli` - Main command-line interface with interactive terminal UI built with React/Ink
- `packages/core` - Core backend logic, AI interactions, model communications, and business logic
- `packages/vscode-ide-companion` - VS Code extension integration
- `packages/sdk-typescript` - TypeScript SDK for building applications on top of Qwen Code
- `packages/sdk-java` - Java SDK for Qwen Code integration
- `packages/test-utils` - Shared testing utilities

## Development Commands

### Building the Project

```bash
# Build the entire project
npm run build

# Build all components including sandbox
npm run build:all

# Build just the packages
npm run build:packages

# Build the VS Code extension
npm run build:vscode
```

### Testing

```bash
# Run all tests across packages
npm run test

# Run tests in CI mode
npm run test:ci

# Run integration tests without sandbox
npm run test:integration:sandbox:none

# Run integration tests with Docker sandbox
npm run test:integration:sandbox:docker

# Run end-to-end tests
npm run test:e2e
```

### Development Workflow

```bash
# Install dependencies
npm install

# Format code
npm run format

# Lint code
npm run lint

# Run preflight checks (formatting, linting, type checking, tests)
npm run preflight

# Clean generated files
npm run clean

# Start the application in development mode
npm run start

# Start with debugging enabled
npm run debug
```

### Alternative Commands (via Makefile)

```bash
make install      # Install npm dependencies
make build        # Build the project
make test         # Run tests
make lint         # Lint the code
make format       # Format the code
make preflight    # Run formatting, linting, and tests
make clean        # Remove generated files
make start        # Start the Qwen Code CLI
```

## Key Features and Components

### Built-in Tools and Features

- Skills system for extended functionality
- SubAgents for autonomous workflows
- Plan Mode for implementation planning
- MCP (Model Context Protocol) integration
- Sandbox support for secure code execution
- Interactive terminal UI with rich commands

### Authentication Methods

- Qwen OAuth (recommended, free tier with 2,000 requests/day)
- OpenAI-compatible API (using OPENAI_API_KEY environment variable)

### Configuration

- User settings: `~/.qwen/settings.json`
- Project settings: `.qwen/settings.json`
- Environment variables: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL

## Project-Specific Notes

### Node.js Version

- Development requires Node.js ~20.19.0 due to upstream dependency issues
- Production can run on any Node.js >=20

### Sandboxing

- Recommended for secure code execution
- Requires setting QWEN_SANDBOX=true in ~/.env
- Supports Docker, Podman, and macOS Seatbelt providers

### Type Checking

- TypeScript with ESM modules
- Strict type checking enabled
- Uses NodeNext module resolution

### Debugging

- Use `npm run debug` to start in debug mode
- VS Code launch configurations available in .vscode/launch.json
- React DevTools compatible for UI debugging
- Set DEV=true for development UI features

## File Structure Navigation

- Core business logic is in `packages/core/src/`
- CLI interface code is in `packages/cli/src/`
- Tests are located in each package under `__tests__/`
- Documentation is in the `docs/` directory
- Build scripts are in the `scripts/` directory
