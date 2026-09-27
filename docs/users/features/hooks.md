# Qwen Code Hooks

## Overview

Qwen Code hooks provide a powerful mechanism for extending and customizing the behavior of the Qwen Code application. Hooks allow users to execute custom scripts or programs at specific points in the application lifecycle, such as before tool execution, after tool execution, at session start/end, and during other key events.

Hooks are enabled by default. You can temporarily disable all hooks by setting `disableAllHooks` to `true` in your settings file (at the top level, alongside `hooks`):

```json
{
  "disableAllHooks": true,
  "hooks": {
    "PreToolUse": [...]
  }
}
```

This disables all hooks without deleting their configurations.

## What are Hooks?

Hooks are user-defined scripts or programs that are automatically executed by Qwen Code at predefined points in the application flow. They allow users to:

- Monitor and audit tool usage
- Enforce security policies
- Inject additional context into conversations
- Customize application behavior based on events
- Integrate with external systems and services
- Modify tool inputs or responses programmatically

### Browsing your hooks

Run `/hooks` to open a read-only browser of the hooks this session runs. It moves from events to matchers to the individual hooks under a matcher; events without matcher support go straight to their hooks. A hook's details show its type, where it comes from, whether it is enabled, its command, URL or prompt, and, when they are set, its timeout, status message, HTTP `if` condition and whether it runs once or in the background. Hooks registered for the current session by skills or the SDK are listed with the source Session.

The browser never edits your configuration: to add, change or remove a hook, edit `settings.json`. It does re-read it. Opening the interactive menu reloads hook definitions from the user, workspace and system (System and SystemDefaults) settings files used by this session, including when the session runs in a worktree, so definitions you added, changed or removed since the session started take effect without a restart. If the user or workspace file cannot be read or parsed, both previous settings snapshots and the running hooks are retained, the files are left untouched, and an error is shown. If a system settings file cannot be read or parsed, the hooks from the system files stay as they were, your other edits still take effect, the file is left untouched, and an error names it.

Reloading requires this explicit menu-open action: saving a file, pulling changes or switching branches does not automatically arm new hook commands. The non-interactive `/hooks list` only displays the registry currently loaded by that process; it does not reload settings. In an interactive terminal, `/hooks list` opens the same menu as `/hooks`.

This reload covers hook definitions, not hook controls or HTTP security settings. Changes to `disableAllHooks`, `stopHookBlockingCap`, `security.allowedHttpHookUrls` and `security.allowPrivateNetworkHooks` still require a restart. Hooks registered at runtime by skills or the SDK are not affected. Project hooks load only in a trusted folder. When hooks are turned off by `disableAllHooks`, `--safe-mode` or `--bare`, none load and the browser says so at the top.

## Hook Types

Qwen Code supports four hook executor types:

| Type       | Description                                                                                    |
| :--------- | :--------------------------------------------------------------------------------------------- |
| `command`  | Execute a shell command. Receives JSON via `stdin`, returns results via `stdout`.              |
| `http`     | Send JSON as a `POST` request body to a specified URL. Returns results via HTTP response body. |
| `function` | Directly call a registered JavaScript function (session-level hooks only).                     |
| `prompt`   | Use an LLM to evaluate hook input and return a decision.                                       |

### Command Hooks

Command hooks execute commands via child processes. Input JSON is passed through stdin, and output is returned via stdout.

**Configuration:**

| Field           | Type                     | Required | Description                                 |
| :-------------- | :----------------------- | :------- | :------------------------------------------ |
| `type`          | `"command"`              | Yes      | Hook type                                   |
| `command`       | `string`                 | Yes      | Command to execute                          |
| `name`          | `string`                 | No       | Hook name (for logging)                     |
| `description`   | `string`                 | No       | Hook description                            |
| `timeout`       | `number`                 | No       | Timeout in seconds, default 60              |
| `async`         | `boolean`                | No       | Whether to run asynchronously in background |
| `env`           | `Record<string, string>` | No       | Environment variables                       |
| `shell`         | `"bash" \| "powershell"` | No       | Shell to use                                |
| `statusMessage` | `string`                 | No       | Status message displayed during execution   |

`timeout` is in seconds for command, HTTP and prompt hooks; SDK-registered function hooks keep milliseconds. Command hook timeouts used to be written in milliseconds, so for command hooks a value of `1000` or more is still read as milliseconds and existing settings keep working. To migrate, look for command hooks whose `timeout` is `1000` or more and rewrite the value in seconds, for example `10000` as `10`. To give a command hook a timeout of 1000 seconds or more, keep writing it in milliseconds, for example `1800000` for 30 minutes. A command hook `timeout` that is not a positive number, such as `"30s"`, is ignored and the 60 second default applies. With debug logging enabled (`QWEN_DEBUG_LOG_FILE=1`), each command hook with a millisecond or ignored `timeout` is named once per session in that session's debug log.

**Example:**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "write_file",
        "hooks": [
          {
            "type": "command",
            "command": "\"$QWEN_PROJECT_DIR/.qwen/hooks/security-check.sh\"",
            "name": "security-check",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

`QWEN_PROJECT_DIR`, `CLAUDE_PROJECT_DIR` and `GEMINI_PROJECT_DIR` are set to the project directory in the environment of every command hook. Bash hooks read them from the environment, so double-quote them like any other shell variable, as in `"$QWEN_PROJECT_DIR/.qwen/hooks/security-check.sh"`. For cmd hooks, and for a bare `$QWEN_PROJECT_DIR` in PowerShell hooks, the variable is replaced with the quoted project directory before the command runs; `$env:QWEN_PROJECT_DIR` also works in PowerShell.

Migration: bash hooks used to have these variables replaced in the command text before the shell ran, and that replacement has been removed. A bash hook that leaves the variable unquoted in a project path containing spaces, or writes it inside single quotes such as `'$QWEN_PROJECT_DIR/hook.sh'`, must now double-quote it: `"$QWEN_PROJECT_DIR/hook.sh"`.

### HTTP Hooks

HTTP hooks send hook input as POST requests to specified URLs. They support URL whitelists, DNS-level SSRF protection, environment variable interpolation, and other security features.

**Configuration:**

| Field            | Type                     | Required | Description                                               |
| :--------------- | :----------------------- | :------- | :-------------------------------------------------------- |
| `type`           | `"http"`                 | Yes      | Hook type                                                 |
| `url`            | `string`                 | Yes      | Target URL                                                |
| `headers`        | `Record<string, string>` | No       | Request headers (supports env var interpolation)          |
| `allowedEnvVars` | `string[]`               | No       | Whitelist of environment variables allowed in URL/headers |
| `timeout`        | `number`                 | No       | Timeout in seconds, default 600                           |
| `name`           | `string`                 | No       | Hook name (for logging)                                   |
| `statusMessage`  | `string`                 | No       | Status message displayed during execution                 |
| `once`           | `boolean`                | No       | Execute only once per event per session (HTTP hooks only) |

**Security Features:**

- **URL Whitelist**: Configure allowed URL patterns via `allowedUrls`
- **SSRF Protection**: Blocks private IPs (10.x.x.x, 172.16-31.x.x, 192.168.x.x, etc.) but allows loopback addresses (127.0.0.1, ::1)
- **DNS Validation**: Validates domain resolution before requests to prevent DNS rebinding attacks
- **Environment Variable Interpolation**: `${VAR}` syntax, only allows variables in `allowedEnvVars` whitelist

#### Allowing private-network hooks (managed environments only)

By default, HTTP hooks cannot target private or link-local IP ranges. In platform-managed environments where the hook receiver is a first-party, VPC-internal endpoint (for example, an internal API gateway resolving to `172.16.0.0/12`), you can relax the IP-range checks with:

```json
{
  "security": {
    "allowPrivateNetworkHooks": true
  }
}
```

- This setting is **only honored from User, System, and SystemDefaults settings scopes**. A value set in Workspace (project) settings is ignored and logged as a warning, so a cloned repository can never self-grant this bypass.
- The flag relaxes only the general private/CGNAT/link-local **range** checks. Cloud metadata endpoints stay blocked in every configuration: the `BLOCKED_HOSTS` list is matched literally (`metadata.google.internal`, `metadata.azure.internal`, ...), and the metadata IPs `169.254.169.254` and `100.100.100.200` are blocked in all serialized forms (including IPv4-mapped IPv6 such as `::ffff:a9fe:a9fe`) and after DNS resolution.
- The `security.allowedHttpHookUrls` whitelist still applies independently. In managed environments, pair this flag with a whitelist so only the intended internal endpoints are reachable. A whitelist in Workspace (project) settings is honored only when no User, System, or SystemDefaults scope sets one; otherwise it is ignored and logged as a warning, so a repository can narrow where its hooks send data but never replace a whitelist you configured (an empty whitelist means "allow all").
- HTTP hooks never follow redirects. A 3xx response is treated like any other non-2xx status: a non-blocking hook failure, and the redirect target is never contacted.

> **Warning:** Enabling this flag lets hooks reach internal infrastructure on your network. Enable it only in trusted, managed settings — never in a repository you do not control.

**Example:**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:8080/hooks/pre-tool-use",
            "headers": {
              "Authorization": "Bearer ${HOOK_API_KEY}"
            },
            "allowedEnvVars": ["HOOK_API_KEY"],
            "timeout": 10,
            "name": "remote-security-check"
          }
        ]
      }
    ]
  }
}
```

**Example: External Judgment Service Adapter**

The `remote-security-check` config above expects `http://127.0.0.1:8080/hooks/pre-tool-use` to
already be running a service that speaks this contract (POST `{tool_name, tool_input, ...}` in,
`hookSpecificOutput.permissionDecision` out). Here is a minimal, stdlib-only adapter that fills
in that missing half, wired to one concrete judgment backend so the whole thing is runnable and
testable end to end rather than a stub. Only the `review()` function is backend-specific — swap
its body and request/response shape for whichever service you use; everything else (the server,
the fail-open handling, the hook response shape) stays the same regardless of backend.

