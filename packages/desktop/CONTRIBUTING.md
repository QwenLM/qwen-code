# Contributing to OpenWork

Thank you for your interest in contributing to OpenWork. This guide covers the
local development workflow for the desktop app and shared packages.

## Prerequisites

- [Bun](https://bun.sh/) 1.3 or newer
- Node.js 22 or newer for the Qwen Code runtime and related tooling
- macOS, Linux, or Windows

## Development Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/modelstudioai/openwork.git
   cd openwork
   ```

2. Install dependencies:

   ```bash
   bun install
   ```

3. Start the Electron app in development mode:

   ```bash
   CRAFT_BRAND=modelstudio bun run electron:dev
   ```

   To run against a local Qwen Code checkout instead of a vendored or npm
   runtime, pass the source root:

   ```bash
   CRAFT_BRAND=modelstudio \
   QWEN_CODE_ROOT=/path/to/qwen-code \
   bun run electron:dev
   ```

## Useful Commands

Run focused checks whenever possible:

```bash
bun run typecheck:shared
bun run typecheck:electron
bun run typecheck:all
```

Build the desktop app resources:

```bash
bun run electron:build
```

Package a dev build:

```bash
CRAFT_DEV_RUNTIME=1 bun run electron:dist:dev:mac
```

## Project Structure

```text
openwork/
├── apps/
│   ├── electron/    # Electron desktop app
│   ├── cli/         # Command-line entry points
│   ├── viewer/      # Shared session viewer
│   └── webui/       # Web UI build
├── packages/
│   ├── shared/      # Shared app logic and protocol types
│   ├── server-core/ # Server/session orchestration
│   ├── server/      # Server entry point
│   ├── ui/          # React UI components
│   └── core/        # Shared lower-level utilities
└── scripts/         # Build, dev, and packaging scripts
```

## Contribution Guidelines

- Keep changes focused and minimal.
- Follow existing TypeScript and React patterns.
- Prefer existing shared helpers over introducing new abstractions.
- Include screenshots or a short screen recording for visible UI changes.
- Mention the commands you ran in the PR description.
- Do not include generated build artifacts unless the project explicitly tracks
  them.

## Pull Requests

1. Create a branch from the target branch.
2. Make the smallest change that solves the problem.
3. Run the relevant focused checks.
4. Open a pull request with a clear summary, testing notes, and screenshots for
   UI changes.

## License

By contributing, you agree that your contributions are licensed under the same
license as this repository.
