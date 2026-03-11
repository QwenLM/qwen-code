---
name: migrate-to-qwen
description: 'Migrate AI coding assistant configurations to Qwen-Code. Supports Claude Code, Cursor, Gemini CLI, GitHub Copilot, Continue, and shared .agents/ skills. Migrates MCP servers, custom rules, skills, agents, and project-level settings into ~/.qwen/. Use when switching to Qwen-Code from another AI tool, or when asked to import/migrate/transfer settings.'
---

# Migrate to Qwen-Code

Migrate your AI coding assistant configurations (Claude Code, Cursor, Gemini CLI, GitHub Copilot, Continue, etc.) into Qwen-Code's `~/.qwen/` directory.

## When to Use This Skill

Use this skill when the user:

- Wants to migrate from Claude Code, Cursor, Gemini, Copilot, or Continue to Qwen-Code
- Says "migrate my settings", "import my config", "transfer my AI config"
- Asks "how do I move my Claude/Cursor/Gemini setup to Qwen-Code"
- Wants to consolidate AI tool configurations into Qwen-Code
- Has existing skills, agents, MCP servers, or custom rules to bring over

## Qwen-Code Configuration Structure

```
~/.qwen/
├── settings.json          # Main config (mcpServers, modelProviders, env, tools)
├── QWEN.md                # Global system prompt / custom instructions
├── skills/                # Reusable skill modules
│   └── <skill-name>/
│       └── SKILL.md       # Skill definition (frontmatter: name, description, allowedTools)
├── agents/                # Custom agent personas
│   └── <agent-name>.md    # Agent definition (frontmatter: name, description, color, tools, modelConfig)
└── projects/              # Project-specific overrides
```

## Supported Migration Sources

| Source             | Config Location                                           | What Can Be Migrated                          |
| ------------------ | --------------------------------------------------------- | --------------------------------------------- |
| **Claude Code**    | `~/.claude/`                                              | Skills, MCP servers, custom rules (CLAUDE.md) |
| **Cursor**         | `~/.cursor/`                                              | Skills, rules, hooks, .cursorrules            |
| **Gemini CLI**     | `~/.gemini/`                                              | Settings, MCP servers                         |
| **GitHub Copilot** | `~/.config/github-copilot/`                               | Settings                                      |
| **Continue**       | `~/.continue/`                                            | Config, models, MCP servers                   |
| **Shared Agents**  | `~/.agents/`                                              | Skills (shared across tools)                  |
| **Project-level**  | `.claude/`, `.cursor/`, `.github/copilot-instructions.md` | Rules, instructions                           |

## Migration Workflow

### Step 1: Scan for Existing Configurations

Run the detection script to find all AI tool configs on the system:

```bash
bash ~/.qwen/skills/migrate-to-qwen/scripts/migrate.sh scan
```

This will output a report of all detected AI tool configurations and what can be migrated.

### Step 2: Review Detected Configurations

Present the scan results to the user. For each detected source, explain:

1. What was found (skills, MCP servers, rules, agents)
2. What will be migrated and where it will go
3. Any potential conflicts with existing Qwen-Code config

### Step 3: Execute Migration

Migrate from a specific source or all sources:

```bash
# Migrate from a specific tool
bash ~/.qwen/skills/migrate-to-qwen/scripts/migrate.sh migrate claude
bash ~/.qwen/skills/migrate-to-qwen/scripts/migrate.sh migrate cursor
bash ~/.qwen/skills/migrate-to-qwen/scripts/migrate.sh migrate gemini
bash ~/.qwen/skills/migrate-to-qwen/scripts/migrate.sh migrate copilot
bash ~/.qwen/skills/migrate-to-qwen/scripts/migrate.sh migrate continue
bash ~/.qwen/skills/migrate-to-qwen/scripts/migrate.sh migrate agents

# Migrate everything detected
bash ~/.qwen/skills/migrate-to-qwen/scripts/migrate.sh migrate all

# Migrate project-level configs (run from project root)
bash ~/.qwen/skills/migrate-to-qwen/scripts/migrate.sh migrate-project
```

### Step 4: Post-Migration Verification

After migration, verify the results:

```bash
bash ~/.qwen/skills/migrate-to-qwen/scripts/migrate.sh verify
```

