# Agent Skills

> Create, manage, and share Skills to extend Qwen Code's capabilities.

This guide shows you how to create, use, and manage Agent Skills in **Qwen Code**. Skills are modular capabilities that extend the model's effectiveness through organized folders containing instructions (and optionally scripts/resources).

## Prerequisites

- Qwen Code (recent version)
- Basic familiarity with Qwen Code ([Quickstart](../quickstart.md))

## What are Agent Skills?

Agent Skills package expertise into discoverable capabilities. Each Skill consists of a `SKILL.md` file with instructions that the model can load when relevant, plus optional supporting files like scripts and templates.

### How Skills are invoked

Skills are **model-invoked** — the model autonomously decides when to use them based on your request and the Skill's description. This is different from slash commands, which are **user-invoked** (you explicitly type `/command`).

If you want to invoke a Skill explicitly, type it as a slash command using the Skill's name:

```bash
/<skill-name>
```

Start typing `/` to autocomplete and browse available Skills alongside their descriptions. The `/skills` command opens the Skills panel, where you can browse, search, toggle, and launch Skills interactively.

> **Note:** If you previously ran a Skill with `/skills <skill-name>`, that syntax now just opens the Skills panel and ignores the trailing argument. Use `/<skill-name>` to run a Skill directly.

### Benefits

- Extend Qwen Code for your workflows
- Share expertise across your team via git
- Reduce repetitive prompting
- Compose multiple Skills for complex tasks

## Create a Skill

Skills are stored as directories containing a `SKILL.md` file.

### Generate a project Skill with `/learn`

Use `/learn` to distill an existing knowledge source into a reusable project
Skill:

```text
/learn https://docs.example.com/api
/learn ~/projects/acme-sdk
/learn Our deploy process: run migrate, deploy the service, then check health
```

The command runs as a normal agent turn and creates the result under
`.qwen/skills/learned-skill-<name>/SKILL.md` with `source: learned` in its
frontmatter. Review the generated instructions before using or sharing them.

`/learn` also accepts local or direct-link `.mp4`, `.webm`, `.mov`, and `.m4v`
videos. Add text after the path or URL to focus the generated Skill on one part
of the tutorial:

```text
/learn ./tutorial.mp4 focus on the deployment workflow
```

Video learning requires a video-capable model on an OpenAI-compatible provider.
YouTube page URLs are not direct video input; download the video into the
workspace and pass its local path instead.

### Personal Skills

Personal Skills are available across all your projects. Store them in `~/.qwen/skills/`:

```bash
mkdir -p ~/.qwen/skills/my-skill-name
```

Use personal Skills for:

- Your individual workflows and preferences
- Skills you're developing
- Personal productivity helpers

### Project Skills

Project Skills are shared with your team. Store them in `.qwen/skills/` within your project:

```bash
mkdir -p .qwen/skills/my-skill-name
```

Use project Skills for:

- Team workflows and conventions
- Project-specific expertise
- Shared utilities and scripts

Project Skills can be checked into git and automatically become available to teammates.

### Maintain auto-generated project Skills

Qwen Code tracks successful uses of generated project Skills locally, including while new Auto Skill generation is disabled, so re-enabling maintenance cannot mistake a recently used skill for an inactive one. When **Auto Skill** is enabled, it periodically moves inactive generated Skills out of the active library. Only directories named `.qwen/skills/auto-skill-*` whose `SKILL.md` frontmatter contains `source: auto-skill` are managed; personal, extension, bundled, and hand-authored Skills are never selected.

- After 30 days without a successful use or `SKILL.md` edit, an auto-skill is marked stale.
- After 90 days, its complete directory is moved to `.qwen/archived-skills/`. Nothing is permanently deleted.
- Automatic maintenance runs at most once every 7 days in trusted workspaces. Each newly observed auto-skill gets a full grace period before maintenance begins.
- A pinned auto-skill is excluded from automatic stale and archive transitions until it is unpinned.
- Archived directory names remain reserved, and an existing archive destination skips only that collision rather than stopping maintenance for other skills.

