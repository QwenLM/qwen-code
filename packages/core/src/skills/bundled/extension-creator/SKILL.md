---
name: extension-creator
description: Create, scaffold, customize, validate, and locally test Qwen Code extensions. Use when the user wants a new Qwen Code extension, needs help choosing an extension template, wants to add QWEN.md context, commands, skills, agents, MCP servers, settings, hooks, channels, or LSP servers, or asks how to link and test an extension locally. Invoke with `/extension-creator` followed by an extension path and optional template name.
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
2. Run `qwen extensions new --help` when you need to confirm the currently
   available templates.
3. If the path does not exist, scaffold with
   `qwen extensions new <path> [template]`. If the extension already exists,
   skip scaffolding and read the existing `qwen-extension.json` before
   customizing it.
4. If any command in the workflow fails, stop and report the error to the user.
   Do not proceed to the next step until the user confirms how to continue.
5. Customize the generated files for the user's extension.
6. Check the extension shape before handing it back.
7. Link the extension locally with `qwen extensions link <path>`.

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

- `name` - unique extension id. Use only letters, digits, underscores, dots,
  and dashes.
- `version`
- `displayName`
- `description`
- `contextFileName`
- `mcpServers` - MCP server startup config. Use `${extensionPath}` and `${/}`
  for portable paths, for example
  `"args": ["${extensionPath}${/}dist${/}server.js"]`.
- `settings` - user-provided configuration.
- `hooks` - lifecycle hooks.
- `channels` - custom channel adapters.
- `lspServers` - LSP server configuration.

Use these resource locations when needed:

- `QWEN.md` for extension context.
- `commands/` for slash command markdown files.
- `skills/` for skill folders containing `SKILL.md`.
- `agents/` for subagent markdown files.

Qwen Code discovers command, skill, and agent resources from the corresponding
folders, so prefer the folder structure for those resources.

## Local Test Flow

If the user provides a pre-existing path, review `package.json` scripts when
present and review `qwen-extension.json` before running any npm command or
linking the extension. Pay special attention to `install`, `preinstall`,
`postinstall`, `build`, `hooks`, `mcpServers`, `channels`, and `lspServers`.
These fields can execute arbitrary code. Flag suspicious command values such as
network downloads, piped shells, or encoded payloads; describe the concern to
the user and ask whether to proceed.

For templates with TypeScript or MCP server code:

Only run `npm install` and `npm run build` inside directories scaffolded by
`qwen extensions new` in the current session, unless the pre-existing path
review above is complete.

```bash
cd <extension-path> && \
  npm install && \
  npm run build && \
  qwen extensions link .
```

If any step exits non-zero, stop and report the error to the user. Do not link
an extension that failed to build.

For context, commands, skills, or agent-only extensions:

```bash
qwen extensions link <extension-path>
```

After linking, tell the user to restart Qwen Code if the new extension is not
visible in the current session.

## Before Handoff

- Confirm `qwen-extension.json` exists at the extension root.
- Confirm `name` is set and contains only letters, digits, underscores, dots,
  and dashes.
- Confirm referenced folders or files exist when `contextFileName`, `commands`,
  `skills`, `agents`, `mcpServers`, `hooks`, `channels`, or `lspServers` are
  configured.
- Keep the scaffold focused on the requested capability; do not add unused
  folders or build tooling.