_Disclosure: the backend used below, [invinoveritas](https://api.babyblueviper.com), is a
service the author is affiliated with — used here because it was the one that could be
verified end to end for this example, not an endorsement. Any HTTP service that returns a
JSON verdict works equally well; only `review()` needs to change._

_Data handling: with `matcher: "*"`, the full `tool_input` of **every** tool call is sent to
the judgment backend — treat that input as sensitive (it may contain file contents, paths, or
secrets). Narrow the matcher (e.g. to `run_shell_command`) if you only need to judge shell
commands._

```python
#!/usr/bin/env python3
# judgment_hook.py -- run: JUDGMENT_API_KEY=... python3 judgment_hook.py
import json, os, sys, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

JUDGMENT_API_KEY = os.environ["JUDGMENT_API_KEY"]
JUDGMENT_URL = os.environ.get("JUDGMENT_URL", "https://api.babyblueviper.com/review")

def review(tool_name, tool_input):
    """POST the call to the judgment backend and return its verdict. This is the
    one function to change for a different backend -- request/response shape
    below matches invinoveritas's /review; adapt both to your own backend's
    contract if you swap it out."""
    body = json.dumps({
        "artifact": json.dumps({"tool_name": tool_name, "tool_input": tool_input}),
        "artifact_type": "shell_command" if tool_name in ("run_shell_command", "shell") else "general",
        "context": f"qwen-code PreToolUse: {tool_name}",
    }).encode()
    req = urllib.request.Request(
        JUDGMENT_URL, data=body,
        headers={"Authorization": f"Bearer {JUDGMENT_API_KEY}", "Content-Type": "application/json"},
    )
    # Keep this below the HTTP hook's own timeout (10s in the config above), so a "deny"
    # verdict is always returned before the hook gives up and fails open on its own.
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.loads(resp.read())  # response includes a "verdict" field: "reject" denies, anything else allows

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        tool_name, tool_input = payload.get("tool_name", "unknown"), payload.get("tool_input", {})
        try:
            verdict = review(tool_name, tool_input)
            decision = "deny" if verdict.get("verdict") == "reject" else "allow"
            reason = verdict.get("summary", f"judgment verdict: {verdict.get('verdict')}")
        except Exception as e:
            decision, reason = "allow", "judgment backend unavailable, failing open"  # never block on a review-side outage
            print(f"judgment backend unavailable for {tool_name}, failing open: {e}", file=sys.stderr)
        out = {"continue": True, "decision": decision, "hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": decision, "permissionDecisionReason": reason,
        }}
        body = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass

if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8080), Handler).serve_forever()
```

Tested live end to end against the real production API above: a genuinely destructive input
(`{"tool_name": "run_shell_command", "tool_input": {"command": "rm -rf /important_data"}}`)
returned `permissionDecision: "deny"` with a real explanation; a benign one (`ls -la`) returned
`"allow"`. Fails open on any network/timeout/malformed-response issue from the judgment
backend, so an outage never blocks legitimate tool calls — same discipline the `command`-hook
examples above apply with their own exit codes.

### Function Hooks

Function hooks directly call registered JavaScript/TypeScript functions. They are used internally by the Skill system and are not currently exposed as a public API for end users.

**Note**: For most use cases, use **command hooks** or **HTTP hooks** instead, which can be configured in settings files.

### Prompt Hooks

Prompt hooks use an LLM to evaluate hook input and return a decision. This is useful for making intelligent decisions based on context, such as determining whether to allow or block an operation.

> **Data handling:** A prompt hook sends its event input to the configured model provider. When file-backed debug logging is enabled, the fully expanded prompt-hook request is also written to the session debug log. Treat hook input and debug logs as potentially sensitive.

**How it works:**

1. The hook input JSON is injected into your prompt using the `$ARGUMENTS` placeholder
2. The prompt is sent to an LLM (default: your current model)
3. The LLM returns a JSON response with the decision
4. Qwen Code processes the decision and continues or blocks execution accordingly

**Configuration:**

| Field           | Type       | Required | Description                                         |
| :-------------- | :--------- | :------- | :-------------------------------------------------- |
| `type`          | `"prompt"` | Yes      | Hook type                                           |
| `prompt`        | `string`   | Yes      | Prompt sent to LLM. Use `$ARGUMENTS` for hook input |
| `model`         | `string`   | No       | Model to use (defaults to your current model)       |
| `timeout`       | `number`   | No       | Timeout in seconds, default 30                      |
| `name`          | `string`   | No       | Hook name (for logging)                             |
| `description`   | `string`   | No       | Hook description                                    |
| `statusMessage` | `string`   | No       | Status message displayed during execution           |

**Response Format:**

The LLM must return JSON with the following structure:

```json
{
  "ok": true,
  "reason": "Explanation of the decision",
  "additionalContext": "Optional context to inject into the conversation"
}
```

| Field               | Description                                                                |
| :------------------ | :------------------------------------------------------------------------- |
| `ok`                | `true` to allow/continue, `false` to block/stop                            |
| `reason`            | Required when `ok` is `false`. Shown to the model to explain the block     |
| `additionalContext` | Optional. Additional context to inject into the conversation when allowing |

**Supported Events:**

Prompt hooks can be used with most hook events, including:

- `PreToolUse` - Evaluate whether to allow a tool call
- `PostToolUse` - Evaluate tool results and potentially inject context
- `Stop` - Determine whether to continue or stop
- `SubagentStop` - Evaluate subagent results
- `UserPromptSubmit` - Evaluate or enrich eligible model-bound prompts

**Example: Stop Hook**

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "You are evaluating whether Qwen Code should stop working. Context: $ARGUMENTS\n\nAnalyze the conversation and determine if:\n1. All user-requested tasks are complete\n2. Any errors need to be addressed\n3. Follow-up work is needed\n\nRespond with JSON: {\"ok\": true} to allow stopping, or {\"ok\": false, \"reason\": \"your explanation\"} to continue working.",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

When `ok` is `false`, Qwen Code will continue working and use the `reason` as context for the next response.

**Example: PreToolUse Hook**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "run_shell_command",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Evaluate this tool call for security concerns. Tool input: $ARGUMENTS\n\nCheck for:\n- Dangerous commands (rm -rf, curl | sh, etc.)\n- Unauthorized access attempts\n- Data exfiltration patterns\n\nRespond with {\"ok\": true} if safe, or {\"ok\": false, \"reason\": \"concern\"} if blocked.",
            "model": "sonnet",
            "timeout": 30,
            "name": "security-evaluator"
          }
        ]
      }
    ]
  }
}
```

## Hook Events

Hooks fire at specific points during a Qwen Code session. Different events support different matchers to filter trigger conditions.

| Event                 | Triggered When                                                         | Matcher Target                                                   |
| :-------------------- | :--------------------------------------------------------------------- | :--------------------------------------------------------------- |
| `PreToolUse`          | Before tool execution                                                  | Tool id (`write_file`, `read_file`, `run_shell_command`, etc.)   |
| `PostToolUse`         | After successful tool execution                                        | Tool id                                                          |
| `PostToolUseFailure`  | After tool execution fails                                             | Tool id                                                          |
| `PostToolBatch`       | Once after every tool call in a batch has resolved                     | None (always fires)                                              |
| `UserPromptSubmit`    | Before supported model invocations                                     | None                                                             |
| `UserPromptExpansion` | After a slash command expands into a prompt, before the prompt is sent | Command name, without the leading `/`                            |
| `SessionStart`        | When session starts or resumes                                         | Source (`startup`, `resume`, `clear`, `compact`)                 |
| `SessionEnd`          | When session ends                                                      | Reason (`clear`, `logout`, `prompt_input_exit`, etc.)            |
| `SessionDelete`       | After an explicitly selected session is deleted                        | None                                                             |
| `MessageDisplay`      | Repeatedly, as the reply streams                                       | None (always fires)                                              |
| `Stop`                | Before the turn ends                                                   | None (always fires)                                              |
| `StopFailure`         | When an API error or loop detection ends the turn, instead of `Stop`   | Error type (`rate_limit`, `server_error`, `loop_detected`, etc.) |
| `SubagentStart`       | When subagent starts                                                   | Agent type (`Bash`, `Explorer`, `Plan`, etc.)                    |
| `SubagentStop`        | When subagent stops                                                    | Agent type                                                       |
| `PreCompact`          | Before conversation compaction                                         | Trigger (`manual`, `auto`)                                       |
| `PostCompact`         | After conversation compaction succeeds                                 | Trigger (`manual`, `auto`)                                       |
| `Notification`        | When notifications are sent                                            | Type (`permission_prompt`, `idle_prompt`, `auth_success`)        |
| `PermissionRequest`   | When permission dialog is shown                                        | Tool id                                                          |
| `PermissionDenied`    | When AUTO-mode classification denies a tool call                       | Tool id                                                          |
| `TodoCreated`         | When a new todo item is created                                        | None (always fires)                                              |
| `TodoCompleted`       | When a todo item is marked as completed                                | None (always fires)                                              |
| `InstructionsLoaded`  | When a context file such as `QWEN.md`, or a file it imports, is loaded | File path of the loaded file                                     |

### Matcher Patterns

`matcher` is a regular expression used to filter trigger conditions.

| Event Type          | Events                                                                                     | Matcher Support | Matcher Target                                                                                                                                         |
| :------------------ | :----------------------------------------------------------------------------------------- | :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool Events         | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` | ✅ Regex        | Tool id: `write_file`, `read_file`, `run_shell_command`, etc.                                                                                          |
| Tool Events         | `PostToolBatch`                                                                            | ❌ No           | N/A                                                                                                                                                    |
| Subagent Events     | `SubagentStart`, `SubagentStop`                                                            | ✅ Regex        | Agent type: `Bash`, `Explorer`, etc.                                                                                                                   |
| Session Events      | `SessionStart`                                                                             | ✅ Regex        | Source: `startup`, `resume`, `clear`, `compact`                                                                                                        |
| Session Events      | `SessionEnd`                                                                               | ✅ Regex        | Reason: `clear`, `logout`, `prompt_input_exit`, etc.                                                                                                   |
| Session Events      | `SessionDelete`                                                                            | ❌ No           | N/A                                                                                                                                                    |
| Notification Events | `Notification`                                                                             | ✅ Regex        | Type: `permission_prompt`, `idle_prompt`, `auth_success`                                                                                               |
| Compact Events      | `PreCompact`, `PostCompact`                                                                | ✅ Regex        | Trigger: `manual`, `auto`                                                                                                                              |
| Todo Events         | `TodoCreated`, `TodoCompleted`                                                             | ❌ No           | N/A                                                                                                                                                    |
| Prompt Events       | `UserPromptSubmit`                                                                         | ❌ No           | N/A                                                                                                                                                    |
| Prompt Events       | `UserPromptExpansion`                                                                      | ✅ Regex        | Command name without the leading `/`, for example `init`                                                                                               |
| Stop Events         | `Stop`                                                                                     | ❌ No           | N/A                                                                                                                                                    |
| Stop Events         | `StopFailure`                                                                              | ✅ Regex        | Error type: `rate_limit`, `authentication_failed`, `billing_error`, `invalid_request`, `server_error`, `max_output_tokens`, `loop_detected`, `unknown` |
| Message Display     | `MessageDisplay`                                                                           | ❌ No           | N/A                                                                                                                                                    |
| Instruction Events  | `InstructionsLoaded`                                                                       | ✅ Regex        | File path of the loaded file                                                                                                                           |

