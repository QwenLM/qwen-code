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

`<skill-name>` is always the Skill's registered name. For a Skill from an installed extension that name carries its owner — `rust:pdf`, not `pdf` — so you type `/rust:pdf`. See [How extension Skills are named](#how-extension-skills-are-named).

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

- `name` is a non-empty string matching `/^[\p{L}\p{N}_:.-]+$/u` — Unicode letters and digits (CJK / Cyrillic / accented Latin all OK), plus `_`, `:`, `.`, `-`. Whitespace, slashes, brackets and other structurally unsafe characters are rejected at parse time. The admitted `:` is what lets a Skill registered by an extension (`rust:pdf`) and an author who chooses a colon themselves (`rust:chat`, written inside the `rust` extension) share one pattern, so a colon in a registered name is not proof of an owner — see [How extension Skills are named](#how-extension-skills-are-named).
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

#### How extension Skills are named

Qwen Code registers a Skill from an installed extension as `<extensionName>:<name>`, where `<extensionName>` is the `name` field of that extension's `qwen-extension.json` and `<name>` is the Skill's own frontmatter `name`. A Skill named `pdf` in the `rust` extension is registered as `rust:pdf`.

The prefix is added while the Skill is loaded, not written into the file: your `SKILL.md` keeps the name you authored, and Qwen Code never recovers the authored name by splitting the registered one apart (an author may legitimately write `rust:chat` inside `rust`). Only extension Skills are prefixed — personal, project, and bundled Skills keep the single spelling you authored.

Use the registered name everywhere you refer to the Skill:

- Invoke it as `/rust:pdf`. The bare `/pdf` is not an alias — the extension's Skill is reachable only under its registered name.
- The model calls it as `Skill { skill: "rust:pdf" }`, the same name it reads in `<available_skills>`.
- Two extensions that each ship a Skill named `pdf` give you two Skills (`rust:pdf` and `docs-suite:pdf`) rather than one winning and one disappearing.

The surfaces where you read and choose Skills also name the owner: the Skills panel (including the rows a setting has locked), the read-only listing a bare `/skills` prints outside the interactive UI (ACP and other non-interactive modes — interactively the command opens the panel), and the badge in the `/` command palette, which reads `[Extension: Rust]` rather than a bare `[Extension]`. Those labels prefer the extension's `displayName` and fall back to its `name` when it declares none.

#### Extension Skills and the `skills.*` settings

`skills.disabled`, `skills.defaultDisabled`, and `slashCommands.disabled` match an extension Skill under **either** spelling, so a `skills.disabled: ["pdf"]` you wrote before the prefix existed still hides `rust:pdf`. A restriction can only remove capability, so renaming a Skill is not allowed to lift one.

`skills.enabled` is the exception, and the one visible change for an existing settings file: it grants capability, so it matches the registered name only. `skills.enabled: ["pdf"]` no longer opts an extension's `pdf` in on its own — write `skills.enabled: ["rust:pdf"]`. The one bare pair that keeps working is a pre-prefix opt-in sitting in `skills.defaultDisabled` with the same spelling: cancellation compares the entries themselves, so `defaultDisabled: ["pdf"]` + `enabled: ["pdf"]` cancels the entry — the skill then ends up enabled only if the extension's own default leaves it on; for a default-off skill, write `rust:pdf` in `skills.enabled`.

Toggling a Skill in the Skills panel writes the registered name and removes only that entry, so enabling `rust:pdf` leaves a legacy `disabled: ["pdf"]` untouched. When that legacy entry sits in a higher scope — system defaults, user, or system settings — the panel says so and locks the row, naming the scope to edit rather than offering a toggle that cannot move it. A legacy entry in this workspace's own settings locks the row the same way, naming the entry and its scope (`skills.disabled 'pdf' (Workspace)` or `skills.defaultDisabled 'pdf' (Workspace)`) so you know which list in which file to edit.

Two limits worth knowing:

- Cross-level precedence is unchanged and still compares registered names exactly (`project` > `user` > `extension` > `bundled`), so a personal or project Skill you author as `rust:pdf` outranks the extension's `pdf`. Bare-name collisions between a personal or project Skill and a bundled Skill are likewise still settled by that precedence, not by the prefix. A Skill that collides with a custom command is not — on the slash surface the last loader wins, and custom commands load after Skills, so `/pdf` runs the custom command while the Skill stays available to the model.
- Skill names are also used as filenames: the file a Skill reads its invocation arguments from replaces every character outside `[A-Za-z0-9._-]` with `_`, so an extension Skill registered as `rust:pdf` and a personal or project Skill authored `rust_pdf` both resolve to `qwen-skill-args-rust_pdf.txt` and share one arguments file. (The prefix rarely collides with itself — `rust:rust_pdf` becomes `rust_rust_pdf` — but extension names may contain `_`, so `rust_pdf:x` and `rust:pdf_x` fold to the same filename.) Non-ASCII letters fold the same way, so an authored `café` and an authored `caf_` land on `caf_` too — a limitation that predates the prefix, which only makes it easier to hit. Avoid a Skill name that is another name with `:` turned into `_`.

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
