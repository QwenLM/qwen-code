---
name: terminal-capture
description: Automates terminal UI screenshot testing for CLI commands. Applies when reviewing PRs that affect CLI output, testing slash commands (/about, /context, /auth, /export), generating visual documentation, or when 'terminal screenshot', 'CLI test', 'visual test', or 'terminal-capture' is mentioned.
---

# Terminal Capture — CLI Terminal Screenshot Automation

Drive terminal interactions and screenshots via TypeScript configuration, used for visual verification during PR reviews.

## Prerequisites

Ensure the following dependencies are installed before running:

```bash
npm install       # Install project dependencies (including node-pty, xterm, playwright, etc.)
npx playwright install chromium   # Install Playwright browser
```

## Architecture

```
node-pty (pseudo-terminal) → ANSI byte stream → xterm.js (Playwright headless) → Screenshot
```

Core files:

| File                                                     | Purpose                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `integration-tests/terminal-capture/terminal-capture.ts` | Low-level engine (PTY + xterm.js + Playwright)                           |
| `integration-tests/terminal-capture/scenario-runner.ts`  | Scenario executor (parses config, drives interactions, auto-screenshots) |
| `integration-tests/terminal-capture/run.ts`              | CLI entry point (batch run scenarios)                                    |
| `integration-tests/terminal-capture/scenarios/*.ts`      | Scenario configuration files                                             |

## Quick Start

### 1. Write Scenario Configuration

Create a `.ts` file under `integration-tests/terminal-capture/scenarios/`:

```typescript
import type { ScenarioConfig } from '../scenario-runner.js';

export default {
  name: '/about',
  spawn: ['node', 'dist/cli.js', '--yolo'],
  terminal: { title: 'qwen-code', cwd: '../../..' }, // Relative to this config file's location
  flow: [
    { type: 'Hi, can you help me understand this codebase?' },
    { type: '/about' },
  ],
} satisfies ScenarioConfig;
```

### 2. Run

```bash
# Single scenario
npx tsx integration-tests/terminal-capture/run.ts integration-tests/terminal-capture/scenarios/about.ts

# Batch (entire directory)
npx tsx integration-tests/terminal-capture/run.ts integration-tests/terminal-capture/scenarios/
```

### 3. Output

Screenshots are saved to `integration-tests/terminal-capture/scenarios/screenshots/{name}/`:

| File            | Description                        |
| --------------- | ---------------------------------- |
| `01-01.png`     | Step 1 input state                 |
| `01-02.png`     | Step 1 execution result            |
| `02-01.png`     | Step 2 input state                 |
| `02-02.png`     | Step 2 execution result            |
| `full-flow.png` | Final state full-length screenshot |

## FlowStep API

Each flow step can contain the following fields:

### `type: string` — Input Text

Automatic behavior: Input text → Screenshot (01) → Press Enter → Wait for output to stabilize → Screenshot (02).

```typescript
{
  type: 'Hello';
} // Plain text
{
  type: '/about';
} // Slash command (auto-completion handled automatically)
```

**Special rule**: If the next step is `key`, do not auto-press Enter (hand over control to the key sequence).

### `key: string | string[]` — Send Key Press

Used for menu selection, Tab completion, and other interactions. Does not auto-press Enter or auto-screenshot.

Supported key names: `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Enter`, `Tab`, `Escape`, `Backspace`, `Space`, `Home`, `End`, `PageUp`, `PageDown`, `Delete`

```typescript
{
  key: 'ArrowDown';
} // Single key
{
  key: ['ArrowDown', 'ArrowDown', 'Enter'];
} // Multiple keys
```

Auto-screenshot is triggered after the key sequence ends (when the next step is not a `key`).

### `capture` / `captureFull` — Explicit Screenshot

Use as a standalone step, or override automatic naming:

```typescript
{
  capture: 'initial.png';
} // Screenshot current viewport only
{
  captureFull: 'all-output.png';
} // Screenshot full scrollback buffer
```

## Scenario Examples

### Basic: Input + Command

```typescript
flow: [{ type: 'explain this project' }, { type: '/about' }];
```

### Secondary Menu Selection (/auth)

```typescript
flow: [
  { type: '/auth' },
  { key: 'ArrowDown' }, // Select API Key option
  { key: 'Enter' }, // Confirm
  { type: 'sk-xxx' }, // Input API key
];
```

### Tab Completion Selection (/export)

```typescript
flow: [
  { type: 'Tell me about yourself' },
  { type: '/export' }, // No auto-Enter (next step is key)
  { key: 'Tab' }, // Pop format selection
  { key: 'ArrowDown' }, // Select format
  { key: 'Enter' }, // Confirm → auto-screenshot
];
```

### Array Batch (Multiple Scenarios in One File)

```typescript
export default [
  { name: '/about', spawn: [...], flow: [...] },
  { name: '/context', spawn: [...], flow: [...] },
] satisfies ScenarioConfig[];
```

## Integration with PR Review

This tool is commonly used for visual verification during PR reviews. For the complete code review + screenshot workflow, see the [pr-review](../pr-review/SKILL.md) skill.

## Troubleshooting

| Issue                                | Cause                                 | Solution                                             |
| ------------------------------------ | ------------------------------------- | ---------------------------------------------------- |
| Playwright error `browser not found` | Browser not installed                 | `npx playwright install chromium`                    |
| Blank screenshot                     | Process starts slowly or build failed | Ensure `npm run build` succeeds, check spawn command |
| PTY-related errors                   | node-pty native module not compiled   | `npm rebuild node-pty`                               |
| Unstable screenshot output           | Terminal output not fully rendered    | Check if the scenario needs additional wait time     |

## Full ScenarioConfig Type

```typescript
interface ScenarioConfig {
  name: string; // Scenario name (also used as screenshot subdirectory name)
  spawn: string[]; // Launch command ["node", "dist/cli.js", "--yolo"]
  flow: FlowStep[]; // Interaction steps
  terminal?: {
    // Terminal configuration (all optional)
    cols?: number; // Number of columns, default 100
    rows?: number; // Number of rows, default 28
    theme?: string; // Theme: dracula|one-dark|github-dark|monokai|night-owl
    chrome?: boolean; // macOS window decorations, default true
    title?: string; // Window title, default "Terminal"
    fontSize?: number; // Font size
    cwd?: string; // Working directory (relative to config file)
  };
  outputDir?: string; // Screenshot output directory (relative to config file)
}
```