**Matcher Syntax:**

- Empty string `""`, `"*"` or `".*"` matches all events of that type
- A matcher is first compared exactly. In a `|`-separated list such as `permission_prompt | idle_prompt`, the matcher matches when any entry, ignoring spaces around it, is `*`, `.*`, or exactly the value, unless the whole matcher starts with `^` or `(`, in which case it is only a regular expression. Only a `|` outside `[...]` and groups, and not escaped with a backslash, separates entries: the pipes in `notes\|todo\.md`, `foo[ |]bar` and `a(b | c)` are part of the regular expression, and the spaces around them are kept. List entries are never read as regular expressions on their own
- Otherwise the matcher is an unanchored regular expression (e.g., `^run_shell_command$`, `read_.*`, `(write_file|edit)`). For a list that does not start with `^` or `(`, the expression is built from the trimmed, non-empty entries (an escaped space at an entry's edge, as in `\.env\ |\.pem`, is kept), so a stray `|` as in `read_(file|edit)|` is ignored and never makes the matcher match everything, and a matcher of only `|` matches nothing. A matcher that starts with `^` or `(` is compiled exactly as written, so a trailing `|` there, as in `^write_file|`, does make it match everything. Because the expression is unanchored, `read` also matches `read_file` and `edit` also matches `notebook_edit`. Add `^` and `$` to match a whole value, and anchor exclusions as well: `^(?!write_file).*$` excludes `write_file`, while unanchored `(?!write_file).*` still matches it
- The same rules apply to every event that supports a matcher, and to hooks registered by skills
- Tool hooks receive the runtime tool id in `tool_name` (for example, `write_file`). Built-in display names such as `WriteFile` and `ReadFile` are also accepted as matcher aliases for compatibility, and so are the tool names permission rules accept, including Claude Code's `Bash`, `Read` and `Write`, so a matcher copied from a Claude Code config such as `"Bash"` or `"Write|Edit"` works unchanged. New configs should still prefer runtime ids. Aliases are only compared exactly, so anchor runtime ids (`^write_file$`), not display names. Each alias names exactly one tool: unlike a permission rule, a `Read` matcher does not also cover `grep_search` or `glob`, and a `Bash` matcher does not cover `monitor`.

**Examples:**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^run_shell_command$",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'bash check' >> /tmp/hooks.log"
          }
        ]
      },
      {
        "matcher": "write_.*",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'write check' >> /tmp/hooks.log"
          }
        ]
      },
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "echo 'all tools' >> /tmp/hooks.log" }
        ]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "^(Bash|Explorer)$",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'subagent check' >> /tmp/hooks.log"
          }
        ]
      }
    ]
  }
}
```

## Input/Output Rules

### Hook Input Structure

All hook executors receive the standardized event input. The delivery boundary depends on the executor:

| Hook type  | Input recipient                                                 |
| :--------- | :-------------------------------------------------------------- |
| `command`  | Child process through JSON on `stdin`                           |
| `http`     | Configured endpoint through a JSON `POST` body                  |
| `function` | Trusted in-process callback                                     |
| `prompt`   | Configured model provider after the input replaces `$ARGUMENTS` |

Function hooks are trusted code running in the Qwen process. They receive an in-process object, so fields must not be treated as immutable against a function hook.

Qwen does not control whether a hook process, endpoint, callback, or model provider retains or forwards its input. Review each configured executor's data-handling policy.

**Common Fields:**

```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "hook_event_name": "string",
  "timestamp": "string",
  "permission_mode": "default | plan | auto_edit | auto | yolo",
  "agent_id": "string (only when the event fires inside a subagent)",
  "prompt_id": "string (when the event belongs to a model turn)",
  "source_type": "string (only when the session has a declared source)",
  "source_id": "string (only when the session source has an id)"
}
```

Event-specific fields are added based on the hook type. `permission_mode` is the session's approval mode unless the event reports the mode that applied to it, as tool and subagent events do. `agent_id` is present only when the event fires inside a subagent; `agent_type` is reported on `SessionStart`, `SubagentStart` and `SubagentStop`. `source_type` and `source_id` appear only in ACP sessions whose client declared a session source when creating the session.

Hook input is a forward-extensible JSON contract: new optional fields can be added to existing events. Consumers should ignore unknown fields. A strict decoder that rejects unknown properties must be updated to explicitly allow each new optional field before upgrading Qwen Code. For security-sensitive hooks, a decoder failure can change fail-open or fail-closed behavior, so administrators must validate the upgraded payload against the deployed hook before rollout.

### Hook Output Structure

Hook output is returned via `stdout` (command) or HTTP response body (http) as JSON.

**Exit Code Behavior (Command Hooks):**

| Exit Code | Behavior                                                                                                                                                                                                                                                                                                                                                                       |
| :-------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | Success. A JSON object in `stdout` controls behavior. Any other `stdout`, including bare JSON values such as `42`, is plain text: it is added to the model context on `SessionStart`, `UserPromptSubmit` and `UserPromptExpansion`, and kept as a system message on other events. Output that looks like a JSON object but does not parse is never added to the model context. |
| `2`       | **Blocking error**. Ignores `stdout`, passes `stderr` as error feedback to the model.                                                                                                                                                                                                                                                                                          |
| Other     | Non-blocking error. `stderr` only shown in debug mode, execution continues.                                                                                                                                                                                                                                                                                                    |

Adding plain text to the model context applies only to a command hook's `stdout`. An HTTP hook's response body is read as JSON only when its `Content-Type` is `application/json`; any other non-empty body becomes a `systemMessage` on every event. An HTTP hook that adds context must return JSON with `hookSpecificOutput.additionalContext`.

**Output Structure:**

Hook output supports three categories of fields:

1. **Common Fields**: `continue`, `stopReason`, `suppressOutput`, `systemMessage`
2. **Top-level Decision**: `decision`, `reason` (used by some events)
3. **Event-specific Control**: `hookSpecificOutput` (must include `hookEventName`)

```json
{
  "continue": true,
  "decision": "allow",
  "reason": "Operation approved",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "Additional context information"
  }
}
```

### Individual Hook Event Details

#### PreToolUse

**Purpose**: Executed before a tool is used to allow for permission checks, input validation, or context injection.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | auto | yolo",
  "tool_name": "name of the tool being executed",
  "tool_input": "object containing the tool's input parameters",
  "tool_use_id": "unique identifier for this tool use instance (internal format, e.g., toolu_xxx)",
  "tool_call_id": "original API call ID from the LLM provider (e.g., call_xxx for OpenAI/Qwen) (optional)"
}
```

