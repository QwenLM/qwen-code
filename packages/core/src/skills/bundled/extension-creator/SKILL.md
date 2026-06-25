---
name: extension-creator
description: Create, scaffold, customize, validate, and locally test Qwen Code extensions. Use when the user wants a new Qwen Code extension, needs help choosing an extension template, wants to add QWEN.md context, commands, skills, agents, MCP servers, settings, hooks, channels, or LSP servers, or asks how to link and test an extension locally.
argument-hint: '<extension-path> [template|capabilities]'
allowedTools:
  - run_shell_command
  - write_file
  - edit
  - read_file
  - glob
  - grep_search
  - ask_user_question
---

# Extension Creator

Use this skill to create Qwen Code extensions with the existing extension
scaffold command and bundled templates.

## Workflow

1. Identify the target extension path and requested capabilities.
2. Scaffold with `qwen extensions new <path> [template]`.
3. Customize the generated files for the user's extension.
4. Check the extension shape before handing it back.
5. Link the extension locally with `qwen extensions link <path>`.

## Template Selection

Use the smallest template that covers the requested capability:

- No template: minimal extension with only `qwen-extension.json`.
- `context`: persistent instructions through `QWEN.md`.
- `commands`: custom slash commands under `commands/`.
- `skills`: custom skills under `skills/<skill-name>/SKILL.md`.
- `agent`: custom subagents under `agents/`.
- `mcp-server`: MCP server code plus `mcpServers` manifest wiring.
- `starter`: combined context, command, skill, agent, and MCP server example.

If the request names several capabilities, use `starter` only when the combined
example is useful; otherwise scaffold the closest template and add the missing
folders by hand.

## Extension Shape

Keep `qwen-extension.json` at the extension root. Common runtime-relevant Qwen
Code extension fields include:

- `name`
- `version`
- `displayName`
- `description`
- `contextFileName`
- `mcpServers`
- `settings`
- `hooks`
- `channels`
- `lspServers`

Use these companion locations when needed:

- `QWEN.md` for extension context.
- `commands/` for slash command markdown files.
- `skills/` for skill folders containing `SKILL.md`.
- `agents/` for subagent markdown files.
- `mcpServers` in `qwen-extension.json` for MCP server startup config.
- `settings` in `qwen-extension.json` for user-provided configuration.
- `hooks` in `qwen-extension.json` for lifecycle hooks.
- `channels` in `qwen-extension.json` for custom channel adapters.
- `lspServers` in `qwen-extension.json` for LSP server configuration.

Qwen Code discovers command, skill, and agent resources from the corresponding
folders, so prefer the folder structure for those resources.

## Local Test Flow

For templates with TypeScript or MCP server code:

Only run `npm install` inside directories scaffolded by `qwen extensions new`
in the current session. If the user provides a pre-existing path, review the
`package.json` scripts before installing dependencies.

```bash
cd <extension-path>
npm install
npm run build
qwen extensions link .
```

For context, commands, skills, or agent-only extensions:

```bash
qwen extensions link <extension-path>
```

After linking, tell the user to restart Qwen Code if the new extension is not
visible in the current session.

## Before Handoff

- Confirm `qwen-extension.json` exists at the extension root.
- Confirm referenced folders or files exist when `contextFileName`, `commands`,
  `skills`, `agents`, `mcpServers`, `hooks`, or `channels` are configured.
- Keep the scaffold focused on the requested capability; do not add unused
  folders or build tooling.
