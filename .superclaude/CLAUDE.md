# SuperClaude Framework Configuration

This directory contains an **isolated** SuperClaude Framework setup for this project.

## Quick Start

### Activate SuperClaude

```bash
source .superclaude/scripts/activate.sh
```

### Deactivate SuperClaude

```bash
source .superclaude/scripts/deactivate.sh
```

## Installation

1. **Install SuperClaude CLI** (isolated in .superclaude/venv):

```bash
. .superclaude/scripts/install.sh
```

2. **Install slash commands**:

```bash
superclaude install
```

3. **Install MCP servers** (optional):

```bash
superclaude mcp --servers tavily context7
```

## Available Commands (30 total)

### Planning & Development

- `/sc:plan` - Create implementation plans
- `/sc:implement` - Execute implementations
- `/sc:refactor` - Refactor code
- `/sc:debug` - Debug issues

### Testing & Quality

- `/sc:test` - Generate tests
- `/sc:review` - Code review
- `/sc:security` - Security analysis

### Documentation

- `/sc:docs` - Generate documentation
- `/sc:readme` - Create/update README

### Research

- `/sc:research` - Deep web research
- `/sc:analyze` - Analyze codebase

## Behavioral Modes (7 modes)

- `brainstorming` - Creative exploration
- `business-panel` - Executive summaries
- `deep-research` - Comprehensive research
- `token-efficiency` - Minimal token usage
- `architect` - System design focus
- `code-review` - Critical analysis
- `teacher` - Educational explanations

## Specialized Agents (16 agents)

- PM Agent - Product management
- Security Agent - Security analysis
- Frontend Agent - UI/UX development
- Backend Agent - API/Server development
- Research Agent - Deep research
- And 11 more...

## MCP Servers

Available integrations:

- **Tavily** - Web search
- **Context7** - Code context
- **Sequential** - Multi-step workflows
- **Serena** - Code search
- **Playwright** - Browser automation
- **Magic** - Enhanced capabilities
- **Morphllm** - Translation
- **Chrome DevTools** - Browser debugging

## File Structure

```
.superclaude/
├── CLAUDE.md           # This file
├── config/
│   └── settings.json   # SuperClaude settings
├── scripts/
│   ├── activate.sh     # Activate SuperClaude
│   ├── deactivate.sh   # Deactivate SuperClaude
│   └── install.sh      # Install dependencies
├── docs/
│   └── commands.md     # Full command reference
└── venv/               # Isolated Python env (gitignored)
```

## Notes

- This setup is **isolated** from the main Qwen Code repository
- All SuperClaude dependencies are installed in `.superclaude/venv/`
- No modifications to the official Qwen Code codebase
- Toggle SuperClaude on/off without affecting the base project

## Version

SuperClaude Framework v4.2.0

## Links

- [Official Repository](https://github.com/SuperClaude-Org/SuperClaude_Framework)
- [Documentation](https://github.com/SuperClaude-Org/SuperClaude_Framework/blob/main/CLAUDE.md)