**Output Options**:

- `hookSpecificOutput.permissionDecision`: "allow", "deny", or "ask" (REQUIRED)
- `hookSpecificOutput.permissionDecisionReason`: explanation for the decision (REQUIRED)
- `hookSpecificOutput.updatedInput`: modified tool input parameters to use instead of original
- `hookSpecificOutput.additionalContext`: additional context information

The `permissionDecision` value controls whether the tool runs:

- `"allow"` — run the tool without the usual approval prompt.
- `"deny"` — block the tool; it does not execute and an error is returned to the model.
- `"ask"` — pause and ask the user to confirm the tool call in the TUI before it runs. Confirming runs the tool once; declining cancels it. In contexts that cannot prompt for confirmation — headless (`--prompt`) runs and background subagents — `"ask"` falls back to `"deny"`.

For `"ask"`, the TUI displays `permissionDecisionReason` as literal text rather than interpreting inline Markdown. This keeps formatting markers and link targets visible to the user.

**Note**: While standard hook output fields like `decision` and `reason` are technically supported by the underlying class, the official interface expects the `hookSpecificOutput` with `permissionDecision` and `permissionDecisionReason`.

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Security policy blocks database writes",
    "additionalContext": "Current environment: production. Proceed with caution."
  }
}
```

#### PostToolUse

**Purpose**: Executed after a tool completes successfully to process results, log outcomes, or inject additional context.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | auto | yolo",
  "tool_name": "name of the tool that was executed",
  "tool_input": "object containing the tool's input parameters",
  "tool_response": "object containing the tool's response",
  "tool_use_id": "unique identifier for this tool use instance (internal format, e.g., toolu_xxx)",
  "tool_call_id": "original API call ID from the LLM provider (e.g., call_xxx for OpenAI/Qwen) (optional)",
  "duration_ms": "tool execution time in milliseconds, excluding approval (optional)"
}
```

**Output Options**:

- `decision`: "allow", "deny", "block" (defaults to "allow" if not specified)
- `reason`: reason for the decision
- `hookSpecificOutput.additionalContext`: additional information to be included

**Example Output**:

```json
{
  "decision": "allow",
  "reason": "Tool executed successfully",
  "hookSpecificOutput": {
    "additionalContext": "File modification recorded in audit log"
  }
}
```

#### PostToolUseFailure

**Purpose**: Executed when a tool execution fails to handle errors, send alerts, or record failures.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | auto | yolo",
  "tool_use_id": "unique identifier for the tool use (internal format, e.g., toolu_xxx)",
  "tool_call_id": "original API call ID from the LLM provider (e.g., call_xxx for OpenAI/Qwen) (optional)",
  "tool_name": "name of the tool that failed",
  "tool_input": "object containing the tool's input parameters",
  "error": "error message describing the failure",
  "is_interrupt": "boolean indicating if failure was due to user interruption (optional)",
  "duration_ms": "tool execution time in milliseconds when execution had started (optional)"
}
```

**Output Options**:

- `hookSpecificOutput.additionalContext`: error handling information
- Standard hook output fields

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Error: File not found. Failure logged in monitoring system."
  }
}
```

#### PostToolBatch

**Purpose**: Runs once after all tool calls in a batch have resolved, before their results are returned to the model. Use it to review the batch as a whole, add context to it, or stop it.

