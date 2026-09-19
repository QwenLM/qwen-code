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
qwen mcp add --scope user node-repl npx -y @qwen-code/node-repl-mcp@0.1.6
npm install --no-save --package-lock=false @qwen-code/cua-sdk@0.20.9
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
uses the app workflow on macOS:

1. binds the application with `computer.getApp(nameOrIdentifierOrPath)`;
2. reads `app.getState()` for compact accessibility text, followed by automatic
   incremental updates;
3. performs one or more actions using the short element IDs in that text;
4. fetches the latest state before deciding what to do next; and
5. closes the SDK client and resets the REPL only when no other persistent
   state is needed.

The driver is the only component that computes observation diffs. Model code
uses the typed SDK methods and does not dispatch arbitrary driver tool names.
The app handle tracks the current window and dialogs, keeps native element
identity internally, and delegates input to the native driver. Model code does
not choose foreground/background modes. Unconfirmed actions are not replayed.
`getState()` can open a discovered stopped app; actions never restart it.
Existing exact-window APIs remain available on Windows and Linux.

```js
const app = await computer.getApp('Microsoft Excel');
nodeRepl.write((await app.getState()).text);
// Use an element ID from the returned state.
await app.click(37);
await app.typeText('hello');
nodeRepl.write((await app.getState()).text);
```

Refresh state after opening or closing a dialog before reusing element IDs.
Each App state refresh captures the current screenshot internally. The default
return keeps it hidden; request it explicitly with
`app.getState({ includeScreenshot: true })` when the model needs the image.

## Permissions

The Node REPL is an MCP server that executes model-authored JavaScript with
ordinary Node.js authority. Its calls follow Qwen Code's normal
[MCP approval flow](./approval-mode.md). The SDK also enforces native
authorization.

On macOS, accessibility observation and input require Accessibility permission.
Screenshots additionally require Screen Recording permission. macOS may
attribute the grant to the terminal or IDE that launched Qwen Code. Windows and
Linux use their platform accessibility and input facilities.

## Use the computer in front of you from a remote session

When Qwen Code runs on a headless machine (a dev box, a server), the skill can
still drive the desktop you are sitting at: that computer lends its own
`node_repl` to one remote session. It works on macOS today.

Set it up once on your computer:

```bash
npx -y @qwen-code/node-repl-mcp@latest desktop-relay install
```

This installs `node_repl` and the SDK under `~/.qwen/desktop-relay` and registers
a launchd socket on `127.0.0.1:47821`. Nothing runs in the background; launchd
starts a short-lived process only when something connects.

- **From the Web Shell.** The remote daemon must run with
  `QWEN_SERVE_CLIENT_MCP_OVER_WS=1`, and the Web Shell must be a secure page
  (https, or `http://localhost` through an SSH tunnel). In a session, choose
  **Use this computer** in the sidebar footer, then **Connect this computer**.
- **From a terminal over SSH.** Add a `RemoteForward` from a socket on the remote
  machine to `127.0.0.1:47821`, then register the forwarded socket as the remote
  `node-repl` server. See the
  [`@qwen-code/node-repl-mcp` README](https://github.com/QwenLM/qwen-code/tree/main/packages/node-repl#desktop-relay)
  for the exact lines.

A dialog on your computer asks you to allow every connection. An allowed session
can run code on your computer with your permissions and see and control its
screen, just like local Computer Use, until you disconnect it or it ends. macOS
asks to allow `node` under Accessibility and Screen Recording the first time.

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
