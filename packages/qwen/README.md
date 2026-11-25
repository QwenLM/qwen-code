# @qwen-code/qwen-code-next

The next Qwen Code CLI, built on the Harness kernel in `packages/harness`. It is the product layer: it chooses the open-source defaults and adds Qwen-only commands, while the agent loop, TUI, ACP and headless modes come from the kernel.

During the coexistence period the workspace is named `@qwen-code/qwen-code-next` so it does not clash with the current CLI in `packages/cli`. It is not published yet.

## Run it

```bash
npm run build
QWEN_CONFIG_DIR=$(mktemp -d) node packages/qwen/dist/main.js
```

Use a separate `QWEN_CONFIG_DIR` for now. Settings compatibility with the 0.28 format is not in place yet, so changing settings from the new TUI can write keys that `qwen serve`, Web Shell and the VS Code extension do not read.

Invoke `dist/main.js` directly rather than `qwen` from `node_modules/.bin`: both this package and `packages/cli` declare the `qwen` bin.

## What differs from the kernel defaults

- Usage statistics are off unless `privacy.usageStatisticsEnabled` is set to `true`.
- Without `security.auth.selectedType`, the CLI uses the OpenAI-compatible provider auth.
- `qwen serve` and `qwen channel` explain that they are not supported yet and exit with status 1.
