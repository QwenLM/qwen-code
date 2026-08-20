# Agent Plugins v1

Qwen Code natively loads portable [Agent Plugins v1](https://agent-plugins.org/)
packages. The package keeps its standard `plugin.json`, `mcp.json`, and
`SKILL.md` files: installation does not generate `qwen-extension.json` or
rewrite portable files.

Use the existing extension commands with a local directory, link, archive,
Git repository, archive URL, or scoped npm package:

```bash
qwen extensions install ./my-agent-plugin
qwen extensions link ./my-agent-plugin
qwen extensions install owner/my-agent-plugin
```

The root manifest must target the canonical v1 schema:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-agent-plugin",
  "version": "1.0.0"
}
```

## Supported capabilities

| Capability                                 | Support                                  |
| ------------------------------------------ | ---------------------------------------- |
| Direct-child `skills/*/SKILL.md`           | Yes                                      |
| stdio MCP servers                          | Yes                                      |
| Streamable HTTP MCP servers                | Yes                                      |
| Legacy HTTP+SSE MCP servers                | No; the entry is skipped                 |
| Commands, agents, and hooks                | No; these directories are ignored        |
| Qwen context, settings, channels, and apps | No                                       |
| `extensions.*` client namespaces           | No; unimplemented namespaces are ignored |

Skills follow the [Agent Skills specification](https://agentskills.io/specification).
An invalid skill is skipped without disabling valid sibling skills. The
experimental `allowed-tools` field is recognized as a string but does not grant
pre-approved Qwen tools.

For stdio MCP servers, Qwen Code expands `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`
once in `args`, environment values, and `cwd`. `PLUGIN_DATA` is a writable
per-installation directory whose contents persist across updates and reinstall.
Remote MCP endpoints must use HTTPS, except for loopback HTTP endpoints.

Agent Plugins v1 is a package format, not a marketplace integration. Install
packages through Qwen Code's existing extension sources.
