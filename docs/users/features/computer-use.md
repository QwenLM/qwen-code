# Computer Use

Qwen Code includes a `computer-use` skill that teaches the model how to
operate desktop applications through two separately installed packages:

```text
bundled computer-use skill
  -> @qwen-code/node-repl-mcp
  -> @qwen-code/cua-sdk/computer-use
  -> native cua-driver accessibility backend
```

Qwen Code does not bundle the MCP server, SDK, or native driver. The skill
installs the external packages automatically when they are missing.

> [!warning]
>
> Computer Use can read application UI and control mouse and keyboard input.
> Use it only in trusted environments and review MCP approvals carefully.

## Automatic setup

Node.js 22 or later and npm are required.

When first used, the skill runs these commands itself:

```bash
qwen mcp add --scope user node-repl npx -y @qwen-code/node-repl-mcp@0.1.1
npm install --no-save --package-lock=false @qwen-code/cua-sdk@0.20.2
```

Restart Qwen Code after the MCP server is first added. The skill then resumes
the desktop task through `node_repl`.

The SDK installation leaves `package.json` and the lockfile unchanged, but it
does write to the workspace's `node_modules`. Its postinstall downloads and
verifies the native payload for the current platform.

Removing the MCP configuration or workspace SDK installation disables the
execution path; there is no legacy fallback.

## Use

Ask Qwen Code to use `$computer-use` for the desktop task. After bootstrap, it
follows the standard Computer Use workflow:

1. discovers the exact application and window;
2. observes full accessibility state;
3. acts through current semantic element tokens when possible;
4. fetches fresh state after every mutation;
5. verifies the requested result; and
6. closes the SDK client and resets the REPL.

The driver is the only component that computes observation diffs. Model code
uses the typed SDK methods and does not dispatch arbitrary driver tool names.

## Permissions

The Node REPL is an MCP server that executes model-authored JavaScript with
ordinary Node.js authority. Its calls follow Qwen Code's normal
[MCP approval flow](./approval-mode.md). The SDK also enforces native
authorization.

On macOS, accessibility observation and input require Accessibility permission.
Screenshots additionally require Screen Recording permission. macOS may
attribute the grant to the terminal or IDE that launched Qwen Code. Windows and
Linux use their platform accessibility and input facilities.

## Troubleshooting

- If `node_repl` is still unavailable after automatic setup, restart Qwen Code
  and verify the server with `qwen mcp list`.
- If the SDK import still fails after automatic setup, confirm Qwen Code is
  running from the workspace where the package was installed.
- After a timeout, cancellation, reset, or kernel crash, bootstrap the SDK
  client again and request fresh state.

## See also

- [Skills](./skills.md)
- [MCP servers](./mcp.md)
- [Approval Mode](./approval-mode.md)
- [Sandboxing](./sandbox.md)