Then review with the user:

1. Read `~/.qwen/settings.json` to confirm MCP servers were merged correctly
2. List `~/.qwen/skills/` to confirm skills were copied
3. List `~/.qwen/agents/` to confirm agents were copied
4. Read `~/.qwen/QWEN.md` to confirm custom rules were appended

## Migration Details by Source

### Claude Code (`~/.claude/`)

| Source                                 | Destination                          | Method           |
| -------------------------------------- | ------------------------------------ | ---------------- |
| `~/.claude/skills/*/SKILL.md`          | `~/.qwen/skills/*/SKILL.md`          | Copy or symlink  |
| `~/.claude/settings.json` → mcpServers | `~/.qwen/settings.json` → mcpServers | JSON merge       |
| Project `CLAUDE.md`                    | Project `.qwen/QWEN.md`              | Copy with header |
| Project `.claude/settings.json`        | Project `.qwen/settings.json`        | JSON merge       |

### Cursor (`~/.cursor/`)

| Source                               | Destination                 | Method                     |
| ------------------------------------ | --------------------------- | -------------------------- |
| `~/.cursor/skills-cursor/*/SKILL.md` | `~/.qwen/skills/*/SKILL.md` | Copy                       |
| `~/.cursor/rules/`                   | `~/.qwen/QWEN.md`           | Append with section header |
| Project `.cursorrules`               | Project `.qwen/QWEN.md`     | Copy with header           |
| Project `.cursor/rules/`             | Project `.qwen/QWEN.md`     | Append                     |

### Gemini CLI (`~/.gemini/`)

| Source                                 | Destination                          | Method           |
| -------------------------------------- | ------------------------------------ | ---------------- |
| `~/.gemini/settings.json` → mcpServers | `~/.qwen/settings.json` → mcpServers | JSON merge       |
| Project `GEMINI.md`                    | Project `.qwen/QWEN.md`              | Copy with header |

### Continue (`~/.continue/`)

| Source                                 | Destination                          | Method                     |
| -------------------------------------- | ------------------------------------ | -------------------------- |
| `~/.continue/config.json` → mcpServers | `~/.qwen/settings.json` → mcpServers | JSON merge                 |
| `~/.continue/config.json` → models     | Reference only (manual)              | Report to user             |
| `~/.continue/rules/`                   | `~/.qwen/QWEN.md`                    | Append with section header |

### GitHub Copilot

| Source                                    | Destination             | Method           |
| ----------------------------------------- | ----------------------- | ---------------- |
| Project `.github/copilot-instructions.md` | Project `.qwen/QWEN.md` | Copy with header |

### Shared Agents (`~/.agents/`)

| Source                | Destination         | Method                     |
| --------------------- | ------------------- | -------------------------- |
| `~/.agents/skills/*/` | `~/.qwen/skills/*/` | Symlink (preserve sharing) |

## Conflict Resolution

When migrating, the script follows these rules:

1. **settings.json**: MCP servers are **merged** (existing entries preserved, new ones added)
2. **Skills**: If a skill with the same name exists, it is **skipped** (user notified)
3. **QWEN.md**: Custom rules are **appended** with a clear section header indicating the source
4. **Agents**: If an agent with the same name exists, it is **skipped** (user notified)
5. **Backups**: A backup of `settings.json` is created before any merge operation

## Manual Migration Guidance

For configurations that cannot be automatically migrated, guide the user:

### Model Providers

Different tools use different model provider formats. Help the user manually configure `modelProviders` in `~/.qwen/settings.json` based on their API keys and preferred models.

### Hooks

Cursor hooks (`~/.cursor/hooks.json`) don't have a direct equivalent. Explain this to the user and suggest alternatives.

### Tool Approval Modes

Map the source tool's approval settings to Qwen-Code's `tools.approvalMode` (`auto-edit`, `suggest`, etc.).

## Tips

- **Symlinks vs Copies**: For shared skills (from `~/.agents/`), symlinks are preferred to keep them in sync across tools
- **Incremental Migration**: You can run migration multiple times safely; existing configs won't be overwritten
- **Project-level**: Run `migrate-project` from within the project directory to migrate project-specific rules
- **Dry Run**: The `scan` command is always safe — it only reads and reports, never modifies
