# Output Styles

Output styles change how Qwen Code writes its responses — the tone, the amount of narration, how much it explains — without changing what it can do. A style is a named block of instructions layered onto the built-in system prompt, and the model is reminded of the active style on every turn so it holds up over long sessions.

## Built-in styles

| Style           | What it does                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **default**     | No extra style — the standard prompt.                                                                                                                                                         |
| **Concise**     | Answers first, with no preamble, narration, or closing recap. The work stays as thorough as ever; error reports and safety confirmations keep their full content.                             |
| **Proactive**   | Starts work immediately and prefers a stated assumption over a question on low-risk decisions. Does not change what is allowed: the approval mode and confirmation rules still apply in full. |
| **Explanatory** | Adds short educational "Insight" notes about the codebase and the implementation choices alongside the work.                                                                                  |
| **Learning**    | Collaborative learn-by-doing: hands you small, meaningful pieces of code to write (marked `TODO(human)`), then waits. Skipped in headless runs, which cannot wait for you.                    |

## Choosing a style

Run `/output-style` to open a picker, or set one directly:

```
/output-style Concise
/output-style default   # back to no style
```

The change applies to the running session immediately — the system prompt is rebuilt in place, so the next turn already answers in the new style — and it is persisted for future sessions. If a trusted project setting currently owns `general.outputStyle`, the command updates that project setting; otherwise it updates your user setting. Style names are case-insensitive.

You can also set the style without the command:

- **Settings**: `"general": { "outputStyle": "Concise" }` in `settings.json` (user or project scope). The value is a built-in or [custom](#custom-styles) style name. A hand edit takes effect on the next start.
- **One run**: `qwen -p "..." --output-style Concise` overrides the setting for that run. See [Headless Mode](./headless).

## Custom styles

A custom style is a Markdown file whose body is the style's instructions. Put it in one of two directories:

| Location                             | Scope                                                         |
| ------------------------------------ | ------------------------------------------------------------- |
| `~/.qwen/output-styles/<name>.md`    | Your styles, available in every project                       |
| `<project>/.qwen/output-styles/*.md` | The project's styles, read only when the workspace is trusted |

```markdown
---
name: Reviewer
description: Reviews code and reports findings without editing anything
keep-coding-instructions: false
---

You are reviewing, not implementing. Read the code the user points you at, list concrete findings ordered by severity, and never edit files unless the user asks for a fix.
```

The frontmatter is optional. Each field has a default:

- `name` — the style's name, used with `/output-style <name>` and in `general.outputStyle`. Defaults to the file name without `.md`. `default` is reserved.
- `description` — the one-line summary shown in the picker. Defaults to the first line of the body.
- `keep-coding-instructions` — `true` keeps the built-in software-engineering workflow guidance in the prompt alongside your style; `false` (the default) drops that one section, for a style whose work is not coding. Everything else in the built-in prompt — identity, safety rules, tool guidance — stays in force under every style.

Custom styles appear in the `/output-style` picker after the built-ins, labelled with their source, and are re-read each time the picker opens or a name is given, so a new file needs no restart. Names are matched case-insensitively and must be unique: a project style overrides a user style of the same name, and either overrides a built-in of that name. A file that cannot be loaded (empty body, invalid name, over 1 MiB) is skipped and reported in the debug log; the other files still load.

Custom styles are ignored in `--bare` and `--safe-mode`, which keep the built-ins only.

## Scope and interactions

- A style layers onto the built-in prompt. When `--system-prompt` or `QWEN_SYSTEM_MD` replaces the prompt entirely, the style (and its per-turn reminder) is not applied.
- Styles apply to the main conversation only; subagents run their own system prompts.
- `--bare` and `--safe-mode` ignore the setting and do not allow `/output-style` changes.
- Changing the style mid-session invalidates the cached prompt prefix once; after that, caching works as usual.

Styles adjust tone and workflow, not knowledge or permissions. For project conventions the model should always know, use context files (`QWEN.md`); for a one-off addition to the prompt, use `--append-system-prompt`.