**Matcher**: None. `PostToolBatch` always fires, and a `matcher` on it is ignored.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | auto | yolo",
  "tool_calls": [
    {
      "tool_name": "runtime tool id, for example run_shell_command",
      "tool_input": "object containing the tool's input parameters",
      "tool_use_id": "the call id from the model's request",
      "tool_call_id": "the same call id (optional)",
      "status": "success | error | cancelled",
      "tool_response": "object with response_parts, result_display, error, error_type, execution_status, content_length and, when present, vision_bridge_notice (optional)"
    }
  ]
}
```

**Output Options**:

- `hookSpecificOutput.additionalContext`: appended to the result of the last call in the batch, after a blank line. `<` and `>` are escaped.
- `decision`: `"block"` or `"deny"` stops the batch, and so does `continue: false` or exit code 2. The last call's result is replaced by an error that carries `stopReason`, or `reason` when there is no `stopReason`. The other results are kept, and `additionalContext` is still appended.
- `stopReason` / `reason`: the text of that error.

If the hooks fail, or do not finish within 15 seconds, the batch continues with its results unchanged.

**Example Output**:

```json
{
  "decision": "block",
  "reason": "This batch edited files outside the allowed directory",
  "hookSpecificOutput": {
    "hookEventName": "PostToolBatch",
    "additionalContext": "Ask the user before retrying these edits."
  }
}
```

#### UserPromptSubmit

**Purpose**: Executed before supported model invocations to validate, block, or enrich their input. On the core/headless path, the event currently covers `UserQuery`, `ToolResult`, and `Hook` sends, while `Retry`, `Steer`, `Cron`, `Notification`, and `Teammate` sends are skipped. It can therefore occur on continuation paths, and `prompt` must not be assumed to be raw user input. The ACP session path has its own invocation policy: retries and newly dispatched background tasks can still invoke legacy hooks; continue, restored-question, and runtime-goal turns do not.

**Event-specific fields**:

```json
{
  "prompt": "legacy prompt for this invocation; semantics depend on the execution path",
  "submitted_prompt": "optional user text captured at a supported submission boundary"
}
```

`submitted_prompt` is optional. It is present on supported interactive TUI submissions and first-turn headless `UserQuery` sends. On the ACP session path used by ACP clients, `serve`, and daemon hosts, a fresh turn must carry an explicit submission declaration. Missing, non-string, empty, or whitespace-only declarations omit the field; the value is never reconstructed from `prompt` or a display label. Retries, continuations, and channel-classified turns omit it. The channel exclusion includes both automated events and human messages relayed through channel adapters.

Web Shell provides the original composer text at its submission boundary. Realtime voice handoffs do not declare provenance because their request text comes from model-generated tool arguments. Other ACP/daemon SDK clients can opt in per request with `_meta: { "qwen.submittedPrompt": "original submitted text" }`, captured before resource or model-only expansion. Existing clients without this declaration continue running legacy hooks but do not trigger provenance-gated Auto Recall. Do not add the declaration globally to an SDK transport: scheduled tasks, Live task runs, sub-session spawns, model-authored cross-session messages, and promoted mid-turn messages must not acquire it automatically. The private `qwen.daemon.submittedPrompt` key is reserved for the daemon-to-child hop and is stripped from external callers. These declarations are caller-supplied provenance, not proof of human authorship or authorization.

On the ACP path, the initial legacy `prompt` is the request's text blocks joined with a space before resource, attachment, slash-command, or model-only expansion. It does not expose the complete expanded model input. `submitted_prompt` can equal that text, but comes only from the explicit declaration and preserves its original whitespace. On the core/headless path, legacy `prompt` represents the current model-bound text for the hook invocation. Neither field is a complete DLP inspection surface.

The following composer rules apply to the interactive TUI, not to ACP clients. Deferred input can retain the field when its provenance remains complete. A combined batch retains provenance only when every constituent item has it; edited, partially known, or otherwise ambiguous input omits the field. Prompt, command, and shell-history navigation or selected search matches, cross-restart stash restores, and conversation rewind restores also omit it because those paths can surface model-bound text without its original provenance. Consumers that require user-submitted text should treat absence as unavailable rather than falling back to `prompt`.

After restored or provenance-unavailable model-bound input is cleared or submitted, the composer also clears its undo and redo history. This prevents undo from restoring expanded text after its marker or sidecar has been consumed.

Large-paste placeholders remain compact in `submitted_prompt`; the expanded pasted content appears only in `prompt`. On that TUI path, consumers should treat the field as a text projection rather than a byte-for-byte record of clipboard input. ACP clients have no equivalent built-in Vim, paste-placeholder, history, or rewind provenance tracking; they own whether restored or edited text retains a valid submission declaration.

Any non-empty input present while Vim mode is enabled omits `submitted_prompt`, including after Vim is disabled, because Vim registers do not carry provenance in this version. This conservative rule also covers drafts entered before enabling Vim. Clearing the composer starts a new eligible input.

This field is provenance, not authentication, tenant identity, authorization, or DLP. It is caller-supplied data. Every executor configured for this event receives it; in particular, HTTP hooks send it to their endpoint and prompt hooks send it to their model provider.

When both fields are present, prompt-hook payloads contain overlapping text and can consume additional model input tokens. There is no per-hook field suppression in this version.

Sequential UserPromptSubmit hooks can append `additionalContext` to `prompt`; `submitted_prompt` continues to represent the captured submission. Function hooks are trusted same-process code and are not constrained by an immutability guarantee.

When the final hook output contains non-empty `additionalContext`, Qwen first
sanitizes the value and then sends it to the model as a separate text part:

```xml
<qwen:user-prompt-submit-context>
sanitized hook context
</qwen:user-prompt-submit-context>
```

The tag tells the model and transcript consumers that the part came from a
configured hook rather than from the user prompt. It is a provenance marker,
not authentication, authorization, or a general trust boundary.

For a `UserQuery` with this added context, the session JSONL record preserves
the model-bound parts, including the tagged part, and adds the following
`systemPayload`:

```json
{
  "displayText": "pre-hook display projection",
  "hookContext": "sanitized hook context"
}
```

This two-field payload is written only for this kind of user-prompt record.
`hookContext` intentionally duplicates the tagged part so offline and
third-party consumers can identify its provenance without parsing model text.
`displayText` is the pre-hook display projection and never includes the hook
context. On the core/headless path it is the submitted projection when available, otherwise the expanded pre-hook prompt. ACP records the trusted display projection or raw request text before expansion when a projection, attachment references, or input annotations require a payload; otherwise it records the user message without `systemPayload` or `displayText`.

Transcript display consumers treat `displayText` as this user-prompt projection
when `systemPayload.hookContext` is a string. For compatibility with released
`displayText`-only user-prompt records, a complete tagged context in the final
part after at least one other part is equivalent pairing evidence. Notification,
cron, and mid-turn records can also have `displayText`, but those values are
compact display labels and must not be substituted for their model-bound text
without that evidence.
Legacy bare-context records keep their model-bound display behavior because the
context cannot be separated reliably. For metadata-free records that use the
current tagged shape, compatibility consumers may remove the same complete
final tagged part; they must not infer that arbitrary tag-like user text is hook
provenance.

Sensitive prompt telemetry attributes, when enabled, and managed auto-memory
recall both use the pre-hook prompt. They do not include
`UserPromptSubmit`-added context.

**Output Options**:

- `decision`: "allow", "deny", "block", or "ask"
- `reason`: human-readable explanation for the decision
- `hookSpecificOutput.additionalContext`: additional context to append to the prompt (optional)

When sent to the model, injected `additionalContext` is appended as its own message part wrapped in a reserved `<qwen:user-prompt-submit-context>...</qwen:user-prompt-submit-context>` tag, so it stays distinguishable from user-authored text in model history and session transcripts. Angle brackets in hook output are escaped before wrapping, so hook content cannot close or forge the tag. The session transcript also records the user's original prompt text separately; the interactive TUI and the ACP/export transcript-replay path display that original text rather than the injected context.

**Note**: Since UserPromptSubmitOutput extends HookOutput, all standard fields are available but only additionalContext in hookSpecificOutput is specifically defined for this event.

**Example Output**:

```json
{
  "decision": "allow",
  "reason": "Prompt reviewed and approved",
  "hookSpecificOutput": {
    "additionalContext": "Remember to follow company coding standards."
  }
}
```

#### UserPromptExpansion

**Purpose**: Runs when a slash command expands into a prompt for the model, after the expansion and before the prompt is sent. This covers commands that submit a prompt, such as custom commands, skills, MCP prompts and built-in commands like `/init`. Commands that only act locally do not fire it. It fires in the interactive UI, headless runs and ACP sessions, and when the model runs a model-invocable command.

**Matcher**: Matches against `command_name`. For example, `"matcher": "^init$"` fires only for `/init`.

**Event-specific fields**:

```json
{
  "command_name": "slash command name without the leading /",
  "command_args": "argument text after the command name",
  "prompt": "the expanded prompt, with non-text parts rendered as text"
}
```

When a headless or ACP message invokes several skills at once, `command_name` is their names joined by spaces and `command_args` is the remaining text.

**Output Options**:

- `decision`: `"block"` or `"deny"` stops the expanded prompt from being sent, and so does `continue: false` or exit code 2. The user sees `UserPromptExpansion blocked: <reason>`; for a model-invoked command, that message is returned as the error.
- `reason` / `stopReason`: the text shown in that message.
- `hookSpecificOutput.additionalContext`: appended to the expanded prompt after a blank line. `&`, `<` and `>` are escaped, and the result is cut to 10,000 characters.

A command hook that exits 0 with plain-text `stdout` has that text treated as `additionalContext` (see [Exit Code Behavior](#hook-output-structure)).

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptExpansion",
    "additionalContext": "Follow the repository's CONTRIBUTING.md when generating QWEN.md."
  }
}
```

#### SessionStart

**Purpose**: Executed when a new session starts to perform initialization tasks.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | auto | yolo",
  "source": "startup | resume | clear | compact",
  "model": "the model being used",
  "agent_type": "the type of agent if applicable (optional)"
}
```

**Output Options**:

- `hookSpecificOutput.additionalContext`: context to be available in the session
- Standard hook output fields

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Session started with security policies enabled."
  }
}
```

#### SessionEnd

**Purpose**: Executed when a session ends to perform cleanup tasks.

**Event-specific fields**:

```json
{
  "reason": "clear | logout | prompt_input_exit | bypass_permissions_disabled | other"
}
```

**Output Options**:

- Standard hook output fields (typically not used for blocking)

#### SessionDelete

**Purpose**: Runs after an explicitly selected session has been permanently deleted. This event is fire-and-forget: output and failures cannot undo the deletion.

**Event-specific fields**:

```json
{
  "deleted_session_id": "the session that was deleted"
}
```

The hook uses the deleting runtime's normal session fields (`session_id`, `transcript_path`, and `cwd`); over ACP, `transcript_path` is empty because the deleting runtime has no transcript of its own. `SessionDelete` currently fires for the interactive `/delete` flow and ACP's explicit `deleteSession` method; daemon REST batch deletion and internal cleanup do not emit it. A command hook is left to finish if Qwen exits after dispatch; its stdout and stderr are ignored and remain independent of Qwen's pipes.

#### MessageDisplay

**Purpose**: Fires repeatedly as the assistant's reply streams — before `Stop`, which fires once at the end of the turn. Useful for live narration, incremental logging, or any consumer that wants to react to the reply as it's written rather than after the fact. This is a **fire-and-forget** event - hook output and exit codes are ignored.

**Event-specific fields**:

```json
{
  "message_id": "stable id for the whole streamed message",
  "displayed_text": "the CUMULATIVE text streamed so far for this message (not a delta)",
  "is_final": "true on the last firing for this message, false otherwise"
}
```

`displayed_text` is cumulative rather than a delta so hook scripts never need to reassemble chunks themselves — each firing carries the full text so far. Firing is debounced (at most every ~200ms) except for the final firing (`is_final: true`), which always fires once the message ends, so the reply's tail is never dropped waiting on the debounce window.

**Delivery semantics** — what a hook script can rely on:

- **Slow hooks see fewer, newer payloads.** At most one mid-stream hook execution per message is in flight at a time; while one runs, newer debounced payloads _replace_ the queued one rather than piling up behind it. A hook slower than the debounce window therefore skips intermediate snapshots — lossless, since each payload carries the full cumulative text.
- **`is_final` is never queued behind a stale delivery.** The final payload is dispatched the moment the message ends — alongside a still-running mid-stream execution if there is one (the one exception to the one-at-a-time rule, justified the same way: the final cumulative text strictly supersedes whatever that execution is processing). Your hook always receives the `is_final` payload, and receives it before the `Stop` hook fires. One consequence for stateful hooks: when the final execution overlaps a superseded mid-stream one, their _completion_ order is unspecified — the stale execution may finish after the final one (even after `Stop`). Treat `is_final` as terminal per `message_id` and let the cumulative text win, rather than assuming the last execution to finish carries the newest state.
- **The turn waits for `is_final` delivery to complete — but not forever.** The turn's end (and the `Stop` hook, when it fires) waits up to 5 seconds for the final delivery to finish. A hook that completes within that budget keeps the strongest guarantee: a headless run (`qwen -p ...`) exits only after the hook finished, and the `is_final` execution completes before `Stop` starts. A slower hook still receives `is_final` first — only the wait for its completion is bounded: in the terminal UI or an ACP session the execution simply finishes in the background, while a headless run exits without waiting. The hook process is not killed on exit; it is left to finish on its own, so a script chaining `qwen -p … && next-step` can observe `next-step` starting while a slow hook is still running. Hitting this timeout prints a warning on stderr.
- **Cancellation behaviour depends on timing.** A turn cancelled _before `is_final` dispatches_ fires no `is_final` — the message is treated as abandoned, and a consumer that buffers until `is_final` should treat cancellation-silence as its flush/discard signal (e.g. a timeout fallback). The criterion is the abort signal's state at the moment the turn ends, not whether every chunk had already streamed — an abort landing in the brief gap before that check can still suppress `is_final` for a message whose text had, in practice, finished arriving. Cancelling _after `is_final` has dispatched_ (during the drain wait) is different: the still-running hook execution may be terminated mid-flight (SIGTERM), but the payload itself has already been delivered.
- **`displayed_text` is provisional until `is_final`.** It reflects what has streamed so far; treat intermediate payloads as display state, not as authoritative final content.
- **A tool-using turn produces multiple messages.** Each model call gets its own `message_id` with its own `is_final: true` firing: the text before a tool call is one message, the continuation after the tool result is another. Model calls that produce no displayed text (tool-call-only) fire nothing.

**Note**: Fires in the terminal UI, headless (`-p`), and ACP (IDE/editor/`qwen serve`) sessions, with the same payload contract on every surface.

#### Stop

**Purpose**: Executed before Qwen concludes its response to provide final feedback or summaries.

**Event-specific fields**:

```json
{
  "stop_hook_active": "true when this turn is continuing because a stop hook blocked the previous stop check (still true after tool calls made during that continuation); false on the first check and again once the stop is allowed, the blocking cap is reached, the user steers or sends new input, or a new turn, retry or goal turn starts",
  "last_assistant_message": "the last message from the assistant",
  "context_usage": "ratio of context window used (may exceed 1 when tokens exceed window; optional)",
  "context_limit": "context window size in tokens (optional)",
  "input_tokens": "prompt token count (may include output tokens depending on provider; optional)",
  "background_tasks": "array of background tasks, each with id, status, agent_type, started_at and optional description",
  "crons": "array of scheduled jobs, each with id, schedule, prompt, recurring, enabled and optional next_run and last_run"
}
```

The `context_usage`, `context_limit`, and `input_tokens` fields allow hook scripts to observe context usage and implement custom compact strategies — for example, a script that prints a reminder to run `/compact` when usage exceeds a custom threshold.

**Output Options**:

- `decision`: "allow", "deny", "block", or "ask"
- `reason`: human-readable explanation for the decision
- `stopReason`: feedback to include in the stop response
- `continue`: set to false to stop execution
- `hookSpecificOutput.additionalContext`: additional context information

**Note**: Since StopOutput extends HookOutput, all standard fields are available but the stopReason field is particularly relevant for this event.

**Blocking cap**: consecutive blocking decisions are counted per prompt and keep counting across tool round trips, so a hook that blocks on every check ends the turn after `stopHookBlockingCap` blocks (default 8; `QWEN_CODE_STOP_HOOK_BLOCK_CAP` overrides it for one run). The count and `stop_hook_active` share the same record: both restart when the stop is allowed, when you steer or send new input, when a turn is retried, when a goal turn starts, and when the turn ends abnormally. In non-interactive text mode, Stop hook messages and cap warnings are written to stderr; JSON output is unchanged.

**Example Output**:

```json
{
  "decision": "block",
  "reason": "Must be provided when Qwen Code is blocked from stopping"
}
```

#### StopFailure

**Purpose**: Runs instead of `Stop` when an API error or loop detection ends the turn. API errors fire it in the interactive UI and in ACP sessions, but not in headless (`-p`) runs. Loop detection fires it in the interactive UI and in headless runs, but not in ACP sessions. This is a **fire-and-forget** event: Qwen does not wait for the hooks, and their output and exit codes are ignored.

**Event-specific fields**:

```json
{
  "error": "rate_limit | authentication_failed | billing_error | invalid_request | server_error | max_output_tokens | loop_detected | unknown",
  "error_details": "the error message, or the loop type for loop_detected (optional)",
  "last_assistant_message": "optional; the interactive UI currently sets it to the formatted error text"
}
```

For API errors, `error` is derived from the HTTP status and the error message: status 429 or "rate limit" gives `rate_limit`; 401 or "unauthorized" gives `authentication_failed`; 402, 403, "billing" or "quota" gives `billing_error`; 400 or "invalid" gives `invalid_request`; any other status of 500 or above gives `server_error`; "max_tokens" or "token limit" gives `max_output_tokens`; anything else is `unknown`. The checks run in that order.

**Matcher**: Matches against the `error` field. For example, `"matcher": "rate_limit"` will only trigger for rate limit errors.

**Output Options**:

- **None** - StopFailure is fire-and-forget. All hook output, errors and exit codes are discarded.

**Exit Code Handling**:

| Exit Code | Behavior                  |
| --------- | ------------------------- |
| Any       | Ignored (fire-and-forget) |

**Example Configuration**:

```json
{
  "hooks": {
    "StopFailure": [
      {
        "matcher": "rate_limit",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/rate-limit-alert.sh",
            "name": "rate-limit-alerter"
          }
        ]
      }
    ]
  }
}
```

**Use Cases**:

- Rate limit monitoring and alerting
- Authentication failure logging
- Billing error notifications
- Error statistics collection

A command hook is left to finish if Qwen exits after dispatch; its stdout and stderr are ignored and remain independent of Qwen's pipes.

#### SubagentStart

**Purpose**: Executed when a subagent (like the Task tool) is started to set up context or permissions.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | auto | yolo",
  "agent_id": "identifier for the subagent",
  "agent_type": "type of agent (Bash, Explorer, Plan, Custom, etc.)"
}
```

**Output Options**:

- `hookSpecificOutput.additionalContext`: initial context for the subagent
- Standard hook output fields

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Subagent initialized with restricted permissions."
  }
}
```

#### SubagentStop

**Purpose**: Executed when a subagent finishes to perform finalization tasks.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | auto | yolo",
  "stop_hook_active": "false on the first stop check; true when the subagent is continuing because a SubagentStop hook blocked its previous stop",
  "agent_id": "identifier for the subagent",
  "agent_type": "type of agent",
  "agent_transcript_path": "path to the subagent's transcript",
  "last_assistant_message": "the last message from the subagent",
  "background_tasks": "array of background tasks, same shape as in Stop",
  "crons": "array of scheduled jobs, same shape as in Stop"
}
```

**Output Options**:

- `decision`: "allow", "deny", "block", or "ask"
- `reason`: human-readable explanation for the decision

**Example Output**:

```json
{
  "decision": "block",
  "reason": "Must be provided when Qwen Code is blocked from stopping"
}
```

#### PreCompact

**Purpose**: Executed before conversation compaction to prepare or log the compaction.

**Event-specific fields**:

```json
{
  "trigger": "manual | auto",
  "custom_instructions": "custom instructions currently set"
}
```

**Output Options**:

- `hookSpecificOutput.additionalContext`: context to include before compaction
- Standard hook output fields

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Compacting conversation to maintain optimal context window."
  }
}
```

#### PostCompact

**Purpose**: Runs after a conversation compaction succeeds, to archive the summary or track usage. It does not fire when compaction fails. Qwen waits for the hooks to finish before continuing.

**Event-specific fields**:

```json
{
  "trigger": "manual | auto",
  "compact_summary": "the summary that replaced the compacted history, without its <analysis> block"
}
```

