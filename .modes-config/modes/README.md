# Custom Modes for Qwen Code

This directory contains custom mode definitions for Qwen Code.

## 📁 Structure

```
.modes-config/
└── modes/
    ├── architect.json    # 📐 Architect Mode
    ├── code.json         # 💻 Code Mode
    ├── ask.json          # ❓ Ask Mode
    ├── debug.json        # 🐛 Debug Mode
    ├── review.json       # 🔍 Review Mode
    └── orchestrator.json # 🎯 Orchestrator Mode
```

## 📝 Mode Definition Schema

Each mode is defined in a JSON file with the following structure:

```json
{
  "$schema": "../modes-schema.json",
  "id": "mode-id",
  "name": "Mode Name",
  "description": "What this mode does",
  "color": "#HEXCOLOR",
  "icon": "🎯",
  "roleSystemPrompt": "System prompt for this mode...",
  "allowedTools": ["read_file", "write_file"],
  "excludedTools": ["shell"],
  "useCases": ["Use case 1", "Use case 2"],
  "safetyConstraints": ["Constraint 1", "Constraint 2"],
  "priority": 5
}
```

## 🛠️ Creating a Custom Mode

1. **Copy an existing mode** as a template:
   ```bash
   cp .modes-config/modes/code.json .modes-config/modes/my-custom-mode.json
   ```

2. **Edit the mode definition**:
   - Change `id`, `name`, `description`
   - Customize `roleSystemPrompt`
   - Adjust `allowedTools` and `excludedTools`

3. **Use the mode**:
   ```bash
   /mode my-custom-mode
   ```

## 📋 Available Tools

- `read_file` - Read file contents
- `write_file` - Write new files
- `edit` - Edit existing files
- `list_dir` - List directory contents
- `glob` - Find files by pattern
- `grep` - Search file contents
- `shell` - Execute shell commands
- `memory` - Access project memory
- `todo_write` - Create task lists
- `create_markdown_diagrams` - Create Mermaid diagrams
- `lsp` - Language Server Protocol
- `web_search` - Search the web
- `web_fetch` - Fetch web content

## 🎨 Example: Creating a "Tester" Mode

```json
{
  "$schema": "../modes-schema.json",
  "id": "tester",
  "name": "Tester",
  "description": "Writing and running tests",
  "color": "#10B981",
  "icon": "✅",
  "roleSystemPrompt": "Ты эксперт по тестированию. Твоя задача — писать comprehensive тесты...",
  "allowedTools": [
    "read_file",
    "write_file",
    "shell",
    "grep"
  ],
  "excludedTools": ["edit"],
  "useCases": [
    "Writing unit tests",
    "Running test suites",
    "Debugging failing tests"
  ],
  "safetyConstraints": [
    "Always run tests after writing",
    "Maintain test coverage"
  ],
  "priority": 7
}
```

## 🔄 Priority System

Higher priority modes are more likely to be auto-selected:

- `priority: 10` - Architect (high priority for planning tasks)
- `priority: 8` - Debug (high priority for error tasks)
- `priority: 5` - Code (default for coding tasks)
- `priority: 3` - Ask (low priority, for questions)

## ⚠️ Safety Constraints

Safety constraints are **hard rules** that the mode must follow:

- Cannot be overridden by user instructions
- Enforced by the Tool Router
- Violations are blocked at runtime

## 📖 Documentation

For more information, see:
- [Modes Guide](../../MODES_SUMMARY.md)
- [Schema Reference](./modes-schema.json)
