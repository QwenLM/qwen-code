# Build Remote Agent example (Qwen Code)

Example extension that attaches **Qwen Code** to [Build Remote Agent](https://grokbuildremote.com/) so a phone can **spectate** (and veto/inject) this desktop session.

Protocol `gbr/1`. Independent product by Linespotting AB. **Not affiliated with xAI or SpaceX.**

This directory is a template (`qwen extensions link`). It does not change Qwen Code core, and it does **not** replace Channels, `qwen serve`, or `packages/mobile-mcp` (those are different products/flows).

Phone is spectator, not orchestrator. Attach only:

| How | Where |
|-----|--------|
| Bot API | `http://127.0.0.1:8788` after `gbr-agent run` |
| MCP stdio | `gbr-mcp` (this manifest) |

Do not put mailbox keys in `qwen-extension.json` or git.

## Install + pair

Need **gbr-agent v0.6.0+** on the same machine as Qwen Code.

```bash
curl -fsSL https://grokbuildremote.com/install.sh | bash
gbr-agent version
gbr-agent pair          # browser QR and printed 8-char code
gbr-agent run           # leave running
```

Windows: `irm https://grokbuildremote.com/install.ps1 | iex`

Phone: open Build Remote Agent → scan QR **or** type the 8-char code. Unpair in the app before a new PC.

## MCP helper

```bash
git clone https://github.com/LinespottingOrg/GrokBuildRemote-Agents.git
cd GrokBuildRemote-Agents/mcp/gbr-mcp && npm install
node bin/gbr-mcp.js --diagnose
```

Edit `qwen-extension.json` and replace `/ABS/PATH/GrokBuildRemote-Agents/...` with that clone.

## Try the example

```bash
qwen extensions link packages/cli/src/commands/extensions/examples/gbr
```

Restart Qwen Code, then `/mcp`. You should see `gbr`.

Alternatively:

```bash
qwen mcp add --transport stdio gbr -- node /ABS/PATH/GrokBuildRemote-Agents/mcp/gbr-mcp/bin/gbr-mcp.js
```

Or paste `mcpServers.gbr` into `~/.qwen/settings.json`.

## Bot API (no MCP)

```bash
curl -sS http://127.0.0.1:8788/health
curl -sS http://127.0.0.1:8788/v1/sessions
```

Loop: diagnose → open/attach → lock → inject → wait idle → harvest excerpt → iterate or close.

Docs: https://github.com/LinespottingOrg/GrokBuildRemote-Agents/blob/main/docs/BOT-API.md
