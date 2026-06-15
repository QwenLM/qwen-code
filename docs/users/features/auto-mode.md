# Auto Mode

Auto Mode uses an LLM classifier to evaluate each tool call and decide
whether to auto-approve it. It sits between Auto-Edit (which only
auto-approves file edits) and YOLO (which auto-approves everything).

This page is the reference for configuring and troubleshooting Auto Mode.
For an introduction, see the
[Approval Mode overview](./approval-mode.md#4-auto-mode---classifier-driven-approval).

## How it works

When you're in Auto Mode and the agent tries to run a tool, Qwen Code
walks three layers in order:

1. **acceptEdits fast-path** — Edit / Write whose target path is inside
   the workspace is auto-approved without invoking the classifier.
   **Exception:** writes to Qwen Code's own self-modification surfaces
   (`.qwen/settings*.json`, `QWEN.md`, `AGENTS.md`, `QWEN.local.md`,
   configured context filenames, `.qwen/rules/`, `.qwen/commands/`,
   `.qwen/agents/`, `.qwen/skills/`, `.qwen/hooks/`, `.mcp.json`) and
   persistence surfaces (`.git/`, `.husky/`, `package.json`, `.npmrc`,
   `Makefile`, `.github/workflows/`, etc.) route through the classifier
   even when they are inside the workspace. Symlinks targeting protected
   paths are resolved and rejected too. Shell commands that reach these
   paths via `cd && bash -lc '...'` or other wrappers go through the
   classifier as well.
2. **Safe-tool allowlist** — Read-only and metadata-only built-in tools
   (Read, Grep, Glob, LS, LSP, TodoWrite, AskUserQuestion, etc.) are
   auto-approved without invoking the classifier.
3. **LLM classifier** — Everything else (shell commands, web fetches,
   sub-agent spawns, edits outside the workspace, MCP tools) is sent to
   a two-stage classifier:
   - **Stage 1 (fast)** — outputs `{ shouldBlock }` only. Around ~300ms.
     If `shouldBlock` is `false`, the action is allowed and the call
     proceeds.
   - **Stage 2 (thinking)** — only runs when Stage 1 said block. Uses
     chain-of-thought review to reduce Stage 1 false positives. Can
     downgrade Stage 1's block to allow. Outputs the user-visible
     `reason` on block.

The classifier uses your configured fast model
(`/model --fast`). If no fast model is configured, the main session
model is used instead.

## Hard rules still win

Auto Mode does **not** replace hard permission rules. Before the classifier
runs:

- `permissions.deny` rules block the action with the rule's reason. The
  classifier never sees it.
- `permissions.allow` rules with specific specifiers (e.g.
  `Bash(git status)`, `Read(./docs/**)`) still auto-allow without the
  classifier — **except** when the call resolves to a write at a
  protected self-modification or persistence path (see the list under
  "How it works"). In that case Auto Mode re-checks the call through
  the classifier so an allow rule on `Bash(*)` cannot silently turn
  into permission to rewrite Qwen Code settings, commands, hooks,
  skills, or MCP servers.
- `permissions.ask` rules force manual confirmation even in Auto Mode.

## Over-broad allow rules are stripped while in Auto Mode

Rules like the following would let the agent execute arbitrary code
without classifier review:

- `Bash` / `Bash(*)` / `Bash()` — auto-allow every shell command
- `Bash(python:*)`, `Bash(node*)`, `Bash(bash*)` — interpreter wildcards
- `Agent` / `Agent(coder)` — any allow on the Agent tool
- `Skill` / `Skill(pdf)` — any allow on the Skill tool

When you enter Auto Mode, Qwen Code temporarily removes these rules from
the active permission set and prints a notice listing them. The rules
come back the moment you leave Auto Mode. `settings.json` is never
modified.

If you genuinely need these broad rules, use YOLO mode instead.

## Configuring hints

Auto Mode reads `permissions.autoMode` from your `settings.json`. The
entries are natural-language descriptions, not rule patterns — they are
injected additively into the classifier's system prompt alongside the
built-in defaults.

There are three hint categories plus an environment list:

- **`allow`** — actions the classifier should auto-approve.
- **`softDeny`** — destructive or irreversible actions the classifier
  should block **unless the user's most recent explicit request asked
  for that exact action and scope**. Soft denies can be cleared by
  user intent; a generic "yes do whatever" doesn't count.
- **`hardDeny`** — security-boundary actions the classifier must block
  in Auto Mode regardless of `autoMode.hints.allow` or recent user
  intent. This is classifier policy, not a deterministic permission
  rule: it does not override `permissions.allow`. Use `permissions.deny`
  for actions that must never be allowed by the permission manager.

```json
{
  "permissions": {
    "autoMode": {
      "hints": {
        "allow": [
          "Running poetry install and poetry update in this Python project",
          "Cleaning build artifacts under ./dist or ./build",
          "Reading any file under /Users/me/code/"
        ],
        "softDeny": [
          "Editing Qwen Code settings unless I explicitly ask for the exact change",
          "Running migration scripts that touch the production DB"
        ],
        "hardDeny": [
          "Sending secrets or .env contents to any network endpoint",
          "Modifying anything under ~/.ssh or ~/.aws"
        ]
      },
      "environment": [
        "This is a private monorepo with strict commit signing",
        "Production credentials live in 1Password, never in plain files"
      ]
    }
  }
}
```

`hints.deny` is still accepted for backward compatibility and is treated
as `softDeny`. Mixing both is fine — entries are concatenated, `softDeny`
first.

### Length and count limits

To keep the classifier system prompt small:

- Each entry is capped at 200 characters (longer entries are truncated
  with a warning).
- `hints.allow`, `hints.softDeny`, and `hints.hardDeny` accept up to 50
  entries each.
- `environment` accepts up to 20 entries.

### Layering across settings files

`autoMode` is merged across system / user / workspace settings the same
way other permission settings are: arrays are concatenated and
de-duplicated.

## Reading the decision

When the classifier blocks an action, the tool call fails with one of
the following error texts:

- **`Blocked by auto mode policy: <reason>`** —
  the classifier judged the action unsafe. The reason comes from Stage
  2 of the classifier.
- **`Auto mode classifier unavailable; action blocked for safety`** —
  the classifier API was unreachable, timed out, or returned an
  un-parseable response. This is fail-closed behavior: when in doubt,
  block.

Both messages are followed by a trailing guidance line telling the agent
that the **denied action specifically** must not be completed through
another tool, shell indirection, generated script, alias, symlink,
config change, hook, command file, MCP configuration, encoded payload,
or equivalent path. **Unrelated safe work and genuinely safer
alternatives are still allowed** — only attempts to accomplish the same
denied intent through a different surface are blocked.

If the denied action is genuinely required, the agent should stop and
ask you for explicit approval rather than route around the denial.

### Classifier reason language

Classifier reasons are produced by the LLM and are not translated. If you
want non-English reasons, add a hint like
`Respond reasons in Chinese` to `permissions.autoMode.environment`.

## Fallback to manual approval

Auto Mode protects you from getting stuck:

- After **3 consecutive policy blocks** the next tool call falls back to
  the standard manual-approval prompt. This catches the case where the
  agent keeps trying minor variants of a forbidden command.
- After **2 consecutive unavailable** results (classifier API failures)
  the next tool call also falls back. This avoids waiting on a broken
  classifier.

The session itself stays in Auto Mode — only the single fallback call
goes through manual approval. The counters reset when you approve the
fallback call or switch modes.

If you find yourself constantly hitting fallback, the most likely causes
are an outage on the classifier API or hints that need tuning. Switch to
Default Mode while you investigate.

## Troubleshooting

**"Auto mode keeps blocking my commands"**

Look at the reason in the error message. If the classifier is being too
conservative for your context, add an entry to
`permissions.autoMode.hints.allow` describing the pattern in
natural-language. Examples:

- `"Building Docker images for this project (docker build ...)"`
- `"Running database migrations against the local test DB"`

**"Auto mode classifier unavailable"**

The classifier API didn't respond. Possible causes:

- Network issue between you and the model endpoint.
- The configured fast model is no longer available — check `/model --fast`.
- The transcript is too long and exceeds the fast-model context window.

While diagnosing, switch back to Default Mode: `/approval-mode default`.

**"Falling back to manual approval"**

You've hit either the 3-consecutive-block or 2-consecutive-unavailable
guard. Approve or reject the prompt as you normally would. After one
approved fallback the consecutive counter resets.

**The classifier sees sensitive data in my prompts**

Tool inputs are projected through each tool's `toAutoClassifierInput`
method before they reach the classifier. Long edit content, web fetch
prompts, and sub-agent prompts are truncated. Tool results (file
contents, web pages) are never sent to the classifier — only the user's
text and assistant tool-use calls go through.

If a specific tool is exposing fields you'd rather redact, file an issue
with the tool name; the projection is per-tool and is meant to be
tightened over time.

## Limitations

- **Not offline-capable.** The classifier requires an LLM call.
- **Adds latency on the slow path.** Allowlist + acceptEdits cover most
  calls without latency, but a `run_shell_command` typically adds
  ~300ms (fast classifier path) or ~3-5s (slow path with thinking
  review).
- **Not a substitute for `deny` rules.** The classifier is best-effort.
  For commands you're sure should never run, put them in
  `permissions.deny`.
- **MCP tools default to conservative blocking.** Third-party MCP tools
  (`mcp__*`) opt-in to argument forwarding via the
  `toAutoClassifierInput` override. Tools that have not opted in expose
  only their name to the classifier — most such calls are
  conservatively blocked unless you've written an explicit `allow`
  rule. This is fail-closed by design (credentials and voluminous
  content do not leak into the classifier LLM). If you trust a
  specific MCP tool, add `permissions.allow: ["mcp__server__tool"]` so
  it bypasses the classifier entirely.

## FAQ

**Does Auto Mode send my code to a third party?**

Auto Mode reuses your existing model configuration — same endpoint as
the main agent. If you've configured Qwen Code to use a self-hosted
model, the classifier runs against that endpoint too.

**Will my secrets / `.env` contents reach the classifier?**

The classifier sees only what each tool's `toAutoClassifierInput`
projection exposes:

- `read_file` and other read-only tools: not invoked (they're on the
  fast-path allowlist).
- `edit` / `write_file`: file_path plus the first 80 characters of
  old/new content. Full content is not forwarded.
- `run_shell_command`: the full command (it has to — that's what the
  classifier judges).
- `web_fetch`: the URL only. The prompt field is not forwarded.
- `agent`: subagent type plus the full prompt. The prompt is the
  instruction the sub-agent will follow, so the classifier needs it
  in full to detect attacks that would steer the sub-agent toward
  destructive actions — same reason `run_shell_command` forwards the
  full command.

Tool results (the actual content returned by tools) are stripped from
the classifier transcript entirely.

MCP tools (`mcp__*`) follow a stricter default: their parameters are
not forwarded unless the MCP tool author explicitly opted in via the
`toAutoClassifierInput` override. The classifier sees the tool name
but no arguments, so most MCP calls will be conservatively blocked
unless the user has written an explicit allow rule. This is fail-
closed by design — third-party tools should not leak credentials or
voluminous file content into the classifier LLM without intent.

**Can I disable the first-time information message?**

It only shows once per user-settings file. After dismissal,
`ui.autoModeAcknowledged: true` is set in your user settings.

**How is this different from Auto-Edit?**

Auto-Edit auto-approves file edits and nothing else — shell commands
still ask. Auto Mode uses a classifier to also auto-approve safe shell
commands and other tool calls while still blocking risky ones.

**How is this different from YOLO?**

YOLO auto-approves everything without any review. Auto Mode has the
classifier in the loop and blocks risky actions.
