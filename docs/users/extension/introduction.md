# Qwen Code Extensions

Qwen Code extensions package prompts, MCP servers, subagents, skills and custom commands into a familiar and user-friendly format. With extensions, you can expand the capabilities of Qwen Code and share those capabilities with others. They are designed to be easily installable and shareable.

Extensions and plugins from [Gemini CLI Extensions Gallery](https://geminicli.com/extensions/) and [Claude Code Marketplace](https://claudemarketplaces.com/) can be directly installed into Qwen Code. This cross-platform compatibility gives you access to a rich ecosystem of extensions and plugins, dramatically expanding Qwen Code's capabilities without requiring extension authors to maintain separate versions.

## Extension management

We offer a suite of extension management tools using both `qwen extensions` CLI commands and `/extensions` slash commands within the interactive CLI.

### Runtime Extension Management (Slash Commands)

You can manage extensions at runtime within the interactive CLI using `/extensions` slash commands. These commands support hot-reloading, meaning changes take effect immediately without restarting the application.

| Command                                                | Description                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| `/extensions` or `/extensions list`                    | List all installed extensions with their status                   |
| `/extensions install <source>`                         | Install an extension from a git URL, local path, or marketplace   |
| `/extensions uninstall <name>`                         | Uninstall an extension                                            |
| `/extensions enable <name> --scope <user\|workspace>`  | Enable an extension                                               |
| `/extensions disable <name> --scope <user\|workspace>` | Disable an extension                                              |
| `/extensions update <name>`                            | Update a specific extension                                       |
| `/extensions update --all`                             | Update all extensions with available updates                      |
| `/extensions detail <name>`                            | Show details of an extension                                      |
| `/extensions explore [source]`                         | Open extensions source page(Gemini or ClaudeCode) in your browser |

### CLI Extension Management

You can also manage extensions using `qwen extensions` CLI commands. Note that changes made via CLI commands will be reflected in active CLI sessions on restart.

### Installing an extension

You can install an extension using `qwen extensions install` from multiple sources:

#### From Claude Code Marketplace

Qwen Code also supports plugins from the [Claude Code Marketplace](https://claudemarketplaces.com/). Install from a marketplace and choose a plugin:

```bash
qwen extensions install <marketplace-name>
# or
qwen extensions install <marketplace-github-url>
```

If you want to install a specific plugin, you can use the format with plugin name:

```bash
qwen extensions install <marketplace-name>:<plugin-name>
# or
qwen extensions install <marketplace-github-url>:<plugin-name>
```

For example, to install the `prompts.chat` plugin from the [f/awesome-chatgpt-prompts](https://claudemarketplaces.com/plugins/f-awesome-chatgpt-prompts) marketplace:

```bash
qwen extensions install f/awesome-chatgpt-prompts:prompts.chat
# or
qwen extensions install https://github.com/f/awesome-chatgpt-prompts:prompts.chat
```

Claude plugins are automatically converted to Qwen Code format during installation:

- `claude-plugin.json` is converted to `qwen-extension.json`
- Agent configurations are converted to Qwen subagent format
- Skill configurations are converted to Qwen skill format
- Tool mappings are automatically handled

You can quickly browse available extensions from different marketplaces using the `/extensions explore` command:

```bash
# Open Gemini CLI Extensions marketplace
/extensions explore Gemini

# Open Claude Code marketplace
/extensions explore ClaudeCode
```

This command opens the respective marketplace in your default browser, allowing you to discover new extensions to enhance your Qwen Code experience.

> **Cross-Platform Compatibility**: This allows you to leverage the rich extension ecosystems from both Gemini CLI and Claude Code, dramatically expanding the available functionality for Qwen Code users.

#### From Gemini CLI Extensions

Qwen Code fully supports extensions from the [Gemini CLI Extensions Gallery](https://geminicli.com/extensions/). Simply install them using the git URL:

```bash
qwen extensions install <gemini-cli-extension-github-url>
# or
qwen extensions install <owner>/<repo>
```

Gemini extensions are automatically converted to Qwen Code format during installation:

- `gemini-extension.json` is converted to `qwen-extension.json`
- TOML command files are automatically migrated to Markdown format
- MCP servers, context files, and settings are preserved

#### From Git Repository

```bash
qwen extensions install https://github.com/github/github-mcp-server
```

This will install the github mcp server extension.

#### From Local Path

```bash
qwen extensions install /path/to/your/extension
```

Note that we create a copy of the installed extension, so you will need to run `qwen extensions update` to pull in changes from both locally-defined extensions and those on GitHub.

### Uninstalling an extension

To uninstall, run `qwen extensions uninstall extension-name`, so, in the case of the install example:

```
qwen extensions uninstall qwen-cli-security
```

### Disabling an extension

Extensions are, by default, enabled across all workspaces. You can disable an extension entirely or for specific workspace.

For example, `qwen extensions disable extension-name` will disable the extension at the user level, so it will be disabled everywhere. `qwen extensions disable extension-name --scope=workspace` will only disable the extension in the current workspace.

### Enabling an extension

You can enable extensions using `qwen extensions enable extension-name`. You can also enable an extension for a specific workspace using `qwen extensions enable extension-name --scope=workspace` from within that workspace.

This is useful if you have an extension disabled at the top-level and only enabled in specific places.

### Updating an extension

For extensions installed from a local path or a git repository, you can explicitly update to the latest version (as reflected in the `qwen-extension.json` `version` field) with `qwen extensions update extension-name`.

You can update all extensions with:

```
qwen extensions update --all
```

## How it works

On startup, Qwen Code looks for extensions in `<home>/.qwen/extensions`

Extensions exist as a directory that contains a `qwen-extension.json` file. For example:

`<home>/.qwen/extensions/my-extension/qwen-extension.json`

### `qwen-extension.json`

The `qwen-extension.json` file contains the configuration for the extension. The file has the following structure:

```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "mcpServers": {
    "my-server": {
      "command": "node my-server.js"
    }
  },
  "contextFileName": "QWEN.md",
  "commands": "commands",
  "skills": "skills",
  "agents": "agents",
  "settings": [
    {
      "name": "API Key",
      "description": "Your API key for the service",
      "envVar": "MY_API_KEY",
      "sensitive": true
    }
  ]
}
```

- `name`: The name of the extension. This is used to uniquely identify the extension and for conflict resolution when extension commands have the same name as user or project commands. The name should be lowercase or numbers and use dashes instead of underscores or spaces. This is how users will refer to your extension in the CLI. Note that we expect this name to match the extension directory name.
- `version`: The version of the extension.
- `mcpServers`: A map of MCP servers to configure. The key is the name of the server, and the value is the server configuration. These servers will be loaded on startup just like MCP servers configured in a [`settings.json` file](./cli/configuration.md). If both an extension and a `settings.json` file configure an MCP server with the same name, the server defined in the `settings.json` file takes precedence.
  - Note that all MCP server configuration options are supported except for `trust`.
- `contextFileName`: The name of the file that contains the context for the extension. This will be used to load the context from the extension directory. If this property is not used but a `QWEN.md` file is present in your extension directory, then that file will be loaded.
- `commands`: The directory containing custom commands (default: `commands`). Commands are `.md` files that define prompts.
- `skills`: The directory containing custom skills (default: `skills`). Skills are discovered automatically and become available via the `/skills` command.
- `agents`: The directory containing custom subagents (default: `agents`). Subagents are `.yaml` or `.md` files that define specialized AI assistants.
- `settings`: An array of settings that the extension requires. When installing, users will be prompted to provide values for these settings. The values are stored securely and passed to MCP servers as environment variables.
  - Each setting has the following properties:
    - `name`: Display name for the setting
    - `description`: A description of what this setting is used for
    - `envVar`: The environment variable name that will be set
    - `sensitive`: Boolean indicating if the value should be hidden (e.g., API keys, passwords)

### Managing Extension Settings

Extensions can require configuration through settings (such as API keys or credentials). These settings can be managed using the `qwen extensions settings` CLI command:

**Set a setting value:**

```bash
qwen extensions settings set <extension-name> <setting-name> [--scope user|workspace]
```

**List all settings for an extension:**

```bash
qwen extensions settings list <extension-name>
```

**View current values (user and workspace):**

```bash
qwen extensions settings show <extension-name> <setting-name>
```

**Remove a setting value:**

```bash
qwen extensions settings unset <extension-name> <setting-name> [--scope user|workspace]
```

Settings can be configured at two levels:

- **User level** (default): Settings apply across all projects (`~/.qwen/.env`)
- **Workspace level**: Settings apply only to the current project (`.qwen/.env`)

Workspace settings take precedence over user settings. Sensitive settings are stored securely and never displayed in plain text.

When Qwen Code starts, it loads all the extensions and merges their configurations. If there are any conflicts, the workspace configuration takes precedence.

### Custom commands

Extensions can provide [custom commands](./cli/commands.md#custom-commands) by placing Markdown files in a `commands/` subdirectory within the extension directory. These commands follow the same format as user and project custom commands and use standard naming conventions.

> **Note:** The command format has been updated from TOML to Markdown. TOML files are deprecated but still supported. You can migrate existing TOML commands using the automatic migration prompt that appears when TOML files are detected.

**Example**

An extension named `gcp` with the following structure:

```
.qwen/extensions/gcp/
├── qwen-extension.json
└── commands/
    ├── deploy.md
    └── gcs/
        └── sync.md
```

Would provide these commands:

- `/deploy` - Shows as `[gcp] Custom command from deploy.md` in help
- `/gcs:sync` - Shows as `[gcp] Custom command from sync.md` in help

### Custom skills

Extensions can provide custom skills by placing skill files in a `skills/` subdirectory within the extension directory. Each skill should have a `SKILL.md` file with YAML frontmatter defining the skill's name and description.

**Example**

```
.qwen/extensions/my-extension/
├── qwen-extension.json
└── skills/
    └── pdf-processor/
        └── SKILL.md
```

The skill will be available via the `/skills` command when the extension is active.

### Custom subagents

Extensions can provide custom subagents by placing agent configuration files in an `agents/` subdirectory within the extension directory. Agents are defined using YAML or Markdown files.

**Example**

```
.qwen/extensions/my-extension/
├── qwen-extension.json
└── agents/
    └── testing-expert.yaml
```

Extension subagents appear in the subagent manager dialog under "Extension Agents" section.

### Conflict resolution

Extension commands have the lowest precedence. When a conflict occurs with user or project commands:

1. **No conflict**: Extension command uses its natural name (e.g., `/deploy`)
2. **With conflict**: Extension command is renamed with the extension prefix (e.g., `/gcp.deploy`)

For example, if both a user and the `gcp` extension define a `deploy` command:

- `/deploy` - Executes the user's deploy command
- `/gcp.deploy` - Executes the extension's deploy command (marked with `[gcp]` tag)

## Variables

Qwen Code extensions allow variable substitution in `qwen-extension.json`. This can be useful if e.g., you need the current directory to run an MCP server using `"cwd": "${extensionPath}${/}run.ts"`.

**Supported variables:**

| variable                   | description                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `${extensionPath}`         | The fully-qualified path of the extension in the user's filesystem e.g., '/Users/username/.qwen/extensions/example-extension'. This will not unwrap symlinks. |
| `${workspacePath}`         | The fully-qualified path of the current workspace.                                                                                                            |
| `${/} or ${pathSeparator}` | The path separator (differs per OS).                                                                                                                          |
