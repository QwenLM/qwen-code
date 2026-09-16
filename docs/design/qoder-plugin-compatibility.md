# Qoder Plugin Compatibility

## Context

Qwen Code installs extensions from directories, archives, Git repositories, archive URLs, and scoped npm packages. Each source is normalized to a local directory before its manifest is loaded. The [Qoder plugin layout](https://docs.qoder.com/en/cli/sdk/plugins) uses `.qoder-plugin/plugin.json` with standard commands, agents, skills, and a root `.mcp.json` file.

## Design

The existing compatible-extension conversion step recognizes the Qoder manifest alongside native Qwen, Gemini, and Claude manifests. It copies the plugin into a temporary extension directory, writes a generated `qwen-extension.json`, and records `Qoder` as the install origin. Converted Git installs record the checked-out commit in install metadata so update checks remain available after Git metadata is removed.

The generated manifest preserves `name`, `version`, `displayName`, and `description`. A missing version defaults to `1.0.0`. Standard resource directories remain in place, while existing resource path declarations use the same confined collection logic as other compatible plugin formats. Root `.mcp.json` servers are normalized to Qwen transports unless the manifest already defines MCP servers.

A safe root `system-prompt.md` is added to the extension context list. An existing `QWEN.md` and explicitly configured context files remain active alongside it, with duplicates removed.

## Security

The manifest must resolve within the plugin directory and parse as a JSON object with a valid name. Referenced resources and context files must remain inside the plugin. Bulk copying skips symlinks that escape the source root and omits Git metadata. Archive validation accepts the Qoder manifest at the archive root or inside one supported top-level wrapper directory.

## Compatibility

Adding `Qoder` to the shared extension-origin union lets CLI, daemon, SDK, ACP, and Web Shell consumers identify converted plugins without changing install commands or route shapes.
