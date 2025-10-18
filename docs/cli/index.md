# Qwen Code CLI

Within Qwen Code, `packages/cli` is the frontend for users to send and receive prompts with Qwen and other AI models and their associated tools. For a general overview of Qwen Code, see the [main documentation page](../index.md).

## Navigating this section

- **[Authentication](./authentication.md):** A guide to setting up authentication with Qwen OAuth and OpenAI-compatible providers.
- **[Commands](./commands.md):** A reference for Qwen Code CLI commands (e.g., `/help`, `/tools`, `/theme`).
- **[Configuration](./configuration.md):** A guide to tailoring Qwen Code CLI behavior using configuration files.
- **[Token Caching](./token-caching.md):** Optimize API costs through token caching.
- **[Themes](./themes.md)**: A guide to customizing the CLI's appearance with different themes.
- **[Tutorials](tutorials.md)**: A tutorial showing how to use Qwen Code to automate a development task.
- **[Welcome Back](./welcome-back.md)**: Learn about the Welcome Back feature that helps you resume work seamlessly across sessions.

## Non-interactive mode

Qwen Code can be run in a non-interactive mode, which is useful for scripting and automation. In this mode, you pipe input to the CLI, it executes the command, and then it exits.

The following example pipes a command to Qwen Code from your terminal:

```bash
echo "What is fine tuning?" | qwen
```

Qwen Code executes the command and prints the output to your terminal. Note that you can achieve the same behavior by using the `--prompt` or `-p` flag. For example:

```bash
qwen -p "What is fine tuning?"
```

### Structured stream-json mode

For programmatic integrations, Qwen Code supports structured JSON Lines input and output:

- `--output-format stream-json` switches stdout to emit Claude-compatible envelopes (`user`, `assistant`, `result`, etc.).
- `--input-format stream-json` lets you pipe newline-delimited JSON requests into stdin (e.g., control requests and user messages).
- `--include-partial-messages` enables incremental `stream_event` deltas alongside the final assistant message.

Example one-shot invocation:

```bash
echo '{"type":"user","message":{"content":"List supported flags"}}' \
  | qwen --input-format stream-json --output-format stream-json
```

When run in this mode, every stdout line is a standalone JSON object you can parse reliably. Control responses (for example, acknowledging `control_request.initialize`) are also written using the same envelope schema.

To keep a session open for multiple messages, omit `--prompt` and keep stdin open (for example, by running the CLI directly and typing JSON lines):

```bash
npm run stream-json-session
```

The process will remain active until EOF (`Ctrl+D`) or an explicit `control_request.interrupt`, making it suitable for SDK transports that maintain a persistent subprocess connection.

The repository also provides a minimal Python client sample at
`docs/examples/stream-json/simple_stream_json_client.py`. The script is adapted
from `third-party/anthropics/claude-agent-sdk-python/examples/quick_start.py`
and illustrates how to drive the session lifecycle with `control_request`, while
showcasing a short multi-turn exchange (sending several `user` messages in a
row):

```bash
python docs/examples/stream-json/simple_stream_json_client.py
```

Each log entry is separated with `------` and prefixed with `[client]` or `[cli]`
to make debugging the JSON stream easier.