**Matcher**: Matches against the `trigger` field: `manual` when compaction was requested, for example with `/compress`, and `auto` when Qwen compacts on its own. For example, `"matcher": "manual"` fires only for requested compactions.

**Output Options**:

- **None** - PostCompact output is ignored. `decision`, `continue`, `additionalContext` and exit codes have no effect.

**Example Configuration**:

```json
{
  "hooks": {
    "PostCompact": [
      {
        "matcher": "manual",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/save-compact-summary.sh",
            "name": "save-summary"
          }
        ]
      }
    ]
  }
}
```

**Use Cases**:

- Summary archiving to files or databases
- Usage statistics tracking
- Context change monitoring
- Audit logging for compaction operations

#### Notification

**Purpose**: Executed when notifications are sent to customize or intercept them.

**Event-specific fields**:

```json
{
  "message": "notification message content",
  "title": "notification title (optional)",
  "notification_type": "permission_prompt | idle_prompt | auth_success"
}
```

> **Note**: `elicitation_dialog` type is defined but not currently implemented.

**Output Options**:

- `hookSpecificOutput.additionalContext`: additional information to include
- Standard hook output fields

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Notification processed by monitoring system."
  }
}
```

#### PermissionRequest

**Purpose**: Executed when permission dialogs are displayed to automate decisions or update permissions.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | auto | yolo",
  "tool_name": "name of the tool requesting permission",
  "tool_input": "object containing the tool's input parameters",
  "permission_suggestions": "array of suggested permissions (optional)"
}
```

**Output Options**:

- `hookSpecificOutput.decision`: structured object with permission decision details:
  - `behavior`: "allow" or "deny"
  - `updatedInput`: modified tool input (optional)
  - `updatedPermissions`: modified permissions (optional)
  - `message`: message to show to user (optional)
  - `interrupt`: whether to interrupt the workflow (optional)

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "decision": {
      "behavior": "allow",
      "message": "Permission granted based on security policy",
      "interrupt": false
    }
  }
}
```

#### PermissionDenied

**Purpose**: Runs when the AUTO-mode classifier blocks a tool call, including when repeated blocks make Qwen fall back to asking the user. It reports the denial and cannot approve or change the call. Qwen waits for the hooks before continuing; a hook failure is logged and does not change the outcome.

**Matcher**: Matches against the tool id, like the other tool events.

**Event-specific fields**:

```json
{
  "tool_name": "runtime tool id of the denied call",
  "tool_input": "object containing the tool's input parameters",
  "tool_use_id": "the call id",
  "tool_call_id": "the same call id (optional)",
  "reason": "classifier_blocked | classifier_unavailable"
}
```

`reason` is currently always `classifier_blocked`. `classifier_unavailable` is defined, but a call denied because the classifier returned no verdict does not fire this event.

**Output Options**:

- **None** - PermissionDenied output and exit codes are ignored.

#### TodoCreated

**Purpose**: Executed when a new todo item is created via the `todo_write` tool. Allows validation, logging, or blocking of todo creation.

Todo hooks run in two phases:

- `validation`: runs before persistence. Use this phase for validation only; returning `block` or `deny` prevents the write.
- `postWrite`: runs after persistence. Use this phase for side effects such as logging or syncing; `block` or `deny` is ignored in this phase.

**Event-specific fields**:

```json
{
  "todo_id": "unique identifier for the todo item",
  "todo_content": "content/description of the todo item",
  "todo_status": "pending | in_progress | completed",
  "all_todos": "array of all todo items in the current list",
  "phase": "validation | postWrite"
}
```

**Output Options**:

- `decision`: "allow", "block", or "deny"
- `reason`: human-readable explanation for the decision (required when blocking)

**Blocking Behavior**:

During the `validation` phase, when `decision` is `block` or `deny` (exit code 2), todo creation is prevented. The todo list remains unchanged, and the reason is provided as feedback to the model.

During the `postWrite` phase, the todo has already been persisted. Hooks may still return output, but `block` / `deny` does not undo the write and should not be used for validation.

**Example Output (Allow)**:

```json
{
  "decision": "allow",
  "reason": "Todo content validated successfully"
}
```

**Example Output (Block)**:

```json
{
  "decision": "block",
  "reason": "Todo content too short. Minimum 5 characters required."
}
```

**Example Hook Script**:

```bash
#!/bin/bash
# ~/.qwen/hooks/todo-validator.sh
# Validates todo content before creation

INPUT=$(cat)
CONTENT=$(echo "$INPUT" | jq -r '.todo_content')

# Check minimum length
if [ ${#CONTENT} -lt 5 ]; then
  echo '{"decision": "block", "reason": "Todo content must be at least 5 characters"}'
  exit 2
fi

# Block test-related todos
if [[ "$CONTENT" =~ "test" ]]; then
  echo '{"decision": "block", "reason": "Test todos are not allowed in production"}'
  exit 2
fi

echo '{"decision": "allow"}'
exit 0
```

**Example Configuration**:

```json
{
  "hooks": {
    "TodoCreated": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.qwen/hooks/todo-validator.sh",
            "name": "todo-validator",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

#### TodoCompleted

**Purpose**: Executed when a todo item is marked as completed. Allows validation, logging, or blocking of todo completion.

Todo hooks run in two phases:

- `validation`: runs before persistence. Use this phase for validation only; returning `block` or `deny` prevents the write.
- `postWrite`: runs after persistence. Use this phase for side effects such as logging or syncing; `block` or `deny` is ignored in this phase.

**Event-specific fields**:

```json
{
  "todo_id": "unique identifier for the todo item",
  "todo_content": "content/description of the todo item",
  "previous_status": "pending | in_progress (status before completion)",
  "all_todos": "array of all todo items in the current list",
  "phase": "validation | postWrite"
}
```

**Output Options**:

- `decision`: "allow", "block", or "deny"
- `reason`: human-readable explanation for the decision (required when blocking)

**Blocking Behavior**:

During the `validation` phase, when `decision` is `block` or `deny` (exit code 2), todo completion is prevented. The todo item remains in its previous status, and the reason is provided as feedback to the model.

During the `postWrite` phase, the todo has already been persisted. Hooks may still return output, but `block` / `deny` does not undo the write and should not be used for validation.

**Example Output (Allow)**:

```json
{
  "decision": "allow",
  "reason": "Todo completion approved"
}
```

**Example Output (Block)**:

```json
{
  "decision": "block",
  "reason": "Cannot complete this todo until dependent tasks are finished."
}
```

**Example Hook Script**:

```bash
#!/bin/bash
# ~/.qwen/hooks/todo-completion-validator.sh
# Validates todo completion conditions

INPUT=$(cat)
TODO_ID=$(echo "$INPUT" | jq -r '.todo_id')
ALL_TODOS=$(echo "$INPUT" | jq -r '.all_todos')

# Check if there are incomplete dependent todos (example logic)
INCOMPLETE_COUNT=$(echo "$ALL_TODOS" | jq '[.[] | select(.status != "completed")] | length')

if [ "$INCOMPLETE_COUNT" -gt 5 ]; then
  echo '{"decision": "block", "reason": "Too many incomplete todos. Complete other tasks first."}'
  exit 2
fi

echo '{"decision": "allow"}'
exit 0
```

**Example Configuration**:

```json
{
  "hooks": {
    "TodoCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.qwen/hooks/todo-completion-validator.sh",
            "name": "completion-validator",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

**Use Cases**:

- **Logging**: Track todo creation and completion for audit or analytics
- **Validation**: Enforce content quality standards (minimum length, required keywords)
- **Workflow Control**: Block completion until prerequisites are met
- **Integration**: Sync todos with external task management systems (Jira, Trello, etc.)

#### InstructionsLoaded

**Purpose**: Runs for each context file Qwen loads into the system prompt, such as `QWEN.md`, and for each file those files import. Use it to audit which instruction files a session uses. It is informational: it cannot stop or change loading.

It fires when the session starts, when context files are reloaded during the session, and for every file pulled in through an import, after the file has been read. Qwen waits for the hooks before it continues loading; a hook failure is logged and does not stop loading.

**Matcher**: Matches against `file_path`. For example, `"matcher": "QWEN\\.local\\.md$"` fires only for local context files.

**Event-specific fields**:

```json
{
  "file_path": "path of the loaded file",
  "memory_type": "user | project | local | extension",
  "load_reason": "session_start | include | refresh",
  "trigger_file_path": "for include: the context file whose loading pulled this file in (optional)",
  "parent_file_path": "for include: the file that contains the import (optional)"
}
```

`load_reason` is `session_start` for the initial load, `refresh` when context files are reloaded, and `include` for a file reached through an import.

`memory_type` is `extension` for an extension's context files and files in its directory, `user` for files in the global `.qwen` directory or directly in your home directory, `local` for `.qwen/QWEN.local.md` at the project root, and `project` for any other file. An imported file has the same `memory_type` as the context file that imported it.

**Output Options**:

- **None** - InstructionsLoaded output and exit codes are ignored.

## Hook Configuration

Hooks are configured in Qwen Code settings, typically in `.qwen/settings.json` or user configuration files. Hooks in the system settings files (System and SystemDefaults) load with the source System and, like user hooks, regardless of folder trust. Within one event, sequential hooks from settings and extensions run in this order: Project, User, System, Extension.

> [!NOTE]
> A hook must include a name field to be enabled or disabled individually at runtime. Hooks without a name will always execute when their event and matcher conditions are met.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^run_shell_command$",
        "sequential": false,
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/security-check.sh",
            "name": "security-check",
            "description": "Run security checks before tool execution",
            "timeout": 30
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Session started'",
            "name": "session-init"
          }
        ]
      }
    ]
  }
}
```

## Hook Execution

### Parallel vs Sequential Execution

- By default, hooks execute in parallel for better performance
- Use `sequential: true` in hook definition to enforce order-dependent execution
- Sequential hooks can modify input for subsequent hooks in the chain

### Async Hooks

Only `command` type supports asynchronous execution. Setting `"async": true` runs the hook in the background without blocking the main flow.

Async hooks are scoped to the Qwen process. On POSIX, Qwen reclaims a still-running async hook process tree when it exits, except for event types whose sections explicitly guarantee fire-and-forget completion after exit. Windows cannot reconstruct a descendant tree after its root exits, so full parent-exit reclamation there requires a Job Object or descendant tracking.

**Features:**

- Cannot return decision control (the event continues as soon as the hook starts)
- Output is not delivered yet: `systemMessage`, `additionalContext` and plain `stdout` from an async hook are neither shown to the user nor added to the model context. The debug log records only that the hook started, completed or failed. Delivering this output is planned.
- Suitable for side effects such as auditing, logging and background tests that write their results somewhere you can read them
- Occupies one of 10 concurrent async hook slots until it finishes or reaches its `timeout` (60 seconds by default). While all 10 slots are in use, a new async hook is skipped

**Example:**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "write_file|edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$QWEN_PROJECT_DIR/.qwen/hooks/run-tests-async.sh\"",
            "async": true,
            "timeout": 300
          }
        ]
      }
    ]
  }
}
```

```bash
#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [[ "$FILE_PATH" != *.ts && "$FILE_PATH" != *.js ]]; then exit 0; fi
# Async hook output is not shown yet, so write the result to a file.
LOG=/tmp/qwen-async-tests.log
if npm test >"$LOG" 2>&1; then
  echo "Tests passed after editing $FILE_PATH" >>"$LOG"
