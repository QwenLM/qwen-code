# Other ACP clients

> Qwen Code speaks the [Agent Client Protocol](https://agentclientprotocol.com/) (ACP), so any app that supports ACP can run it: editors, desktop apps, and terminal tools. This page covers what is the same in every client. For Zed and JetBrains, see their own pages.

### What you get over ACP

- **Sessions in your client's own interface**: prompts, replies, tool calls and file edits shown by the client
- **Approval modes**: the client can show and switch Qwen Code's approval mode, from Plan to YOLO
- **The same configuration**: Qwen Code reads the same `settings.json`, model providers and API keys it uses in the terminal

### Requirements

- An ACP client. The [ACP clients list](https://agentclientprotocol.com/get-started/clients) shows which apps support it.
- Qwen Code CLI installed
- An API key Qwen Code can use (see [Authentication](./configuration/auth.md) and [Model Providers](./configuration/model-providers.md))

### Installation

#### Install from the ACP Registry (Recommended)

Qwen Code is in the [ACP Agent Registry](https://agentclientprotocol.com/get-started/registry). Clients that read the registry list it as **Qwen Code** and install it for you. Look for an option such as **Add agent** or **Install from Registry** in your client's settings.

#### Manual setup

1. Install Qwen Code CLI:

```bash
npm install -g @qwen-code/qwen-code
```

2. In your client, add a custom agent that runs `qwen` with the argument `--acp`. Most clients take a command and a list of arguments, for example:

```json
{
  "command": "qwen",
  "args": ["--acp"],
  "env": {}
}
```

`--experimental-acp` still works but is deprecated; use `--acp`.

### Signing in

Over ACP, Qwen Code signs in with an API key. Set up your provider once in a terminal before you start it from a client:

1. Run `qwen`
2. Type `/auth` and follow the steps for your provider
3. Close it

Your client will then start Qwen Code with that configuration. You can also configure providers directly in `settings.json` (see [Model Providers](./configuration/model-providers.md)).

### Approval modes

Every new ACP session starts in the mode set by `tools.approvalMode`, which is **Auto** unless you change it. In Auto, a classifier approves actions it judges safe and blocks risky ones, so some file edits and shell commands run without asking you.

| Mode        | What it does                                                 |
| ----------- | ------------------------------------------------------------ |
| `plan`      | Analyze only, do not modify files or execute commands        |
| `default`   | Require approval for file edits or shell commands            |
| `auto-edit` | Automatically approve file edits                             |
| `auto`      | LLM classifier auto-approves safe actions, blocks risky ones |
| `yolo`      | Automatically approve all tools                              |

Qwen Code offers all five modes to the client when a session starts. A client can switch modes at any time with the ACP `session/set_mode` request, and many show a mode picker for this.

To have every ACP session start by asking before edits and commands, do one of these:

- Add `--approval-mode default` to the agent's arguments in your client: `"args": ["--acp", "--approval-mode", "default"]`
- Set it in `settings.json`, for all projects (`~/.qwen/settings.json`) or one project (`.qwen/settings.json`):

```json
{
  "tools": {
    "approvalMode": "default"
  }
}
```

See [Settings](./configuration/settings.md) for the full list.

## Troubleshooting

### Agent not appearing or not starting

- Run `qwen --version` in a terminal to verify installation
- If your client can't find `qwen`, give it the full path to the command
- Check that the arguments include `--acp`

### Qwen Code not responding

- Verify the CLI works by running `qwen` in a terminal
- Check that a provider is set up (`/auth` in `qwen`)
- [File an issue on GitHub](https://github.com/qwenlm/qwen-code/issues) if the problem persists