Use `/curator` to see active, stale, archived, and pinned auto-skills. Run `/curator run --dry-run` to preview a maintenance pass, `/curator run` to apply it immediately, `/curator pin <directory>` or `/curator unpin <directory>` to control per-skill maintenance, or `/curator restore <directory>` to move an archived auto-skill back into the active library.

Status and dry-run previews are available in safe mode and untrusted workspaces. Applying maintenance, changing pins, and restoring archived auto-skills require a trusted workspace outside safe mode.

## Write `SKILL.md`

Create a `SKILL.md` file with YAML frontmatter and Markdown content:

```yaml
---
name: your-skill-name
description: Brief description of what this Skill does and when to use it
priority: 10
---

# Your Skill Name

## Instructions
Provide clear, step-by-step guidance for Qwen Code.

## Examples
Show concrete examples of using this Skill.
```

### Field requirements

Qwen Code currently validates that:

- `name` is a non-empty string matching `/^[\p{L}\p{N}_:.-]+$/u` — Unicode letters and digits (CJK / Cyrillic / accented Latin all OK), plus `_`, `:`, `.`, `-`. Whitespace, slashes, brackets and other structurally unsafe characters are rejected at parse time.
- `description` is a non-empty string
- `priority` is optional. When present, it must be a finite number. Higher values sort earlier in the `/skills` listing only — slash-command completion (typing `/`) and the `/help` custom commands view stay alphabetical, so a high-priority Skill never reorders built-in commands. Omitted or invalid values are treated as unset, which behaves like `0`.

Recommended conventions:

- Prefer lowercase ASCII with hyphens for shareable names (e.g. `tsx-helper`)
- Make `description` specific: include both **what** the Skill does and **when** to use it (key words users will naturally mention)
- Use `priority` sparingly for Skills that should reliably appear before the default alphabetical order in `/skills`. Negative priorities are allowed and sort below unset Skills.

### Optional: gate a Skill on file paths (`paths:`)

For Skills that only matter to specific parts of a codebase, add a `paths:` list of glob patterns. The Skill stays out of the model's available-skills listing until a tool call touches a matching file:

```yaml
---
name: tsx-helper
description: React TSX component helper
paths:
  - 'src/**/*.tsx'
  - 'packages/*/src/**/*.tsx'
---
```

Notes:

- Globs are matched relative to the project root with [picomatch](https://github.com/micromatch/picomatch); files outside the project root never trigger activation.
- A path-gated Skill **stays activated for the rest of the session** once a matching file is touched. A new session, or a `refreshCache` triggered by editing any Skill file, resets activations.
- `paths:` only gates **model** discovery, and only at the SkillTool listing level. Unless `user-invocable: false` is set, you can always invoke a path-gated Skill yourself via `/<skill-name>` or the `/skills` picker — that user path runs the Skill body regardless of activation state. The model side, however, stays gated until a matching file is touched: a slash invocation does **not** unlock model-side activation, so if you want the model to chain off your invocation (call `Skill { skill: ... }` itself), also access a file matching the skill's `paths:` first.
- Combining `paths:` with `disable-model-invocation: true` is allowed but the gate has no effect — the Skill is hidden from the model regardless, so path activation never advertises it.

### Optional: control user and model invocation

Skills are user-invocable by default. To hide a Skill from direct slash-command use while keeping it available for model invocation, set `user-invocable: false`:

```yaml
---
name: model-only-helper
description: Helper the model can call when appropriate
user-invocable: false
---
```

This removes the Skill from `/<skill-name>` invocation and `/skills` picker results. It does not hide the Skill from the model.

To hide a Skill from model invocation while keeping direct user invocation available, set `disable-model-invocation: true`:

```yaml
---
name: manual-helper
description: Helper you invoke manually
disable-model-invocation: true
---
```

You can combine both fields, but then the Skill is not reachable through the normal user or model invocation paths.

### Optional: enforce a rule deterministically (`hooks:`)

Everything in a `SKILL.md` body is an instruction to the model: it is prompt text, so following it depends on the model. When a rule must hold no matter what the model decides — refuse to run unless a required value was injected, never touch a protected path — declare a [hook](hooks.md) in the frontmatter instead. Hooks run as code, so they do not depend on the model's cooperation:

```yaml
---
name: gated-skill
description: Calls the downstream CLI using a runtime-injected session ID
hooks:
  PreToolUse:
    - matcher: run_shell_command
      hooks:
        - type: command
          command: '"$QWEN_SKILL_ROOT/scripts/gate-session-id.sh"'
---
```

`$QWEN_SKILL_ROOT` is set to the Skill's own directory, so hook commands can reference files shipped alongside `SKILL.md`. The command string is handed to a shell, so **keep the inner quotes**: unquoted, a project path containing a space splits into two words and the gate never runs. **Make the script executable** (`chmod +x`) too. Both mistakes fail open in the same way: the tool call proceeds, and nothing appears in the transcript or the log to say the gate did not run. A `PreToolUse` hook blocks the tool call when it exits with code `2` (stderr is fed back to the model as the reason), or when it prints `hookSpecificOutput.permissionDecision: "deny"`:

```bash
#!/usr/bin/env bash
if [ -z "${DOWNSTREAM_SESSION_ID:-}" ]; then
  echo "Required input DOWNSTREAM_SESSION_ID is not available. Cannot proceed." >&2
  exit 2
fi
exit 0
```

Notes:

- Hooks are registered when the Skill is invoked and last for the rest of the session. This is true on both invocation paths — whether the model calls the Skill or you type `/<skill-name>`.
- Session hooks live only in memory, so resuming a session with `--continue` / `--resume` does **not** restore them, on either invocation path. The Skill's instructions can come back with the replayed conversation while the hooks meant to enforce them are gone — re-run the Skill after resuming to re-arm its gate.
- Registration is idempotent: re-invoking a Skill does not stack duplicate hooks.
- Always give a tool event an explicit `matcher:`. An omitted one is stored as the empty pattern, which is compiled to `^$` and matches no tool name — the hook registers and then never fires, with nothing to say so. Use `*` if you mean every tool.
- The `command:` runs through the platform shell: `bash` on macOS and Linux, and on Windows Git Bash when it is detected (`MSYSTEM`/`TERM`), otherwise `cmd.exe` or PowerShell. The example above is POSIX shell — under `cmd.exe` `$QWEN_SKILL_ROOT` is not expanded and a `.sh` script is not executable, so the gate fails open there. A hook may set `shell: bash` to force bash, but that resolves to whatever `bash` is on `PATH`, so on Windows outside Git Bash write the gate for the shell you actually have.
- Sessions that disable hooks register none of them — `disableAllHooks`, safe mode, and an ACP client's `skipHooks`. The Skill's body and its `allowedTools` still apply in those sessions, but its gate does not, so a rule you rely on a hook to enforce is not enforced there. Bare mode goes further: no Skills are discovered at all, so there is no body and no `allowedTools` either.
- A **project** Skill's hooks run repo-supplied commands, so they are registered only in a trusted folder, and trust is re-read every time a hook fires and every time a permission is decided. With an IDE companion connected that value is live: revoking trust silences an already-registered gate — and suspends the Skill's `allowedTools` — at the next tool call, without a restart. Without an IDE connection the value is fixed when the CLI starts, so a change made through the CLI's own trust dialog takes effect on restart. Granting trust never retro-registers: invoke the Skill again.
- `hooks:` is read for project, user, and bundled Skills. Extension-provided Skills do not support it; use the extension's own manifest-level hooks instead.
- See [Hooks](hooks.md) for the full event list, matcher syntax, and output format.

## Add supporting files

Create additional files alongside `SKILL.md`:

```text
my-skill/
├── SKILL.md (required)
├── reference.md (optional documentation)
├── examples.md (optional examples)
├── scripts/
│   └── helper.py (optional utility)
└── templates/
    └── template.txt (optional template)
```

Reference these files from `SKILL.md`:

````markdown
For advanced usage, see [reference.md](reference.md).

Run the helper script:

```bash
python scripts/helper.py input.txt
```
````

## View available Skills

Qwen Code discovers Skills from:

- Personal Skills: `~/.qwen/skills/`
- Project Skills: `.qwen/skills/`
- Extension Skills: Skills provided by installed extensions
- Bundled Skills: Skills shipped with Qwen Code

### Extension Skills

Extensions can provide custom skills that become available when the extension is enabled. These skills are stored in the extension's `skills/` directory and follow the same format as personal and project skills.

Extension skills are automatically discovered and loaded when the extension is installed and enabled.

To see which extensions provide skills, check the extension's `qwen-extension.json` file for a `skills` field.

To view available Skills, ask Qwen Code directly:

```text
What Skills are available?
```

> **Heads up — model vs. user view.** Asking the model only surfaces Skills the model can currently see. If a Skill uses `paths:` (see "Optional: gate a Skill on file paths" above), it stays out of that listing until a matching file has been touched. The `/skills` slash command shows Skills you can invoke directly; Skills with `user-invocable: false` remain visible on disk and may still be visible to the model.

Or browse the user-invocable list with the slash command (including path-gated Skills that have not activated yet):

```text
/skills
```

Or inspect the filesystem:

```bash
# List personal Skills
ls ~/.qwen/skills/

# List project Skills (if in a project directory)
ls .qwen/skills/

# View a specific Skill's content
cat ~/.qwen/skills/my-skill/SKILL.md
```

## Test a Skill

After creating a Skill, test it by asking questions that match your description.

Example: if your description mentions "PDF files":

```text
Can you help me extract text from this PDF?
```

The model autonomously decides to use your Skill if it matches the request — you don't need to explicitly invoke it.

## Debug a Skill

If Qwen Code doesn't use your Skill, check these common issues:

### Make the description specific

Too vague:

```yaml
description: Helps with documents
```

Specific:

```yaml
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDFs, forms, or document extraction.
```

### Verify file path

- Personal Skills: `~/.qwen/skills/<skill-name>/SKILL.md`
- Project Skills: `.qwen/skills/<skill-name>/SKILL.md`

```bash
# Personal
ls ~/.qwen/skills/my-skill/SKILL.md

# Project
ls .qwen/skills/my-skill/SKILL.md
```

### Check YAML syntax

Invalid YAML prevents the Skill metadata from loading correctly.

```bash
cat SKILL.md | head -n 15
```

Ensure:

- Opening `---` on line 1
- Closing `---` before Markdown content
- Valid YAML syntax (no tabs, correct indentation)

### View errors

Run Qwen Code with debug mode to see Skill loading errors:

```bash
qwen --debug
```

## Share Skills with your team

You can share Skills through project repositories:

1. Add the Skill under `.qwen/skills/`
2. Commit and push
3. Teammates pull the changes

```bash
git add .qwen/skills/
git commit -m "Add team Skill for PDF processing"
git push
```

## Update a Skill

Edit `SKILL.md` directly:

```bash
# Personal Skill
code ~/.qwen/skills/my-skill/SKILL.md

# Project Skill
code .qwen/skills/my-skill/SKILL.md
```

During a normal session, Qwen Code watches personal and project Skill
directories. Adding, editing, or removing a Skill refreshes the Skill list and
invocation state automatically after a short delay. Bare mode does not start
these watchers, so restart Qwen Code to load Skill changes in that mode.

## Remove a Skill

Delete the Skill directory:

```bash
# Personal
rm -rf ~/.qwen/skills/my-skill

# Project
rm -rf .qwen/skills/my-skill
git commit -m "Remove unused Skill"
```

## Best practices

### Keep Skills focused

One Skill should address one capability:

- Focused: "PDF form filling", "Excel analysis", "Git commit messages"
- Too broad: "Document processing" (split into smaller Skills)

### Write clear descriptions

Help the model discover when to use Skills by including specific triggers:

```yaml
description: Analyze Excel spreadsheets, create pivot tables, and generate charts. Use when working with Excel files, spreadsheets, or .xlsx data.
```

### Test with your team

- Does the Skill activate when expected?
- Are the instructions clear?
- Are there missing examples or edge cases?
