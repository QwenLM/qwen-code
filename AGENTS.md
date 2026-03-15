# AGENTS.md - Agent Coding Guidelines for qwen-code

This file provides guidance for AI agents working in this repository.

## Project Overview

Qwen Code is an open-source AI agent that lives in your terminal, optimized for Qwen3-Coder. It's a Node.js monorepo built with TypeScript, using React (via Ink) for the CLI UI.

## Prerequisites

- **Node.js**: Use Node.js `~20.19.0` for development (required due to upstream dependency issues)
- **npm**: Install dependencies with `npm install` (not yarn or pnpm)

## Build Commands

```bash
# Build all packages
npm run build

# Build and start the CLI
npm run build-and-start
npm start

# Debug mode
npm run debug

# Build with sandbox container
npm run build:all

# Clean generated files
npm run clean
```

## Test Commands

```bash
# Run unit tests (all packages)
npm run test

# Run unit tests for a specific package
cd packages/core && npm run test
cd packages/cli && npm run test

# Run a single test file
npx vitest run path/to/test.test.ts

# Run tests matching a pattern
npx vitest run -t "test name pattern"

# Run integration tests (requires sandbox setup)
npm run test:e2e

# Run integration tests without sandbox
npm run test:integration:sandbox:none

# Terminal benchmark tests
npm run test:terminal-bench
```

## Lint & Format Commands

```bash
# Run all linters
npm run lint

# Auto-fix lint issues
npm run lint:fix

# Check lint in CI mode (strict)
npm run lint:ci

# Format code with Prettier
npm run format

# TypeScript type checking
npm run typecheck

# Run full preflight check (format + lint + build + typecheck + test)
npm run preflight
```

## Code Style Guidelines

### TypeScript Configuration

The project uses strict TypeScript with these settings:

- `strict: true` - Full strict mode
- `noImplicitAny: true` - No implicit any
- `noImplicitOverride: true` - Require override keyword
- `strictNullChecks: true` - Strict null checking
- `verbatimModuleSyntax: true` - Use `import type` for type-only imports

### Prettier Formatting

```json
{
  "semi": true,
  "trailingComma": "all",
  "singleQuote": true,
  "printWidth": 80,
  "tabWidth": 2
}
```

### ESLint Rules (Key Points)

1. **No require()** - Use ES6 imports exclusively
2. **Type Assertions** - Use `as` syntax, not angle brackets: `x as Type`
3. **Error Throwing** - Always throw `new Error("message")`, never strings
4. **No `any`** - Use `unknown` or specific types instead
5. **Accessibility** - Add explicit visibility (`public`, `private`) to class members
6. **Unused Variables** - Prefix with `_` to ignore: `_unusedVar`
7. **Prefer const** - Always use `const` where possible
8. **Arrow Callbacks** - Use arrow functions for callbacks
9. **Curly Braces** - Use multi-line curly for control flow

### Import Conventions

- Use `import { something } from 'package'` for external packages
- Use `import { something } from '../utils'` for internal relative imports
- Use `import type { TypeOnly }` for type-only imports (required by verbatimModuleSyntax)
- Avoid relative imports across packages - use package names instead

## Project Structure

```
qwen-code/
├── packages/
│   ├── cli/           # Command-line interface (main entry point)
│   ├── core/          # Core backend logic
│   ├── sdk-typescript/# TypeScript SDK
│   ├── webui/         # Web UI components
│   ├── web-templates/ # Web templates
│   ├── test-utils/    # Testing utilities
│   └── vscode-ide-companion/ # VS Code extension
├── scripts/           # Build and utility scripts
├── integration-tests/ # End-to-end tests
├── docs/             # Documentation
└── docs-site/        # Documentation website
```

## Common Development Tasks

### Adding a New Package

1. Create directory in `packages/`
2. Add `package.json` with proper scripts and dependencies
3. Add to root `package.json` workspaces array
4. Create `tsconfig.json` extending root config
5. Run `npm install` to link packages

### Running the CLI Locally

```bash
npm run build
npm start
# Or use npx
npx tsx packages/cli/src/index.ts
```

### Debugging with VS Code

1. Run `npm run debug` from root
2. Attach debugger via Chrome inspect (`chrome://inspect`)
3. Use VS Code "Attach" launch configuration

## Testing Best Practices

1. Test files: `*.test.ts` or `*.test.tsx` in package src directories
2. Use Vitest as the test runner
3. Follow existing test patterns in each package
4. Run `npm run test` before submitting PRs

## Git Conventions

- Use **Conventional Commits** for commit messages
- Format: `type(scope): description`
  - `feat(cli): add new command`
  - `fix(core): resolve parsing issue`
  - `docs: update README`
- Link PRs to issues (e.g., `Fixes #123`)
- Keep PRs small and focused

## Pull Request Checklist

- [ ] Linked to an existing issue
- [ ] All tests pass (`npm run preflight`)
- [ ] Code is formatted (`npm run format`)
- [ ] No lint errors (`npm run lint`)
- [ ] TypeScript compiles without errors (`npm run typecheck`)
- [ ] Documentation updated if user-facing
- [ ] PR description follows template

## Important Notes

1. **No API Keys in Code** - Never commit API keys or secrets
2. **Monorepo Dependencies** - Use `file:` protocol for local package dependencies
3. **Native Modules** - Some packages have optional native dependencies (node-pty, clipboard)
4. **Sandboxing** - Some features require sandbox setup (Docker, Podman, or macOS Seatbelt)
