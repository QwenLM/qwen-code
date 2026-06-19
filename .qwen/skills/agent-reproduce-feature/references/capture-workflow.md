# Capture Workflow Reference

This skill follows the nested-agent pattern described in "解决问题的原始冲动": run the original tool under a harness, capture the real request bodies and tool schemas, implement the substitute, then compare traces.

## Local Roles

- Outer harness: the current agent session.
- Reference program: a nested `codex`, `claude`, or `claude-code` command that demonstrates the feature.
- Target program: Qwen Code in the current working directory unless the user explicitly provides another path.
- Capture layer: local state snapshots, `mitmdump`, and terminal transcript
  capture.

## Reference Adapters

Select one reference adapter before capture:

| Adapter       | Interactive command       | Headless command                                       |
| ------------- | ------------------------- | ------------------------------------------------------ |
| `codex`       | `codex`                   | `codex exec "<prompt>"`                                |
| `claude-code` | `claude` or `claude-code` | Discover locally; if unavailable, use tmux interaction |

Do not assume Claude Code's exact non-interactive flags. Check `claude --help` or `claude-code --help` in the user's environment and record the command used.

## Choosing Execution Mode

Use non-interactive/headless mode when:

- the feature has a stable CLI entrypoint
- output can be asserted from stdout/stderr/files
- request bodies are the primary evidence

Use tmux when:

- the feature depends on slash-command input, readline behavior, or a TUI state
- screen output matters
- you need to send multiple keystroke batches

Use both when a feature has model calls and visible terminal state.

## State Capture

Run a state snapshot before and after the reference scenario:

```sh
.qwen/skills/agent-reproduce-feature/scripts/capture_state.py \
  snapshot OUT_DIR/state-before --agent codex

.qwen/skills/agent-reproduce-feature/scripts/capture_state.py \
  snapshot OUT_DIR/state-after --agent codex

.qwen/skills/agent-reproduce-feature/scripts/capture_state.py \
  diff OUT_DIR/state-before OUT_DIR/state-after \
  --out-dir OUT_DIR/state-diff
```

Default state roots:

| Adapter       | State root  |
| ------------- | ----------- |
| `codex`       | `~/.codex`  |
| `claude-code` | `~/.claude` |

Generated files:

- `state-manifest.json`: file metadata plus redacted text for safe small text
  files.
- `state-diff.md`: model-readable summary of added, removed, and modified
  files.
- `state-diff.json`: machine-readable equivalent.

The snapshot tool records symlinks but does not follow them. It emits only
metadata, without content hashes, for paths that look like auth, token, session,
history, cache, log, or credential files. Review the Markdown before putting
any state diff into a tracked artifact.

## HTTP Capture

Install mitmproxy if needed:

```sh
python -m pip install --user mitmproxy
```

Run a command under capture:

```sh
.qwen/skills/agent-reproduce-feature/scripts/run_with_mitm.sh OUT_DIR -- COMMAND ARG...
```

Generated files:

- `mitm.log`: mitmdump process log
- `http.jsonl`: redacted request/response records
- `command.stdout`, `command.stderr`, `command.exit`: child process result
- `env.txt`: non-secret capture metadata

The script sets:

- `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`
- `NODE_EXTRA_CA_CERTS`
- `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`
- `REPRO_CAPTURE_OUT`

The default CA path is `~/.mitmproxy/mitmproxy-ca-cert.pem`. Some CLIs ignore one or more of these variables; if `http.jsonl` is empty, verify proxy support before changing product code.

## Terminal Capture

Run:

```sh
.qwen/skills/agent-reproduce-feature/scripts/run_tmux_capture.sh OUT_DIR COMMAND ARG...
```

Generated files:

- `tmux-pane.txt`: captured pane contents
- `tmux-session.txt`: session metadata and attach instructions
- `command.txt`: the launched command

The tmux session stays alive so the outer agent can send keys, inspect output, and capture again. Kill it after use:

```sh
tmux kill-session -t SESSION_NAME
```

## What To Extract

From HTTP records:

- model name and model settings
- system/developer message fragments that explain the feature
- user-visible command mapping
- tool/function schema names, descriptions, and JSON schemas
- response format or streaming protocol details

From terminal records:

- exact slash command syntax and completion behavior
- visible state transitions
- error text and recoverable failure paths
- whether the feature is synchronous, streaming, or backgrounded

From state diffs:

- added or modified config files
- permission, MCP, memory, or preference stores touched by the scenario
- state changes that explain later behavior but were not visible in HTTP or
  terminal output

## Redaction

Never commit raw traces. Before moving examples into docs or tests, remove:

- authorization headers and API keys
- user-specific paths
- unrelated prompt content
- private repository names and issue content
- full request bodies that are not needed for the feature contract
- state diff content that could expose account, prompt, session, or credential
  data