else
  echo "Tests failed after editing $FILE_PATH" >>"$LOG"
fi
```

### Security Model

- Hooks run in the user's environment with user privileges
- Project-level hooks require trusted folder status
- Timeouts prevent hanging hooks (default: 60 seconds for command hooks)

## Best Practices

### Example 1: Security Validation Hook

A PreToolUse hook that logs and potentially blocks dangerous commands:

**security_check.sh**

```bash
#!/bin/bash

# Read input from stdin
INPUT=$(cat)

# Parse the input to extract tool info
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input')

# Check for potentially dangerous operations
if echo "$TOOL_INPUT" | grep -qiE "(rm.*-rf|mv.*\/|chmod.*777)"; then
  echo '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "Security policy blocks dangerous command"
    }
  }'
  exit 2  # Blocking error
fi

# Log the operation
echo "INFO: Tool $TOOL_NAME executed safely at $(date)" >> /var/log/qwen-security.log

# Allow with additional context
echo '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Security check passed",
    "additionalContext": "Command approved by security policy"
  }
}'
exit 0
```

Configure in `.qwen/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${SECURITY_CHECK_SCRIPT}",
            "name": "security-checker",
            "description": "Security validation for bash commands",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### Example 2: HTTP Audit Hook

A PostToolUse HTTP hook that sends all tool execution records to a remote audit service:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "https://audit.example.com/api/tool-execution",
            "headers": {
              "Authorization": "Bearer ${AUDIT_API_TOKEN}",
              "Content-Type": "application/json"
            },
            "allowedEnvVars": ["AUDIT_API_TOKEN"],
            "timeout": 10,
            "name": "audit-logger"
          }
        ]
      }
    ]
  }
}
```

### Example 3: Submitted Prompt Validation Hook

On the core/headless path, `prompt` can include generated or expanded content rather than original user input. On ACP it starts with the pre-expansion request text, so reading it does not inspect attachment bodies or the complete model input. `UserPromptSubmit` does not cover every model send. Do not silently fall back from `submitted_prompt` to `prompt` when source provenance is required.

A UserPromptSubmit hook that validates supported submitted text and provides context for long prompts. It also runs on headless submissions and explicitly declared ACP/daemon submissions; it is not TUI-only. It skips invocations where source provenance is unavailable. A blocking result stops the affected invocation, including on these non-TUI paths. The keyword check is illustrative and is not a complete DLP policy:

**prompt_validator.py**

```python
import json
import sys
import re

# Load input from stdin
try:
    input_data = json.load(sys.stdin)
except json.JSONDecodeError as e:
    print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
    sys.exit(1)

user_prompt = input_data.get("submitted_prompt")
if user_prompt is None:
    # Do not mistake model-bound or machine-generated content for raw input.
    sys.exit(0)

# Sensitive words list
sensitive_words = ["password", "secret", "token", "api_key"]

# Check for sensitive information
for word in sensitive_words:
    if re.search(rf"\b{word}\b", user_prompt.lower()):
        # Block prompts containing sensitive information
        output = {
            "decision": "block",
            "reason": f"Prompt contains sensitive information '{word}'. Please remove sensitive content and resubmit.",
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit"
            }
        }
        print(json.dumps(output))
        sys.exit(0)

# Check prompt length and add warning context if too long
if len(user_prompt) > 1000:
    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": "Note: User submitted a long prompt. Please read carefully and ensure all requirements are understood."
        }
    }
    print(json.dumps(output))
    sys.exit(0)

# No processing needed for normal cases
sys.exit(0)
```

## Troubleshooting

### A hook does not fire

1. **Event name.** The key must be one of the events in [Hook Events](#hook-events), spelled exactly, including case. An unknown event name is skipped with the warning `Invalid hook event name`.
2. **Matcher.** Tool events match the runtime tool id, such as `run_shell_command` or `write_file`, or an accepted alias such as Claude Code's `Bash` or `Write` (see [Matcher Patterns](#matcher-patterns)). On events without matcher support, `matcher` is ignored.
3. **Folder trust.** Hooks in a project's `.qwen/settings.json` load only when the folder is trusted. User hooks load regardless of folder trust.
4. **Hooks disabled.** `"disableAllHooks": true`, `--safe-mode` (or `QWEN_CODE_SAFE_MODE`) and `--bare` (or `QWEN_CODE_SIMPLE`) turn off all hooks, including user hooks.
5. **Debug log.** Start Qwen Code with `--debug`, or set `QWEN_DEBUG_LOG_FILE=1`, then read the session log at `~/.qwen/debug/latest` (under `$QWEN_RUNTIME_DIR` when that is set). Each line is tagged with a namespace:
   - `[HOOK_REGISTRY]`: `Hook registry initialized with N hook entries`, and hook definitions discarded as invalid
   - `[TRUSTED_HOOKS]`: `Hook <name> started for event <event>` and the matching `ended` line for each run, async hook status, and hook system messages
   - `[HOOK_MATCHER]`: matchers that are not valid regular expressions
   - `[HOOK_TIMEOUT]`: command hook `timeout` values read as milliseconds or ignored
   - `[HTTP_HOOK_RUNNER]`, `[URL_VALIDATOR]`, `[PROMPT_HOOK_RUNNER]`, `[FUNCTION_HOOK_RUNNER]`, `[SKILL_HOOKS]`, `[SESSION_HOOKS_MANAGER]`, `[ASYNC_HOOK_REGISTRY]` and `[HOOK_AGGREGATOR]`: details from the individual runners and registries

   Prompt-hook inputs can be written to the session debug log, so apply appropriate access and retention controls.

6. **Edited during the session.** Hooks are read when the session starts. After editing hook definitions, open the interactive `/hooks` menu once to reload them, or restart Qwen Code. Changes to hook controls and HTTP security settings require a restart.

### Other checks

- Verify hook script permissions and executability
- Ensure proper JSON formatting in hook outputs
- Use specific matcher patterns to avoid unintended hook execution
- Temporarily disable all hooks: add `"disableAllHooks": true` in settings
