/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `/mcp-config` bundled skill — dynamically generates
 * MCP config instructions with brand-aware paths.
 */

import { BRAND_CLI_BIN } from '../../config/brand.js';
import { CONFIG_DIR, getUserConfigDisplayPath } from '../../utils/paths.js';
import type { BundledSkillRegistrar } from './index.js';
import {
  SHELL_TOOL_NAME,
  EDIT_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../tools/tool-names.js';

export function registerMcpConfigSkill(
  registrar: BundledSkillRegistrar,
  shellToolName: string = SHELL_TOOL_NAME,
): void {
  registrar.registerBundledSkill({
    name: 'mcp-config',
    description:
      'Interactively add, update, or remove MCP (Model Context Protocol) servers in CLI configuration files.',
    allowedTools: [
      shellToolName,
      EDIT_TOOL_NAME,
      READ_FILE_TOOL_NAME,
      WRITE_FILE_TOOL_NAME,
    ],
    argumentHint: '<mcp-config>',
    location: 'bundled',
    body: '',
    async getBody() {
      const userSettingsPath = getUserConfigDisplayPath('settings.json');
      const userMcpPath = getUserConfigDisplayPath('mcp.json');
      const projectSettingsPath = `<repo>/${CONFIG_DIR}/settings.json`;
      const localSettingsPath = `<repo>/${CONFIG_DIR}/settings.local.json`;
      const cliBin = BRAND_CLI_BIN;

      return `# MCP Config Helper (${cliBin})

Help the user land an MCP server config into the right ${cliBin} config file, merge it cleanly with what's already there, and reload it so it actually takes effect.

## When this skill fires

Typical user inputs:

- Pastes a JSON blob that looks like an MCP server definition (has \`command\`, \`args\`, or \`url\` + \`type\`)
- "帮我把这个 MCP 加到项目里"
- "Add this MCP server to user scope"
- "Why isn't my new MCP showing up in \`/mcp\`?"
- "Move the filesystem MCP from project to user scope"
- "Remove the old foo MCP"

If the user's request doesn't involve MCP server registration, don't invoke this skill.

## Prefer the built-in CLI when possible

${cliBin} ships first-class commands for MCP CRUD:

- \`${cliBin} mcp add <name> <commandOrUrl> [args...] --scope <user|local|project> --transport <stdio|sse|http|ws>\`
- \`${cliBin} mcp add-json <name> <json> --scope <user|local|project>\` — ideal when the user pasted a full server body, just wrap it and pass through.
- \`${cliBin} mcp list\`, \`${cliBin} mcp get <name>\`, \`${cliBin} mcp remove <name> --scope ...\`

If the user's ask maps cleanly onto one of these, run the command via the available shell tool instead of hand-editing JSON — the CLI handles collision detection, OAuth setup, scope validation, and writes to the right file. Fall back to direct file editing only when: (a) the user is doing a cross-scope move (read from one, write to another), (b) the user wants a surgical edit to an env var or header on an existing entry, or (c) the CLI rejects the input and you need to diagnose why.

## What the user pastes

MCP configs come in several shapes. Normalize them before writing. Common inputs:

**Full server block (most common — from docs/README):**
\`\`\`json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
\`\`\`

**Single server entry (name + body):**
\`\`\`json
"filesystem": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
}
\`\`\`

**Just the body (user will supply the name):**
\`\`\`json
{ "command": "npx", "args": ["-y", "..."] }
\`\`\`

**HTTP / SSE transport:**
\`\`\`json
{
  "type": "http",
  "url": "https://example.com/mcp",
  "headers": { "Authorization": "Bearer ..." }
}
\`\`\`

If the name is missing from the snippet, ask the user what to call the server. Don't invent one.

## Target files (scopes)

${cliBin} supports three MCP scopes. Pick the right file — the difference matters:

| Scope     | File                                       | \`mcpServers\` lives at          | When to use                                                           |
| --------- | ------------------------------------------ | ------------------------------ | --------------------------------------------------------------------- |
| \`project\` | \`${projectSettingsPath}\`              | top-level \`mcpServers\`         | Shared with the team via git. Use for project-wide, committed config. |
| \`user\`    | \`${userSettingsPath}\`                | top-level \`mcpServers\`         | Available across all projects for this user. Use for personal tools. |
| \`local\`   | \`${localSettingsPath}\`        | top-level \`mcpServers\`         | Project-specific, user-only, **gitignored**. This is the CLI default. |

**Do NOT write to any of these — they are wrong targets that look plausible but the CLI does not read:**
- \`<repo>/.mcp.json\` or \`~/.mcp.json\` (Claude Code convention, not ${cliBin})
- A duplicated-home path or standalone \`${userMcpPath}\` file (wrong target — user MCPs go inside \`${userSettingsPath}\` under \`mcpServers\`)
- \`~/Library/Application Support/<app>/User/mcp.json\` or any VS Code extension path
- \`~/.claude.json\` or \`~/.claude/settings.json\` (those are Claude Code, not ${cliBin})

The only three valid targets are the three rows in the table above. If you find yourself about to write somewhere else, stop.

**Scope selection — don't default silently.** If the user hasn't specified a scope, ask before writing. A one-liner is enough: "Add this to **project** (\`${projectSettingsPath}\`, committed), **user** (\`${userSettingsPath}\`, global), or **local** (\`${localSettingsPath}\`, gitignored)?"

Don't guess "probably local scope just because it's the CLI default" — the difference between project (checked into git, teammates see it) and user/local (personal) is significant, and picking wrong can leak secrets or clutter a teammate's config. Users routinely paste MCP configs from docs that don't mention scope; they need the prompt.

Exception: proceed without asking only when phrasing makes it genuinely unambiguous — "add to this project", "push this to the team", "only for me globally", "just for this repo". Vague signals like "装一下" / "加进去" do not qualify.

## Workflow

1. **Parse the pasted config.** Extract: server name, transport (\`stdio\` if \`command\` present, else \`http\`/\`sse\`/\`ws\` based on \`type\`/\`url\`), and the server body. Normalize so the write step only deals with a clean \`(name, body)\` pair.

2. **Confirm scope** if not obvious from the user's message (see table above).

3. **Decide: CLI or direct edit?** For a plain add with a clean body, \`${cliBin} mcp add-json <name> '<json>' --scope <scope>\` is the shortest path and handles collision errors for you. For cross-scope moves, surgical field edits, or removals from multiple scopes at once, go direct.

4. **If direct-editing, read the target file.** Use the Read tool. If the file doesn't exist, plan to create it with \`{ "mcpServers": { ... } }\`. If it exists, add/update a top-level \`mcpServers\` key and preserve every other setting already in the file.

5. **Detect collisions — but don't be precious.** Two sub-cases:
   - **User explicitly asked to update/replace/move an existing entry** (e.g. "把 filesystem 路径改成...", "update the github token", "replace example-api"): just do it. Don't ask for reconfirmation. A one-line "found existing filesystem at /old/path → updating to /new/path" is plenty; the user already decided.
   - **User pasted a new config that happens to collide** (no mention of the existing entry, likely unaware it's there): stop and show them the existing entry vs. the new one, ask replace/rename/cancel. Silent overwrite here loses hand-edited fields (env vars, auth headers) and surprises the user.

   The distinguishing signal: did the user's wording acknowledge that the server already exists? If yes, proceed. If no and there's a collision, surface it. Note that \`${cliBin} mcp add\`/\`add-json\` *refuses* to overwrite by default — if the user wants a replace, either remove-then-add via CLI, or fall back to a direct Edit.

6. **Merge and write.** For direct edits, use the Edit tool for surgical changes when the file exists (especially \`${userSettingsPath}\`, which holds unrelated settings and shouldn't be rewritten wholesale). Only rewrite the whole file with Write when creating it fresh. Preserve formatting — match the existing indentation.

7. **Validate.** After writing, read the relevant slice back and confirm the JSON parses and the server is present. All three targets are real settings files — a corrupted write breaks settings on the next start, so validation isn't optional.

8. **Tell the user how to reload.** See below.

## Reload instructions

MCP servers are loaded at startup and on explicit reconnect. After editing config, the user must reload. Tell them the shortest path:

- **Added or changed a server (running session)**: run \`/mcp reload\` inside ${cliBin} — it restarts all MCP clients and refreshes the tool surface. This is the one you want 95% of the time.
- **Inspect what's loaded**: \`/mcp\` lists current servers and their status.
- **Project-scope first-time add**: ${cliBin} prompts for approval before running project-level MCP servers (this is enforced via the project-MCP approval flow). The user will see a trust prompt the first time \`/mcp reload\` picks up the new entry — mention this so they're not surprised.
- **Removed a server**: \`/mcp reload\` drops the connection. If you only removed it from one of multiple scopes, it may still show up from another — \`${cliBin} mcp list\` confirms where it still lives.

Keep the reload instruction to one or two sentences — don't lecture.

## Gotchas worth flagging

- **Env vars with secrets**: if the pasted config has \`"env": { "API_KEY": "sk-..." }\` with a real-looking secret, flag it: "This config has what looks like a real API key — do you want to move it to an env var reference or keep it inline?" Don't refuse; just surface the choice.
- **Settings files hold unrelated keys**: all three targets also store user preferences, keybinding toggles, auth hints, etc. Never rewrite a settings file whole — Edit the specific \`mcpServers\` slice.
- **Configured locations**: user settings live in \`${userSettingsPath}\`; project shared settings in \`${projectSettingsPath}\`; project-local (gitignored) in \`${localSettingsPath}\`. Keep the scope clear before writing.
- **Relative paths**: stdio \`command\`/\`args\` often reference local scripts. If the user pastes \`./server.js\`, ask whether they want it resolved to an absolute path — relative paths break when the CLI starts from a different cwd.
- **Project-scope is committed**: \`${projectSettingsPath}\` ends up in git. Remind the user not to include secrets there — for secret-bearing configs prefer \`user\` or \`local\`.
- **Plugin-provided MCPs**: servers whose names start with \`mcp__plugin_\` come from installed extensions, not user config. Don't try to edit them via this skill — point the user to the extension's own config.

## Output style

Length should match what's actually at stake — not a fixed rule.

**Default (simple add, no concerns):** one or two sentences. What was written where, how to reload. The user pasted config and wants it landed.

> Added \`filesystem\` (stdio) to \`${userSettingsPath}\` (user scope). Run \`/mcp reload\` to pick it up.

**When there's something worth flagging, don't suppress it to stay terse.** Brief matters less than "the user understood what just happened and what to do next." Specifically, add a short follow-up paragraph (2-4 sentences) when:

- **The pasted config contained a real-looking secret** (Bearer token, API key, password). Tell them it's now sitting in plaintext in the config file, that project-scope \`${projectSettingsPath}\` is committed to git and \`${userSettingsPath}\` is often synced via dotfiles, and offer to switch to env-var reference or rotation if exposed. Don't assume they've thought this through — many people paste from copy-paste without realizing.
- **The operation has a non-obvious side effect** the user probably didn't anticipate. E.g., for \`@modelcontextprotocol/server-filesystem\`, changing the path replaces — it doesn't merge, so the old dir loses access. Mention it in one line.
- **The collision was silent** (user didn't mention the existing entry). Surface what was there before the change.
- **Scope crossed trust boundary** (e.g. moved from \`local\` → \`project\`). Remind them it's now committed and teammates will pick it up on next pull.

Don't pad. Don't add headers (\`## 生效方式\`, \`## 安全提醒\`) for a 2-sentence response — just write the sentences. Headers only earn their keep when the response is long enough that scanning matters.
`;
    },
  });
}
