# Qwen Code Development Guide

## Prerequisites

### Required Software

- **Node.js**: Version `~20.19.0` for development, `>=20` for production
- **Git**: Latest version
- **npm**: Comes with Node.js

### Recommended Tools

- **nvm**: Node version management
- **Docker/Podman**: For sandbox testing (optional but recommended)

## Initial Setup

### Clone and Install

```bash
# Clone the repository
git clone https://github.com/QwenLM/qwen-code.git
cd qwen-code

# Install dependencies
npm install

# Verify installation
npm run --version
```

### Build the Project

```bash
# Build all packages
npm run build

# Build with sandbox container
npm run build:all

# Build specific packages
npm run build --workspace=packages/cli
npm run build --workspace=packages/core
```

## Development Workflow

### Running the CLI

```bash
# Interactive mode
npm start
# or
qwen

# Debug mode with inspector
npm run debug

# Headless mode
qwen -p "your prompt here"

# With specific model
qwen -p "prompt" --model qwen3-coder
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests in CI mode
npm run test:ci

# Run integration tests
npm run test:integration:all

# Run specific package tests
npm run test --workspace=packages/cli
npm run test --workspace=packages/core

# Terminal benchmark tests
npm run test:terminal-bench
```

### Linting and Formatting

```bash
# Run linter
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Run CI linting (fail on warnings)
npm run lint:ci

# Format code with Prettier
npm run format

# Check formatting only
npx prettier --check .
```

### Type Checking

```bash
# Type check all packages
npm run typecheck

# Type check specific package
npm run typecheck --workspace=packages/cli
```

### Bundle for Release

```bash
# Generate, bundle, and copy assets
npm run bundle
```

## Project Structure

### Monorepo Organization

```
qwen-code/
├── packages/
│   ├── cli/           # Terminal application
│   ├── core/          # Backend logic
│   ├── webui/         # React components
│   ├── sdk-typescript/ # TypeScript SDK
│   ├── sdk-java/      # Java SDK
│   ├── vscode-ide-companion/ # VS Code extension
│   ├── zed-extension/ # Zed extension
│   └── test-utils/    # Testing utilities
├── scripts/           # Build scripts
├── integration-tests/  # E2E tests
└── docs/              # Documentation
```

### Package Responsibilities

| Package                | Responsibility                      |
| ---------------------- | ----------------------------------- |
| `cli`                  | Terminal UI and user interaction    |
| `core`                 | AI orchestration and tool execution |
| `webui`                | Shared React components             |
| `sdk-typescript`       | Node.js SDK                         |
| `sdk-java`             | Java SDK                            |
| `vscode-ide-companion` | VS Code integration                 |
| `zed-extension`        | Zed editor integration              |

## Adding New Features

### 1. Create a Branch

```bash
git checkout -b feature/your-feature-name
```

### 2. Make Changes

- Follow existing code patterns
- Add tests for new functionality
- Update TypeScript types as needed

### 3. Run Quality Checks

```bash
# Before committing
npm run preflight
```

This runs: clean, format, lint, build, and typecheck.

### 4. Commit and Push

```bash
# Stage changes
git add .

# Commit with conventional commit message
git commit -m "feat(cli): add new command"

# Push to remote
git push origin feature/your-feature-name
```

### 5. Create Pull Request

- Link to existing issue
- Keep PR small and focused
- Ensure all checks pass
- Update documentation if needed

## Code Style Guidelines

### TypeScript

- Use TypeScript for all new code
- Enable strict mode
- Use interfaces for object types
- Prefer readonly for immutability

### React Components

- Use functional components with hooks
- Follow component folder structure
- Use shared UI components from `@qwen-code/webui`

### Error Handling

- Use try/catch with async/await
- Log errors with appropriate level
- Return user-friendly error messages

### Git Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(cli): add new slash command
fix(core): resolve memory leak in tool execution
docs(readme): update installation instructions
refactor(tools): simplify file reading logic
test(cli): add unit tests for history command
```

## Building New Tools

### Tool Registration

1. Create tool file in `packages/core/src/tools/`
2. Implement tool interface
3. Register in tool registry
4. Add to tool manifest

### Tool Structure

```typescript
// packages/core/src/tools/my-tool.ts
import { Tool } from '../types';

export const myTool: Tool = {
  name: 'myTool',
  description: 'Description of what the tool does',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input parameter' },
    },
    required: ['input'],
  },
  async execute(params: { input: string }) {
    // Implementation
    return { result: 'output' };
  },
};
```

## Building New SDK Features

### TypeScript SDK

```typescript
// packages/sdk-typescript/src/client.ts
import { QwenClient } from './types';

export class QwenClient {
  constructor(config: QwenConfig) {
    // Initialize client
  }

  async execute(prompt: string): Promise<Response> {
    // Implementation
  }
}
```

### Java SDK

```java
// packages/sdk-java/src/main/java/com/qwen/sdk/QwenClient.java
public class QwenClient {
    private final QwenConfig config;

    public QwenClient(QwenConfig config) {
        this.config = config;
    }

    public Response execute(String prompt) {
        // Implementation
    }
}
```

## Testing

### Unit Tests

- Place tests alongside source files
- Use naming convention: `*.test.ts`, `*.spec.ts`
- Use Vitest framework
- Follow AAA pattern (Arrange, Act, Assert)

```typescript
// Example test
describe('MyFunction', () => {
  it('should return expected result', () => {
    // Arrange
    const input = 'test';

    // Act
    const result = myFunction(input);

    // Assert
    expect(result).toBe('expected');
  });
});
```

### Integration Tests

- Located in `integration-tests/` directory
- Test full user workflows
- Use sandbox for file operations

### IDE Extensions

```bash
# Build VS Code extension
npm run build:vscode

# Package VS Code extension
npm run package --workspace=packages/vscode-ide-companion
```

## Debugging

### CLI Debugging

```bash
# Debug with inspector
npm run debug

# Or set DEBUG environment variable
DEBUG=1 qwen
```

### VS Code Debugging

1. Open project in VS Code
2. Go to Debug panel
3. Select debug configuration
4. Set breakpoints

### Core Debugging

```bash
# Debug core package
cd packages/core
npm run debug
```

## Troubleshooting

### Common Issues

**Node version mismatch:**

```bash
# Check version
node --version

# Use correct version
nvm use 20.19.0
```

**Build failures:**

```bash
# Clean and rebuild
npm run clean
npm install
npm run build
```

**Test failures:**

```bash
# Run with verbose output
npm test -- --reporter=verbose
```

### Getting Help

- Run `/help` in interactive mode
- Check existing issues on GitHub
- Ask in Discord community

## Release Process

### Version Bumping

```bash
# Bump version
npm run release:version
```

### Publishing Packages

```bash
# Publish to npm
npm publish --workspace=packages/cli
npm publish --workspace=packages/sdk-typescript
```

### Building Release Artifacts

```bash
# Bundle all artifacts
npm run bundle

# Build VS Code extension
npm run build:vscode
```

## Related Documentation

- [Architecture Overview](./developers/architecture.md)
- [SDK TypeScript Documentation](./developers/sdk-typescript.md)
- [SDK Java Documentation](./developers/sdk-java.md)
- [Contributing Guidelines](../CONTRIBUTING.md)
